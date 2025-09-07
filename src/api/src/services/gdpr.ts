import { createClient } from '@supabase/supabase-js'
import { Redis } from 'ioredis'
import { logger } from '../utils/logger'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import AWS from 'aws-sdk'
import crypto from 'crypto'

interface GDPRRequest {
  id: string
  organizationId: string
  userId: string
  type: 'access' | 'portability' | 'rectification' | 'erasure' | 'restriction'
  status: 'pending' | 'processing' | 'completed' | 'rejected'
  requestedBy: string // email of requester
  description?: string
  dataTypes?: string[]
  responseData?: any
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

interface ConsentRecord {
  id: string
  organizationId: string
  userId?: string
  email: string
  consentType: 'marketing' | 'analytics' | 'functional' | 'necessary'
  granted: boolean
  source: 'website' | 'api' | 'admin' | 'import'
  ipAddress?: string
  userAgent?: string
  legalBasis: 'consent' | 'contract' | 'legal_obligation' | 'vital_interests' | 'public_task' | 'legitimate_interests'
  grantedAt?: Date
  revokedAt?: Date
  expiresAt?: Date
  createdAt: Date
  updatedAt: Date
}

interface DataRetentionPolicy {
  dataType: string
  retentionPeriod: number // days
  legalBasis: string
  deletionMethod: 'soft' | 'hard' | 'anonymize'
  isActive: boolean
}

interface PrivacyNotice {
  id: string
  version: string
  content: string
  effectiveDate: Date
  isActive: boolean
  language: string
}

interface GDPRConfig {
  redis: Redis
  supabaseUrl: string
  supabaseKey: string
  s3: {
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
  }
  defaultRetentionDays: number
  anonymizationKey: string
  dpoEmail: string
  companyName: string
}

export class GDPRService extends EventEmitter {
  private redis: Redis
  private supabase: any
  private s3: AWS.S3
  private config: GDPRConfig

  constructor(config: GDPRConfig) {
    super()
    
    this.config = config
    this.redis = config.redis
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)
    
    // Configure AWS S3
    this.s3 = new AWS.S3({
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey
    })
  }

  /**
   * Submit GDPR data subject request
   */
  async submitGDPRRequest(
    organizationId: string,
    userId: string,
    type: GDPRRequest['type'],
    requestedBy: string,
    options?: {
      description?: string
      dataTypes?: string[]
    }
  ): Promise<GDPRRequest> {
    const gdprRequest: GDPRRequest = {
      id: uuidv4(),
      organizationId,
      userId,
      type,
      status: 'pending',
      requestedBy,
      description: options?.description,
      dataTypes: options?.dataTypes,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // Store GDPR request
    const { error } = await this.supabase
      .from('gdpr_requests')
      .insert({
        id: gdprRequest.id,
        organization_id: organizationId,
        user_id: userId,
        type,
        status: 'pending',
        requested_by: requestedBy,
        description: options?.description,
        data_types: options?.dataTypes,
        created_at: gdprRequest.createdAt.toISOString(),
        updated_at: gdprRequest.updatedAt.toISOString()
      })

    if (error) throw error

    // Queue for processing
    await this.redis.lpush('gdpr_queue', JSON.stringify({
      requestId: gdprRequest.id,
      type,
      organizationId,
      userId
    }))

    // Send notification to DPO
    await this.notifyDPO(gdprRequest)

    this.emit('gdpr_request_submitted', gdprRequest)

    logger.info('GDPR request submitted', {
      requestId: gdprRequest.id,
      type,
      organizationId,
      userId,
      requestedBy
    })

    return gdprRequest
  }

  /**
   * Process GDPR request
   */
  async processGDPRRequest(requestId: string): Promise<void> {
    try {
      const request = await this.getGDPRRequest(requestId)
      if (!request) {
        throw new Error(`GDPR request not found: ${requestId}`)
      }

      await this.updateGDPRRequestStatus(requestId, 'processing')

      let responseData: any = {}

      switch (request.type) {
        case 'access':
          responseData = await this.processAccessRequest(request)
          break
        case 'portability':
          responseData = await this.processPortabilityRequest(request)
          break
        case 'rectification':
          responseData = await this.processRectificationRequest(request)
          break
        case 'erasure':
          responseData = await this.processErasureRequest(request)
          break
        case 'restriction':
          responseData = await this.processRestrictionRequest(request)
          break
        default:
          throw new Error(`Unknown GDPR request type: ${request.type}`)
      }

      await this.completeGDPRRequest(requestId, responseData)

      this.emit('gdpr_request_completed', {
        requestId,
        type: request.type,
        organizationId: request.organizationId,
        userId: request.userId
      })

      logger.info('GDPR request completed', {
        requestId,
        type: request.type,
        processingTime: Date.now() - request.createdAt.getTime()
      })

    } catch (error) {
      await this.updateGDPRRequestStatus(requestId, 'rejected')
      
      this.emit('gdpr_request_failed', {
        requestId,
        error: error.message
      })

      logger.error('GDPR request processing failed', {
        requestId,
        error: error.message,
        stack: error.stack
      })

      throw error
    }
  }

  /**
   * Process data access request (Article 15)
   */
  private async processAccessRequest(request: GDPRRequest): Promise<any> {
    const userData = {}

    // Get user profile data
    const { data: user } = await this.supabase
      .from('users')
      .select('*')
      .eq('id', request.userId)
      .single()

    if (user) {
      userData['profile'] = {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        createdAt: user.created_at,
        lastLogin: user.last_login
      }
    }

    // Get leads data
    const { data: leads } = await this.supabase
      .from('leads')
      .select('*')
      .eq('organization_id', request.organizationId)

    if (leads?.length > 0) {
      userData['leads'] = leads
    }

    // Get sync logs
    const { data: syncLogs } = await this.supabase
      .from('sync_logs')
      .select('*')
      .eq('organization_id', request.organizationId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (syncLogs?.length > 0) {
      userData['syncHistory'] = syncLogs
    }

    // Get consent records
    const consentRecords = await this.getConsentHistory(request.organizationId, user?.email)
    if (consentRecords.length > 0) {
      userData['consentHistory'] = consentRecords
    }

    // Get data retention info
    const retentionPolicies = await this.getDataRetentionPolicies()
    userData['dataRetention'] = retentionPolicies

    return {
      exportDate: new Date().toISOString(),
      dataSubject: user?.email,
      organization: request.organizationId,
      data: userData,
      legalBasis: 'Article 15 - Right of Access'
    }
  }

  /**
   * Process data portability request (Article 20)
   */
  private async processPortabilityRequest(request: GDPRRequest): Promise<any> {
    // Get structured, machine-readable data
    const portableData = await this.processAccessRequest(request)
    
    // Generate downloadable file
    const fileName = `data-export-${request.userId}-${Date.now()}.json`
    const s3Key = `gdpr-exports/${request.organizationId}/${fileName}`
    
    await this.s3.upload({
      Bucket: this.config.s3.bucket,
      Key: s3Key,
      Body: JSON.stringify(portableData, null, 2),
      ContentType: 'application/json',
      Metadata: {
        organizationId: request.organizationId,
        userId: request.userId,
        requestId: request.id,
        type: 'portability'
      }
    }).promise()

    // Generate signed URL for download
    const downloadUrl = await this.s3.getSignedUrlPromise('getObject', {
      Bucket: this.config.s3.bucket,
      Key: s3Key,
      Expires: 7 * 24 * 3600 // 7 days
    })

    return {
      message: 'Your data is ready for download',
      downloadUrl,
      fileName,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      format: 'JSON'
    }
  }

  /**
   * Process data rectification request (Article 16)
   */
  private async processRectificationRequest(request: GDPRRequest): Promise<any> {
    // This would typically involve manual review and updates
    // For now, we'll mark it as requiring manual intervention
    
    return {
      message: 'Rectification request received and under review',
      nextSteps: 'Our data protection team will review your request and contact you within 30 days',
      contactEmail: this.config.dpoEmail
    }
  }

  /**
   * Process data erasure request (Article 17 - Right to be forgotten)
   */
  private async processErasureRequest(request: GDPRRequest): Promise<any> {
    const deletedData: string[] = []

    try {
      // Check if erasure is legally possible
      const canErase = await this.checkErasureLegality(request.organizationId, request.userId)
      
      if (!canErase.allowed) {
        return {
          message: 'Erasure request cannot be fulfilled',
          reason: canErase.reason,
          legalBasis: canErase.legalBasis
        }
      }

      // Soft delete or anonymize user data
      await this.anonymizeUserData(request.organizationId, request.userId)
      deletedData.push('User profile data anonymized')

      // Delete associated leads (if no legal retention required)
      const { error: leadsError } = await this.supabase
        .from('leads')
        .delete()
        .eq('organization_id', request.organizationId)
        .eq('created_by', request.userId)

      if (!leadsError) {
        deletedData.push('Associated leads deleted')
      }

      // Mark sync logs for deletion (after retention period)
      await this.markForDeletion('sync_logs', request.organizationId, request.userId)
      deletedData.push('Sync logs marked for deletion after retention period')

      // Revoke all consents
      await this.revokeAllConsents(request.organizationId, request.userId)
      deletedData.push('All consent records revoked')

      return {
        message: 'Data erasure completed successfully',
        deletedData,
        note: 'Some data may be retained for legal compliance purposes',
        completedAt: new Date().toISOString()
      }

    } catch (error) {
      logger.error('Error processing erasure request', {
        requestId: request.id,
        error: error.message
      })

      return {
        message: 'Erasure request could not be completed',
        error: 'Technical error occurred during processing',
        partiallyDeleted: deletedData
      }
    }
  }

  /**
   * Process data processing restriction request (Article 18)
   */
  private async processRestrictionRequest(request: GDPRRequest): Promise<any> {
    // Mark user data for restricted processing
    await this.supabase
      .from('users')
      .update({
        processing_restricted: true,
        restriction_reason: 'GDPR Article 18 request',
        restricted_at: new Date().toISOString()
      })
      .eq('id', request.userId)

    // Log restriction in audit trail
    await this.supabase
      .from('data_processing_log')
      .insert({
        organization_id: request.organizationId,
        user_id: request.userId,
        action: 'restriction_applied',
        reason: 'GDPR Article 18 request',
        created_at: new Date().toISOString()
      })

    return {
      message: 'Data processing restriction applied successfully',
      restrictedAt: new Date().toISOString(),
      note: 'Your data will not be processed except with your consent or for specific legal purposes'
    }
  }

  /**
   * Record consent
   */
  async recordConsent(
    organizationId: string,
    email: string,
    consentType: ConsentRecord['consentType'],
    granted: boolean,
    options?: {
      userId?: string
      source?: string
      ipAddress?: string
      userAgent?: string
      legalBasis?: string
      expiresAt?: Date
    }
  ): Promise<ConsentRecord> {
    const consent: ConsentRecord = {
      id: uuidv4(),
      organizationId,
      userId: options?.userId,
      email,
      consentType,
      granted,
      source: (options?.source as any) || 'website',
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
      legalBasis: (options?.legalBasis as any) || 'consent',
      grantedAt: granted ? new Date() : undefined,
      revokedAt: !granted ? new Date() : undefined,
      expiresAt: options?.expiresAt,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const { error } = await this.supabase
      .from('consent_records')
      .insert({
        id: consent.id,
        organization_id: organizationId,
        user_id: options?.userId,
        email,
        consent_type: consentType,
        granted,
        source: consent.source,
        ip_address: options?.ipAddress,
        user_agent: options?.userAgent,
        legal_basis: consent.legalBasis,
        granted_at: consent.grantedAt?.toISOString(),
        revoked_at: consent.revokedAt?.toISOString(),
        expires_at: consent.expiresAt?.toISOString(),
        created_at: consent.createdAt.toISOString(),
        updated_at: consent.updatedAt.toISOString()
      })

    if (error) throw error

    this.emit('consent_recorded', consent)

    logger.info('Consent recorded', {
      consentId: consent.id,
      organizationId,
      email,
      consentType,
      granted
    })

    return consent
  }

  /**
   * Check consent
   */
  async checkConsent(
    organizationId: string,
    email: string,
    consentType: ConsentRecord['consentType']
  ): Promise<{ granted: boolean; consentRecord?: ConsentRecord }> {
    const { data: consent, error } = await this.supabase
      .from('consent_records')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('email', email)
      .eq('consent_type', consentType)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (error && error.code !== 'PGRST116') { // Not found is OK
      throw error
    }

    if (!consent) {
      return { granted: false }
    }

    // Check if consent has expired
    if (consent.expires_at && new Date(consent.expires_at) < new Date()) {
      return { granted: false }
    }

    const consentRecord: ConsentRecord = {
      id: consent.id,
      organizationId: consent.organization_id,
      userId: consent.user_id,
      email: consent.email,
      consentType: consent.consent_type,
      granted: consent.granted,
      source: consent.source,
      ipAddress: consent.ip_address,
      userAgent: consent.user_agent,
      legalBasis: consent.legal_basis,
      grantedAt: consent.granted_at ? new Date(consent.granted_at) : undefined,
      revokedAt: consent.revoked_at ? new Date(consent.revoked_at) : undefined,
      expiresAt: consent.expires_at ? new Date(consent.expires_at) : undefined,
      createdAt: new Date(consent.created_at),
      updatedAt: new Date(consent.updated_at)
    }

    return {
      granted: consent.granted,
      consentRecord
    }
  }

  /**
   * Get consent history for a user
   */
  async getConsentHistory(organizationId: string, email: string): Promise<ConsentRecord[]> {
    const { data: consents, error } = await this.supabase
      .from('consent_records')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('email', email)
      .order('created_at', { ascending: false })

    if (error) throw error

    return consents.map(consent => ({
      id: consent.id,
      organizationId: consent.organization_id,
      userId: consent.user_id,
      email: consent.email,
      consentType: consent.consent_type,
      granted: consent.granted,
      source: consent.source,
      ipAddress: consent.ip_address,
      userAgent: consent.user_agent,
      legalBasis: consent.legal_basis,
      grantedAt: consent.granted_at ? new Date(consent.granted_at) : undefined,
      revokedAt: consent.revoked_at ? new Date(consent.revoked_at) : undefined,
      expiresAt: consent.expires_at ? new Date(consent.expires_at) : undefined,
      createdAt: new Date(consent.created_at),
      updatedAt: new Date(consent.updated_at)
    }))
  }

  /**
   * Anonymize user data
   */
  private async anonymizeUserData(organizationId: string, userId: string): Promise<void> {
    const anonymousId = this.generateAnonymousId(userId)
    
    // Anonymize user profile
    await this.supabase
      .from('users')
      .update({
        email: `${anonymousId}@anonymized.local`,
        first_name: 'ANONYMIZED',
        last_name: 'USER',
        phone: null,
        avatar_url: null,
        is_anonymized: true,
        anonymized_at: new Date().toISOString()
      })
      .eq('id', userId)

    // Anonymize related records
    await this.supabase
      .from('leads')
      .update({
        email: `${anonymousId}@anonymized.local`,
        first_name: 'ANONYMIZED',
        last_name: 'USER',
        phone: null
      })
      .eq('organization_id', organizationId)
      .eq('created_by', userId)
  }

  /**
   * Generate anonymous ID for anonymization
   */
  private generateAnonymousId(userId: string): string {
    return crypto
      .createHmac('sha256', this.config.anonymizationKey)
      .update(userId)
      .digest('hex')
      .substring(0, 16)
  }

  /**
   * Check if data erasure is legally possible
   */
  private async checkErasureLegality(organizationId: string, userId: string): Promise<{
    allowed: boolean
    reason?: string
    legalBasis?: string
  }> {
    // Check for legal retention requirements
    const { data: retentionPolicies } = await this.supabase
      .from('data_retention_policies')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)

    // Check if user has active contracts or legal obligations
    const { data: activeContracts } = await this.supabase
      .from('user_contracts')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .eq('is_active', true)

    if (activeContracts && activeContracts.length > 0) {
      return {
        allowed: false,
        reason: 'Active contractual relationship exists',
        legalBasis: 'Contract performance (Article 6(1)(b))'
      }
    }

    // Check for ongoing legal proceedings
    const { data: legalHolds } = await this.supabase
      .from('legal_holds')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .eq('is_active', true)

    if (legalHolds && legalHolds.length > 0) {
      return {
        allowed: false,
        reason: 'Data subject to legal hold',
        legalBasis: 'Legal obligation (Article 6(1)(c))'
      }
    }

    return { allowed: true }
  }

  /**
   * Mark data for deletion after retention period
   */
  private async markForDeletion(table: string, organizationId: string, userId: string): Promise<void> {
    const retentionDate = new Date()
    retentionDate.setDate(retentionDate.getDate() + this.config.defaultRetentionDays)

    await this.supabase
      .from('data_deletion_queue')
      .insert({
        table_name: table,
        organization_id: organizationId,
        user_id: userId,
        deletion_date: retentionDate.toISOString(),
        reason: 'GDPR erasure request',
        created_at: new Date().toISOString()
      })
  }

  /**
   * Revoke all consents for a user
   */
  private async revokeAllConsents(organizationId: string, userId: string): Promise<void> {
    const { data: user } = await this.supabase
      .from('users')
      .select('email')
      .eq('id', userId)
      .single()

    if (user) {
      await this.supabase
        .from('consent_records')
        .update({
          granted: false,
          revoked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('organization_id', organizationId)
        .eq('email', user.email)
        .eq('granted', true)
    }
  }

  /**
   * Get data retention policies
   */
  async getDataRetentionPolicies(): Promise<DataRetentionPolicy[]> {
    const { data: policies, error } = await this.supabase
      .from('data_retention_policies')
      .select('*')
      .eq('is_active', true)

    if (error) throw error

    return policies.map(policy => ({
      dataType: policy.data_type,
      retentionPeriod: policy.retention_period,
      legalBasis: policy.legal_basis,
      deletionMethod: policy.deletion_method,
      isActive: policy.is_active
    }))
  }

  /**
   * Get GDPR request
   */
  private async getGDPRRequest(requestId: string): Promise<GDPRRequest | null> {
    const { data: request, error } = await this.supabase
      .from('gdpr_requests')
      .select('*')
      .eq('id', requestId)
      .single()

    if (error) return null

    return {
      id: request.id,
      organizationId: request.organization_id,
      userId: request.user_id,
      type: request.type,
      status: request.status,
      requestedBy: request.requested_by,
      description: request.description,
      dataTypes: request.data_types,
      responseData: request.response_data,
      completedAt: request.completed_at ? new Date(request.completed_at) : undefined,
      createdAt: new Date(request.created_at),
      updatedAt: new Date(request.updated_at)
    }
  }

  /**
   * Update GDPR request status
   */
  private async updateGDPRRequestStatus(requestId: string, status: GDPRRequest['status']): Promise<void> {
    const { error } = await this.supabase
      .from('gdpr_requests')
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId)

    if (error) throw error
  }

  /**
   * Complete GDPR request
   */
  private async completeGDPRRequest(requestId: string, responseData: any): Promise<void> {
    const { error } = await this.supabase
      .from('gdpr_requests')
      .update({
        status: 'completed',
        response_data: responseData,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId)

    if (error) throw error
  }

  /**
   * Notify DPO of new GDPR request
   */
  private async notifyDPO(request: GDPRRequest): Promise<void> {
    // This would integrate with your email service
    logger.info('DPO notification sent', {
      requestId: request.id,
      type: request.type,
      dpoEmail: this.config.dpoEmail
    })
  }

  /**
   * Process data deletion queue
   */
  async processDeletionQueue(): Promise<void> {
    const { data: deletionItems, error } = await this.supabase
      .from('data_deletion_queue')
      .select('*')
      .lte('deletion_date', new Date().toISOString())
      .eq('processed', false)
      .limit(100)

    if (error) throw error

    for (const item of deletionItems) {
      try {
        // Perform actual deletion based on table and deletion method
        await this.performDeletion(item)
        
        // Mark as processed
        await this.supabase
          .from('data_deletion_queue')
          .update({ processed: true, processed_at: new Date().toISOString() })
          .eq('id', item.id)

        logger.info('Data deletion completed', {
          table: item.table_name,
          organizationId: item.organization_id,
          userId: item.user_id
        })

      } catch (error) {
        logger.error('Data deletion failed', {
          deletionItemId: item.id,
          error: error.message
        })
      }
    }
  }

  /**
   * Perform actual data deletion
   */
  private async performDeletion(deletionItem: any): Promise<void> {
    // Implement specific deletion logic based on table and method
    switch (deletionItem.deletion_method) {
      case 'hard':
        await this.supabase
          .from(deletionItem.table_name)
          .delete()
          .eq('organization_id', deletionItem.organization_id)
          .eq('user_id', deletionItem.user_id)
        break
        
      case 'soft':
        await this.supabase
          .from(deletionItem.table_name)
          .update({ deleted_at: new Date().toISOString() })
          .eq('organization_id', deletionItem.organization_id)
          .eq('user_id', deletionItem.user_id)
        break
        
      case 'anonymize':
        // Implement anonymization logic
        break
    }
  }
}