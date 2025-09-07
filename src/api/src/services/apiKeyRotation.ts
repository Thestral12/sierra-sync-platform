import { EventEmitter } from 'events'
import crypto from 'crypto'
import { logger } from '../utils/logger'
import { monitoringService } from '../utils/monitoring'
import { redis } from '../config/redis'
import { supabase } from '../config/supabase'

interface ApiKey {
  id: string
  organizationId: string
  keyPrefix: string
  keyHash: string
  name: string
  scopes: string[]
  expiresAt?: Date
  createdAt: Date
  lastUsedAt?: Date
  isActive: boolean
  rotationSchedule?: 'never' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  rotationNotified: boolean
}

interface KeyRotationEvent {
  organizationId: string
  oldKeyId: string
  newKeyId: string
  rotationType: 'manual' | 'scheduled' | 'emergency'
  reason: string
  timestamp: Date
}

export class ApiKeyRotationService extends EventEmitter {
  private readonly keyPrefix = 'sk_'
  private readonly rotationBufferDays = 7 // Days before expiration to start rotation
  
  constructor() {
    super()
    
    // Schedule automatic rotation check every hour
    setInterval(() => {
      this.checkScheduledRotations().catch(error => {
        logger.error('Scheduled rotation check failed', { error })
        monitoringService.captureException(error, {
          context: 'api_key_rotation',
          operation: 'scheduled_check'
        })
      })
    }, 60 * 60 * 1000) // 1 hour
  }

  /**
   * Generate a new API key
   */
  async generateApiKey(
    organizationId: string,
    name: string,
    scopes: string[] = ['read', 'write'],
    expiresInDays?: number
  ): Promise<{ keyId: string; key: string; keyHash: string }> {
    try {
      const keyId = crypto.randomUUID()
      const keySecret = crypto.randomBytes(32).toString('hex')
      const fullKey = `${this.keyPrefix}${keySecret}`
      const keyHash = this.hashKey(fullKey)
      
      const expiresAt = expiresInDays 
        ? new Date(Date.now() + (expiresInDays * 24 * 60 * 60 * 1000))
        : null

      // Store in database
      const { error } = await supabase
        .from('api_keys')
        .insert({
          id: keyId,
          organization_id: organizationId,
          key_prefix: this.keyPrefix,
          key_hash: keyHash,
          name,
          scopes,
          expires_at: expiresAt,
          is_active: true,
          rotation_notified: false
        })

      if (error) throw error

      // Cache key metadata in Redis for faster lookups
      await this.cacheKeyMetadata(keyId, {
        organizationId,
        scopes,
        expiresAt,
        isActive: true
      })

      logger.info('API key generated', {
        organizationId,
        keyId,
        name,
        scopes,
        expiresAt
      })

      monitoringService.addBreadcrumb({
        message: 'API key generated',
        data: { organizationId, keyId, name }
      })

      return { keyId, key: fullKey, keyHash }

    } catch (error) {
      logger.error('Failed to generate API key', {
        organizationId,
        name,
        error
      })
      
      monitoringService.captureException(error, {
        context: 'api_key_generation',
        extra: { organizationId, name }
      })
      
      throw error
    }
  }

  /**
   * Rotate an existing API key
   */
  async rotateApiKey(
    keyId: string,
    rotationType: 'manual' | 'scheduled' | 'emergency' = 'manual',
    reason: string = 'Manual rotation',
    gracePeriodDays: number = 7
  ): Promise<{ newKeyId: string; newKey: string; oldKeyId: string }> {
    try {
      // Get existing key
      const { data: existingKey, error: fetchError } = await supabase
        .from('api_keys')
        .select('*')
        .eq('id', keyId)
        .eq('is_active', true)
        .single()

      if (fetchError || !existingKey) {
        throw new Error(`API key not found: ${keyId}`)
      }

      // Generate new key
      const { keyId: newKeyId, key: newKey } = await this.generateApiKey(
        existingKey.organization_id,
        `${existingKey.name} (rotated)`,
        existingKey.scopes,
        existingKey.expires_at ? undefined : 365 // 1 year if no expiration
      )

      // Set old key to expire after grace period
      const graceExpiresAt = new Date(Date.now() + (gracePeriodDays * 24 * 60 * 60 * 1000))
      
      await supabase
        .from('api_keys')
        .update({
          expires_at: graceExpiresAt,
          rotation_notified: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', keyId)

      // Log rotation event
      await this.logRotationEvent({
        organizationId: existingKey.organization_id,
        oldKeyId: keyId,
        newKeyId,
        rotationType,
        reason,
        timestamp: new Date()
      })

      // Update cache
      await this.invalidateKeyCache(keyId)
      await redis.setex(
        `api_key_rotation:${keyId}`,
        gracePeriodDays * 24 * 60 * 60, // Expire after grace period
        JSON.stringify({
          newKeyId,
          rotatedAt: new Date(),
          expiresAt: graceExpiresAt
        })
      )

      // Emit rotation event
      this.emit('keyRotated', {
        organizationId: existingKey.organization_id,
        oldKeyId: keyId,
        newKeyId,
        rotationType,
        gracePeriodDays
      })

      logger.info('API key rotated', {
        organizationId: existingKey.organization_id,
        oldKeyId: keyId,
        newKeyId,
        rotationType,
        reason,
        gracePeriodDays
      })

      return { newKeyId, newKey, oldKeyId: keyId }

    } catch (error) {
      logger.error('Failed to rotate API key', { keyId, error })
      
      monitoringService.captureException(error, {
        context: 'api_key_rotation',
        extra: { keyId, rotationType, reason }
      })
      
      throw error
    }
  }

  /**
   * Emergency key rotation (immediate deactivation)
   */
  async emergencyRotateApiKey(
    keyId: string,
    reason: string = 'Emergency rotation - security incident'
  ): Promise<{ newKeyId: string; newKey: string }> {
    try {
      // Immediately deactivate the old key
      await supabase
        .from('api_keys')
        .update({
          is_active: false,
          deactivated_at: new Date().toISOString(),
          deactivation_reason: reason
        })
        .eq('id', keyId)

      // Generate replacement key
      const { data: existingKey } = await supabase
        .from('api_keys')
        .select('organization_id, name, scopes')
        .eq('id', keyId)
        .single()

      if (!existingKey) {
        throw new Error(`API key not found: ${keyId}`)
      }

      const { keyId: newKeyId, key: newKey } = await this.generateApiKey(
        existingKey.organization_id,
        `${existingKey.name} (emergency rotation)`,
        existingKey.scopes
      )

      // Clear cache immediately
      await this.invalidateKeyCache(keyId)

      // Log emergency rotation
      await this.logRotationEvent({
        organizationId: existingKey.organization_id,
        oldKeyId: keyId,
        newKeyId,
        rotationType: 'emergency',
        reason,
        timestamp: new Date()
      })

      // Emit emergency event
      this.emit('emergencyRotation', {
        organizationId: existingKey.organization_id,
        oldKeyId: keyId,
        newKeyId,
        reason
      })

      logger.warn('Emergency API key rotation performed', {
        organizationId: existingKey.organization_id,
        oldKeyId: keyId,
        newKeyId,
        reason
      })

      return { newKeyId, newKey }

    } catch (error) {
      logger.error('Emergency API key rotation failed', { keyId, error })
      
      monitoringService.captureException(error, {
        context: 'emergency_key_rotation',
        extra: { keyId, reason }
      })
      
      throw error
    }
  }

  /**
   * Set rotation schedule for a key
   */
  async setRotationSchedule(
    keyId: string,
    schedule: 'never' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  ): Promise<void> {
    try {
      await supabase
        .from('api_keys')
        .update({
          rotation_schedule: schedule,
          updated_at: new Date().toISOString()
        })
        .eq('id', keyId)

      await this.invalidateKeyCache(keyId)

      logger.info('API key rotation schedule updated', {
        keyId,
        schedule
      })

    } catch (error) {
      logger.error('Failed to update rotation schedule', { keyId, schedule, error })
      throw error
    }
  }

  /**
   * Check for keys that need scheduled rotation
   */
  private async checkScheduledRotations(): Promise<void> {
    try {
      const now = new Date()
      const checkDate = new Date(now.getTime() + (this.rotationBufferDays * 24 * 60 * 60 * 1000))

      // Find keys that need rotation based on schedule
      const { data: keysToRotate, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('is_active', true)
        .neq('rotation_schedule', 'never')
        .or(`expires_at.lt.${checkDate.toISOString()},rotation_notified.eq.false`)

      if (error) throw error

      if (!keysToRotate?.length) return

      for (const key of keysToRotate) {
        if (this.shouldRotateKey(key, now)) {
          try {
            await this.rotateApiKey(
              key.id,
              'scheduled',
              `Scheduled rotation: ${key.rotation_schedule}`,
              this.rotationBufferDays
            )
          } catch (rotationError) {
            logger.error('Scheduled rotation failed', {
              keyId: key.id,
              error: rotationError
            })
          }
        } else if (this.shouldNotifyRotation(key, now)) {
          await this.sendRotationNotification(key)
        }
      }

    } catch (error) {
      logger.error('Scheduled rotation check failed', { error })
      throw error
    }
  }

  /**
   * Send rotation notification to organization
   */
  private async sendRotationNotification(key: ApiKey): Promise<void> {
    try {
      // Mark as notified
      await supabase
        .from('api_keys')
        .update({ rotation_notified: true })
        .eq('id', key.id)

      // Emit notification event
      this.emit('rotationNotification', {
        organizationId: key.organizationId,
        keyId: key.id,
        keyName: key.name,
        expiresAt: key.expiresAt,
        rotationSchedule: key.rotationSchedule
      })

      logger.info('Rotation notification sent', {
        organizationId: key.organizationId,
        keyId: key.id
      })

    } catch (error) {
      logger.error('Failed to send rotation notification', {
        keyId: key.id,
        error
      })
    }
  }

  /**
   * Determine if a key should be rotated
   */
  private shouldRotateKey(key: any, now: Date): boolean {
    if (!key.rotation_schedule || key.rotation_schedule === 'never') {
      return false
    }

    const createdAt = new Date(key.created_at)
    const daysSinceCreation = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)

    switch (key.rotation_schedule) {
      case 'weekly':
        return daysSinceCreation >= 7
      case 'monthly':
        return daysSinceCreation >= 30
      case 'quarterly':
        return daysSinceCreation >= 90
      case 'yearly':
        return daysSinceCreation >= 365
      default:
        return false
    }
  }

  /**
   * Determine if rotation notification should be sent
   */
  private shouldNotifyRotation(key: any, now: Date): boolean {
    if (key.rotation_notified || !key.expires_at) return false

    const expiresAt = new Date(key.expires_at)
    const daysUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)

    return daysUntilExpiry <= this.rotationBufferDays
  }

  /**
   * Log rotation event
   */
  private async logRotationEvent(event: KeyRotationEvent): Promise<void> {
    try {
      await supabase
        .from('api_key_rotation_events')
        .insert({
          organization_id: event.organizationId,
          old_key_id: event.oldKeyId,
          new_key_id: event.newKeyId,
          rotation_type: event.rotationType,
          reason: event.reason,
          created_at: event.timestamp.toISOString()
        })

    } catch (error) {
      logger.error('Failed to log rotation event', { event, error })
    }
  }

  /**
   * Hash API key for secure storage
   */
  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex')
  }

  /**
   * Cache key metadata for faster lookups
   */
  private async cacheKeyMetadata(keyId: string, metadata: any): Promise<void> {
    const cacheKey = `api_key_meta:${keyId}`
    await redis.setex(cacheKey, 3600, JSON.stringify(metadata)) // 1 hour cache
  }

  /**
   * Invalidate cached key metadata
   */
  private async invalidateKeyCache(keyId: string): Promise<void> {
    await redis.del(`api_key_meta:${keyId}`)
  }

  /**
   * Get API key usage statistics
   */
  async getKeyUsageStats(keyId: string): Promise<any> {
    try {
      const { data: usage, error } = await supabase
        .from('api_key_usage_logs')
        .select('*')
        .eq('key_id', keyId)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) // Last 30 days
        .order('created_at', { ascending: false })

      if (error) throw error

      return {
        totalRequests: usage?.length || 0,
        lastUsed: usage?.[0]?.created_at,
        endpoints: [...new Set(usage?.map(u => u.endpoint))],
        dailyUsage: this.aggregateDailyUsage(usage || [])
      }

    } catch (error) {
      logger.error('Failed to get key usage stats', { keyId, error })
      throw error
    }
  }

  /**
   * Aggregate usage by day
   */
  private aggregateDailyUsage(usage: any[]): Record<string, number> {
    const dailyUsage: Record<string, number> = {}
    
    usage.forEach(log => {
      const date = new Date(log.created_at).toISOString().split('T')[0]
      dailyUsage[date] = (dailyUsage[date] || 0) + 1
    })

    return dailyUsage
  }

  /**
   * Revoke API key immediately
   */
  async revokeApiKey(keyId: string, reason: string = 'Manual revocation'): Promise<void> {
    try {
      await supabase
        .from('api_keys')
        .update({
          is_active: false,
          deactivated_at: new Date().toISOString(),
          deactivation_reason: reason
        })
        .eq('id', keyId)

      await this.invalidateKeyCache(keyId)

      logger.info('API key revoked', { keyId, reason })

    } catch (error) {
      logger.error('Failed to revoke API key', { keyId, error })
      throw error
    }
  }

  /**
   * List organization's API keys
   */
  async listApiKeys(organizationId: string): Promise<any[]> {
    try {
      const { data: keys, error } = await supabase
        .from('api_keys')
        .select(`
          id,
          name,
          key_prefix,
          scopes,
          created_at,
          expires_at,
          last_used_at,
          is_active,
          rotation_schedule
        `)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })

      if (error) throw error

      return keys || []

    } catch (error) {
      logger.error('Failed to list API keys', { organizationId, error })
      throw error
    }
  }
}

export const apiKeyRotationService = new ApiKeyRotationService()