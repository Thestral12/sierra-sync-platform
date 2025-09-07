import crypto from 'crypto'
import { logger } from '../utils/logger'
import { monitoringService } from '../utils/monitoring'
import { secretManagerService } from './secretManager'
import { redis } from '../config/redis'

interface EncryptedField {
  encryptedValue: string
  keyId: string
  algorithm: string
  iv: string
  authTag?: string
  metadata?: Record<string, any>
}

interface EncryptionKey {
  id: string
  key: Buffer
  algorithm: string
  createdAt: Date
  expiresAt?: Date
  purpose: 'pii' | 'financial' | 'general' | 'master'
}

interface FieldEncryptionConfig {
  algorithm: 'aes-256-gcm' | 'aes-256-cbc' | 'chacha20-poly1305'
  keyDerivation: 'pbkdf2' | 'scrypt' | 'argon2'
  keyRotationDays: number
  compressionEnabled: boolean
  auditEnabled: boolean
}

export class FieldEncryptionService {
  private encryptionKeys: Map<string, EncryptionKey> = new Map()
  private readonly config: FieldEncryptionConfig
  private readonly cachePrefix = 'field_enc:'
  private readonly cacheTTL = 300 // 5 minutes

  constructor(config?: Partial<FieldEncryptionConfig>) {
    this.config = {
      algorithm: 'aes-256-gcm',
      keyDerivation: 'scrypt',
      keyRotationDays: 90,
      compressionEnabled: true,
      auditEnabled: true,
      ...config
    }

    // Initialize encryption keys
    this.initializeKeys().catch(error => {
      logger.error('Failed to initialize encryption keys', { error })
      monitoringService.captureException(error, {
        context: 'field_encryption_init'
      })
    })
  }

  /**
   * Initialize encryption keys from secret manager
   */
  private async initializeKeys(): Promise<void> {
    try {
      const environment = process.env.NODE_ENV || 'development'
      const secretName = `sierra-sync/${environment}/field-encryption`

      const encryptionSecrets = await secretManagerService.getSecret(secretName) as any

      // Load master key
      if (encryptionSecrets.master_key) {
        const masterKey = this.deriveKey(encryptionSecrets.master_key, 'master')
        this.encryptionKeys.set('master', {
          id: 'master',
          key: masterKey,
          algorithm: this.config.algorithm,
          createdAt: new Date(),
          purpose: 'master'
        })
      }

      // Load PII encryption key
      if (encryptionSecrets.pii_encryption_key) {
        const piiKey = this.deriveKey(encryptionSecrets.pii_encryption_key, 'pii')
        this.encryptionKeys.set('pii', {
          id: 'pii',
          key: piiKey,
          algorithm: this.config.algorithm,
          createdAt: new Date(),
          purpose: 'pii'
        })
      }

      // Load financial encryption key
      if (encryptionSecrets.financial_encryption_key) {
        const financialKey = this.deriveKey(encryptionSecrets.financial_encryption_key, 'financial')
        this.encryptionKeys.set('financial', {
          id: 'financial',
          key: financialKey,
          algorithm: this.config.algorithm,
          createdAt: new Date(),
          purpose: 'financial'
        })
      }

      logger.info('Field encryption keys initialized', {
        keyCount: this.encryptionKeys.size,
        purposes: Array.from(this.encryptionKeys.values()).map(k => k.purpose)
      })

    } catch (error) {
      logger.error('Failed to initialize encryption keys', { error })
      throw error
    }
  }

  /**
   * Derive encryption key from secret using key derivation function
   */
  private deriveKey(secret: string, salt: string, keyLength: number = 32): Buffer {
    switch (this.config.keyDerivation) {
      case 'scrypt':
        return crypto.scryptSync(secret, salt, keyLength)
      case 'pbkdf2':
        return crypto.pbkdf2Sync(secret, salt, 100000, keyLength, 'sha512')
      case 'argon2':
        // Note: argon2 requires additional package
        // For now, fallback to scrypt
        return crypto.scryptSync(secret, salt, keyLength)
      default:
        return crypto.scryptSync(secret, salt, keyLength)
    }
  }

  /**
   * Encrypt a field value
   */
  async encryptField(
    value: string,
    purpose: 'pii' | 'financial' | 'general' = 'general',
    metadata?: Record<string, any>
  ): Promise<EncryptedField> {
    try {
      if (!value || value.length === 0) {
        throw new Error('Cannot encrypt empty value')
      }

      // Get appropriate encryption key
      const keyId = purpose === 'general' ? 'master' : purpose
      const encryptionKey = this.encryptionKeys.get(keyId)

      if (!encryptionKey) {
        throw new Error(`Encryption key not found for purpose: ${purpose}`)
      }

      // Compress if enabled and value is large enough
      let processedValue = value
      if (this.config.compressionEnabled && value.length > 100) {
        processedValue = this.compressValue(value)
      }

      // Encrypt the value
      const result = this.performEncryption(processedValue, encryptionKey)

      // Audit if enabled
      if (this.config.auditEnabled) {
        await this.auditFieldOperation('encrypt', purpose, {
          keyId,
          valueLength: value.length,
          compressed: processedValue !== value,
          metadata
        })
      }

      logger.debug('Field encrypted successfully', {
        purpose,
        keyId,
        valueLength: value.length,
        compressed: processedValue !== value
      })

      return {
        ...result,
        metadata: {
          ...metadata,
          compressed: processedValue !== value,
          encryptedAt: new Date().toISOString(),
          purpose
        }
      }

    } catch (error) {
      logger.error('Field encryption failed', {
        purpose,
        valueLength: value?.length,
        error
      })

      monitoringService.captureException(error, {
        context: 'field_encryption',
        extra: { purpose, valueLength: value?.length }
      })

      throw error
    }
  }

  /**
   * Decrypt a field value
   */
  async decryptField(encryptedField: EncryptedField): Promise<string> {
    try {
      const { encryptedValue, keyId, algorithm, iv, authTag, metadata } = encryptedField

      // Get decryption key
      const encryptionKey = this.encryptionKeys.get(keyId)
      if (!encryptionKey) {
        throw new Error(`Decryption key not found: ${keyId}`)
      }

      // Decrypt the value
      const decryptedValue = this.performDecryption({
        encryptedValue,
        keyId,
        algorithm,
        iv,
        authTag
      }, encryptionKey)

      // Decompress if needed
      let finalValue = decryptedValue
      if (metadata?.compressed) {
        finalValue = this.decompressValue(decryptedValue)
      }

      // Audit if enabled
      if (this.config.auditEnabled) {
        await this.auditFieldOperation('decrypt', metadata?.purpose || 'unknown', {
          keyId,
          valueLength: finalValue.length,
          compressed: metadata?.compressed
        })
      }

      logger.debug('Field decrypted successfully', {
        keyId,
        valueLength: finalValue.length,
        compressed: metadata?.compressed
      })

      return finalValue

    } catch (error) {
      logger.error('Field decryption failed', {
        keyId: encryptedField.keyId,
        error
      })

      monitoringService.captureException(error, {
        context: 'field_decryption',
        extra: { keyId: encryptedField.keyId }
      })

      throw error
    }
  }

  /**
   * Perform the actual encryption
   */
  private performEncryption(
    value: string,
    encryptionKey: EncryptionKey
  ): Omit<EncryptedField, 'metadata'> {
    const iv = crypto.randomBytes(16)
    
    switch (encryptionKey.algorithm) {
      case 'aes-256-gcm': {
        const cipher = crypto.createCipher('aes-256-gcm', encryptionKey.key)
        cipher.setAAD(Buffer.from(encryptionKey.id))
        
        let encrypted = cipher.update(value, 'utf8', 'base64')
        encrypted += cipher.final('base64')
        
        const authTag = cipher.getAuthTag()
        
        return {
          encryptedValue: encrypted,
          keyId: encryptionKey.id,
          algorithm: encryptionKey.algorithm,
          iv: iv.toString('base64'),
          authTag: authTag.toString('base64')
        }
      }
      
      case 'aes-256-cbc': {
        const cipher = crypto.createCipher('aes-256-cbc', encryptionKey.key)
        
        let encrypted = cipher.update(value, 'utf8', 'base64')
        encrypted += cipher.final('base64')
        
        return {
          encryptedValue: encrypted,
          keyId: encryptionKey.id,
          algorithm: encryptionKey.algorithm,
          iv: iv.toString('base64')
        }
      }
      
      case 'chacha20-poly1305': {
        const cipher = crypto.createCipher('chacha20-poly1305', encryptionKey.key)
        
        let encrypted = cipher.update(value, 'utf8', 'base64')
        encrypted += cipher.final('base64')
        
        const authTag = cipher.getAuthTag()
        
        return {
          encryptedValue: encrypted,
          keyId: encryptionKey.id,
          algorithm: encryptionKey.algorithm,
          iv: iv.toString('base64'),
          authTag: authTag.toString('base64')
        }
      }
      
      default:
        throw new Error(`Unsupported encryption algorithm: ${encryptionKey.algorithm}`)
    }
  }

  /**
   * Perform the actual decryption
   */
  private performDecryption(
    encryptedField: Omit<EncryptedField, 'metadata'>,
    encryptionKey: EncryptionKey
  ): string {
    const { encryptedValue, algorithm, iv, authTag } = encryptedField
    
    switch (algorithm) {
      case 'aes-256-gcm': {
        const decipher = crypto.createDecipher('aes-256-gcm', encryptionKey.key)
        decipher.setAAD(Buffer.from(encryptionKey.id))
        
        if (authTag) {
          decipher.setAuthTag(Buffer.from(authTag, 'base64'))
        }
        
        let decrypted = decipher.update(encryptedValue, 'base64', 'utf8')
        decrypted += decipher.final('utf8')
        
        return decrypted
      }
      
      case 'aes-256-cbc': {
        const decipher = crypto.createDecipher('aes-256-cbc', encryptionKey.key)
        
        let decrypted = decipher.update(encryptedValue, 'base64', 'utf8')
        decrypted += decipher.final('utf8')
        
        return decrypted
      }
      
      case 'chacha20-poly1305': {
        const decipher = crypto.createDecipher('chacha20-poly1305', encryptionKey.key)
        
        if (authTag) {
          decipher.setAuthTag(Buffer.from(authTag, 'base64'))
        }
        
        let decrypted = decipher.update(encryptedValue, 'base64', 'utf8')
        decrypted += decipher.final('utf8')
        
        return decrypted
      }
      
      default:
        throw new Error(`Unsupported decryption algorithm: ${algorithm}`)
    }
  }

  /**
   * Compress value using gzip
   */
  private compressValue(value: string): string {
    const compressed = crypto.deflateSync(Buffer.from(value, 'utf8'))
    return compressed.toString('base64')
  }

  /**
   * Decompress value using gzip
   */
  private decompressValue(compressedValue: string): string {
    const compressed = Buffer.from(compressedValue, 'base64')
    const decompressed = crypto.inflateSync(compressed)
    return decompressed.toString('utf8')
  }

  /**
   * Bulk encrypt multiple fields
   */
  async encryptFields(
    fields: Record<string, { value: string; purpose?: 'pii' | 'financial' | 'general' }>,
    metadata?: Record<string, any>
  ): Promise<Record<string, EncryptedField>> {
    const results: Record<string, EncryptedField> = {}

    for (const [fieldName, fieldData] of Object.entries(fields)) {
      try {
        results[fieldName] = await this.encryptField(
          fieldData.value,
          fieldData.purpose || 'general',
          { ...metadata, fieldName }
        )
      } catch (error) {
        logger.error(`Failed to encrypt field: ${fieldName}`, { error })
        throw new Error(`Bulk encryption failed at field: ${fieldName}`)
      }
    }

    return results
  }

  /**
   * Bulk decrypt multiple fields
   */
  async decryptFields(
    encryptedFields: Record<string, EncryptedField>
  ): Promise<Record<string, string>> {
    const results: Record<string, string> = {}

    for (const [fieldName, encryptedField] of Object.entries(encryptedFields)) {
      try {
        results[fieldName] = await this.decryptField(encryptedField)
      } catch (error) {
        logger.error(`Failed to decrypt field: ${fieldName}`, { error })
        throw new Error(`Bulk decryption failed at field: ${fieldName}`)
      }
    }

    return results
  }

  /**
   * Rotate encryption key
   */
  async rotateKey(purpose: 'pii' | 'financial' | 'master'): Promise<void> {
    try {
      logger.info(`Starting key rotation for purpose: ${purpose}`)

      // Generate new key
      const newSecret = crypto.randomBytes(64).toString('base64')
      const newKey = this.deriveKey(newSecret, purpose)

      // Store new key in secret manager
      const environment = process.env.NODE_ENV || 'development'
      const secretName = `sierra-sync/${environment}/field-encryption`
      
      const currentSecrets = await secretManagerService.getSecret(secretName) as any
      const updatedSecrets = {
        ...currentSecrets,
        [`${purpose}_encryption_key`]: newSecret
      }

      await secretManagerService.rotateSecret(secretName, updatedSecrets)

      // Update local key cache
      const oldKey = this.encryptionKeys.get(purpose)
      this.encryptionKeys.set(purpose, {
        id: purpose,
        key: newKey,
        algorithm: this.config.algorithm,
        createdAt: new Date(),
        purpose: purpose as any
      })

      // Audit key rotation
      if (this.config.auditEnabled) {
        await this.auditFieldOperation('key_rotation', purpose, {
          oldKeyCreatedAt: oldKey?.createdAt,
          newKeyCreatedAt: new Date()
        })
      }

      logger.info(`Key rotation completed for purpose: ${purpose}`)

      monitoringService.addBreadcrumb({
        message: 'Encryption key rotated',
        data: { purpose }
      })

    } catch (error) {
      logger.error(`Key rotation failed for purpose: ${purpose}`, { error })
      
      monitoringService.captureException(error, {
        context: 'field_encryption_key_rotation',
        extra: { purpose }
      })

      throw error
    }
  }

  /**
   * Re-encrypt field with new key (for key rotation)
   */
  async reencryptField(
    encryptedField: EncryptedField,
    newPurpose?: 'pii' | 'financial' | 'general'
  ): Promise<EncryptedField> {
    try {
      // Decrypt with old key
      const decryptedValue = await this.decryptField(encryptedField)
      
      // Encrypt with new key
      const purpose = newPurpose || encryptedField.metadata?.purpose || 'general'
      return await this.encryptField(decryptedValue, purpose, {
        ...encryptedField.metadata,
        reencrypted: true,
        originalKeyId: encryptedField.keyId
      })

    } catch (error) {
      logger.error('Field re-encryption failed', {
        originalKeyId: encryptedField.keyId,
        error
      })

      throw error
    }
  }

  /**
   * Search encrypted fields (requires decryption for comparison)
   * Note: This is not performant for large datasets
   */
  async searchEncryptedFields(
    encryptedFields: EncryptedField[],
    searchTerm: string,
    caseSensitive: boolean = false
  ): Promise<{ index: number; field: EncryptedField; decryptedValue: string }[]> {
    const results: { index: number; field: EncryptedField; decryptedValue: string }[] = []

    for (let i = 0; i < encryptedFields.length; i++) {
      try {
        const decryptedValue = await this.decryptField(encryptedFields[i])
        
        const valueToSearch = caseSensitive ? decryptedValue : decryptedValue.toLowerCase()
        const termToSearch = caseSensitive ? searchTerm : searchTerm.toLowerCase()
        
        if (valueToSearch.includes(termToSearch)) {
          results.push({
            index: i,
            field: encryptedFields[i],
            decryptedValue
          })
        }
      } catch (error) {
        logger.warn(`Failed to decrypt field for search at index ${i}`, { error })
        continue
      }
    }

    return results
  }

  /**
   * Audit field encryption operations
   */
  private async auditFieldOperation(
    operation: 'encrypt' | 'decrypt' | 'key_rotation',
    purpose: string,
    details: Record<string, any>
  ): Promise<void> {
    try {
      const auditEntry = {
        operation,
        purpose,
        details,
        timestamp: new Date().toISOString(),
        nodeId: process.env.NODE_ID || 'unknown'
      }

      // Store in Redis for short-term access
      const auditKey = `${this.cachePrefix}audit:${Date.now()}`
      await redis.setex(auditKey, 86400, JSON.stringify(auditEntry)) // 24 hours

      // In production, you might also want to store in a database or logging service

    } catch (error) {
      logger.warn('Failed to audit field operation', { operation, error })
    }
  }

  /**
   * Get encryption statistics
   */
  async getEncryptionStats(): Promise<{
    availableKeys: Array<{ id: string; purpose: string; createdAt: Date }>
    auditEntryCount: number
    configuration: FieldEncryptionConfig
  }> {
    const availableKeys = Array.from(this.encryptionKeys.values()).map(key => ({
      id: key.id,
      purpose: key.purpose,
      createdAt: key.createdAt
    }))

    // Count audit entries
    const auditKeys = await redis.keys(`${this.cachePrefix}audit:*`)
    
    return {
      availableKeys,
      auditEntryCount: auditKeys.length,
      configuration: this.config
    }
  }

  /**
   * Health check for field encryption service
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    keysLoaded: number
    lastKeyRotation?: Date
    issues?: string[]
  }> {
    const issues: string[] = []

    // Check if keys are loaded
    if (this.encryptionKeys.size === 0) {
      issues.push('No encryption keys loaded')
    }

    // Check if master key exists
    if (!this.encryptionKeys.has('master')) {
      issues.push('Master encryption key not found')
    }

    // Test encryption/decryption
    try {
      const testValue = 'encryption_health_check'
      const encrypted = await this.encryptField(testValue, 'general')
      const decrypted = await this.decryptField(encrypted)
      
      if (decrypted !== testValue) {
        issues.push('Encryption/decryption test failed')
      }
    } catch (error) {
      issues.push(`Encryption test error: ${error.message}`)
    }

    const status = issues.length === 0 ? 'healthy' : 
                   issues.length < 2 ? 'degraded' : 'unhealthy'

    return {
      status,
      keysLoaded: this.encryptionKeys.size,
      issues: issues.length > 0 ? issues : undefined
    }
  }
}

export const fieldEncryptionService = new FieldEncryptionService()