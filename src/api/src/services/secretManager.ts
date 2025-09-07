import AWS from 'aws-sdk'
import axios from 'axios'
import crypto from 'crypto'
import { logger } from '../utils/logger'
import { monitoringService } from '../utils/monitoring'
import { redis } from '../config/redis'

interface SecretMetadata {
  name: string
  version?: string
  description?: string
  tags?: Record<string, string>
  rotationEnabled?: boolean
  rotationSchedule?: string
}

interface VaultConfig {
  url: string
  token: string
  namespace?: string
  enginePath?: string
}

interface AWSSecretsConfig {
  region: string
  accessKeyId?: string
  secretAccessKey?: string
}

export class SecretManagerService {
  private awsSecretsManager?: AWS.SecretsManager
  private vaultConfig?: VaultConfig
  private cachePrefix = 'secret:cache:'
  private cacheTTL = 300 // 5 minutes

  constructor() {
    this.initializeProviders()
  }

  /**
   * Initialize secret management providers
   */
  private initializeProviders(): void {
    try {
      // Initialize AWS Secrets Manager
      if (process.env.AWS_REGION) {
        const awsConfig: AWS.SecretsManager.ClientConfiguration = {
          region: process.env.AWS_REGION
        }

        if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
          awsConfig.credentials = {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
          }
        }

        this.awsSecretsManager = new AWS.SecretsManager(awsConfig)
      }

      // Initialize HashiCorp Vault
      if (process.env.VAULT_URL && process.env.VAULT_TOKEN) {
        this.vaultConfig = {
          url: process.env.VAULT_URL,
          token: process.env.VAULT_TOKEN,
          namespace: process.env.VAULT_NAMESPACE,
          enginePath: process.env.VAULT_ENGINE_PATH || 'secret'
        }
      }

      logger.info('Secret management providers initialized', {
        aws: !!this.awsSecretsManager,
        vault: !!this.vaultConfig
      })

    } catch (error) {
      logger.error('Failed to initialize secret providers', { error })
      monitoringService.captureException(error, {
        context: 'secret_manager_initialization'
      })
    }
  }

  /**
   * Store a secret
   */
  async storeSecret(
    name: string,
    value: string | object,
    metadata: SecretMetadata = {},
    provider: 'aws' | 'vault' | 'auto' = 'auto'
  ): Promise<{ version?: string; arn?: string }> {
    try {
      const secretValue = typeof value === 'string' ? value : JSON.stringify(value)
      
      if (provider === 'aws' || (provider === 'auto' && this.awsSecretsManager)) {
        return await this.storeInAWS(name, secretValue, metadata)
      } else if (provider === 'vault' || (provider === 'auto' && this.vaultConfig)) {
        return await this.storeInVault(name, secretValue, metadata)
      } else {
        throw new Error('No secret management provider available')
      }

    } catch (error) {
      logger.error('Failed to store secret', {
        name,
        provider,
        error
      })

      monitoringService.captureException(error, {
        context: 'secret_storage',
        extra: { secretName: name, provider }
      })

      throw error
    }
  }

  /**
   * Retrieve a secret
   */
  async getSecret(
    name: string,
    version?: string,
    provider: 'aws' | 'vault' | 'auto' = 'auto',
    useCache: boolean = true
  ): Promise<string | object> {
    try {
      // Check cache first if enabled
      if (useCache) {
        const cacheKey = `${this.cachePrefix}${name}:${version || 'latest'}`
        const cachedValue = await redis.get(cacheKey)
        
        if (cachedValue) {
          logger.debug('Secret retrieved from cache', { name })
          return JSON.parse(cachedValue)
        }
      }

      let secretValue: string

      if (provider === 'aws' || (provider === 'auto' && this.awsSecretsManager)) {
        secretValue = await this.getFromAWS(name, version)
      } else if (provider === 'vault' || (provider === 'auto' && this.vaultConfig)) {
        secretValue = await this.getFromVault(name, version)
      } else {
        throw new Error('No secret management provider available')
      }

      // Try to parse as JSON, return as string if not valid JSON
      let parsedValue: string | object
      try {
        parsedValue = JSON.parse(secretValue)
      } catch {
        parsedValue = secretValue
      }

      // Cache the secret if caching is enabled
      if (useCache) {
        const cacheKey = `${this.cachePrefix}${name}:${version || 'latest'}`
        await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(parsedValue))
      }

      logger.info('Secret retrieved successfully', {
        name,
        provider: provider === 'auto' ? (this.awsSecretsManager ? 'aws' : 'vault') : provider
      })

      return parsedValue

    } catch (error) {
      logger.error('Failed to retrieve secret', {
        name,
        version,
        provider,
        error
      })

      monitoringService.captureException(error, {
        context: 'secret_retrieval',
        extra: { secretName: name, version, provider }
      })

      throw error
    }
  }

  /**
   * Delete a secret
   */
  async deleteSecret(
    name: string,
    provider: 'aws' | 'vault' | 'auto' = 'auto',
    forceDelete: boolean = false
  ): Promise<void> {
    try {
      if (provider === 'aws' || (provider === 'auto' && this.awsSecretsManager)) {
        await this.deleteFromAWS(name, forceDelete)
      } else if (provider === 'vault' || (provider === 'auto' && this.vaultConfig)) {
        await this.deleteFromVault(name)
      } else {
        throw new Error('No secret management provider available')
      }

      // Clear from cache
      await this.clearSecretCache(name)

      logger.info('Secret deleted successfully', { name, provider })

    } catch (error) {
      logger.error('Failed to delete secret', {
        name,
        provider,
        error
      })

      monitoringService.captureException(error, {
        context: 'secret_deletion',
        extra: { secretName: name, provider }
      })

      throw error
    }
  }

  /**
   * Rotate a secret
   */
  async rotateSecret(
    name: string,
    newValue: string | object,
    provider: 'aws' | 'vault' | 'auto' = 'auto'
  ): Promise<{ version?: string; arn?: string }> {
    try {
      // Store new version
      const result = await this.storeSecret(name, newValue, { description: 'Rotated secret' }, provider)

      // Clear cache to force refresh
      await this.clearSecretCache(name)

      logger.info('Secret rotated successfully', { name, provider })

      monitoringService.addBreadcrumb({
        message: 'Secret rotated',
        data: { secretName: name, provider }
      })

      return result

    } catch (error) {
      logger.error('Failed to rotate secret', {
        name,
        provider,
        error
      })

      monitoringService.captureException(error, {
        context: 'secret_rotation',
        extra: { secretName: name, provider }
      })

      throw error
    }
  }

  /**
   * List secrets
   */
  async listSecrets(
    provider: 'aws' | 'vault' | 'auto' = 'auto'
  ): Promise<Array<{ name: string; arn?: string; description?: string; lastModified?: Date }>> {
    try {
      if (provider === 'aws' || (provider === 'auto' && this.awsSecretsManager)) {
        return await this.listFromAWS()
      } else if (provider === 'vault' || (provider === 'auto' && this.vaultConfig)) {
        return await this.listFromVault()
      } else {
        throw new Error('No secret management provider available')
      }

    } catch (error) {
      logger.error('Failed to list secrets', { provider, error })
      
      monitoringService.captureException(error, {
        context: 'secret_listing',
        extra: { provider }
      })

      throw error
    }
  }

  // AWS Secrets Manager implementation
  private async storeInAWS(name: string, value: string, metadata: SecretMetadata): Promise<{ version?: string; arn?: string }> {
    if (!this.awsSecretsManager) throw new Error('AWS Secrets Manager not configured')

    try {
      // Check if secret exists
      let result
      try {
        await this.awsSecretsManager.describeSecret({ SecretId: name }).promise()
        // Secret exists, update it
        result = await this.awsSecretsManager.updateSecret({
          SecretId: name,
          SecretString: value,
          Description: metadata.description
        }).promise()
      } catch (error: any) {
        if (error.code === 'ResourceNotFoundException') {
          // Secret doesn't exist, create it
          result = await this.awsSecretsManager.createSecret({
            Name: name,
            SecretString: value,
            Description: metadata.description,
            Tags: metadata.tags ? Object.entries(metadata.tags).map(([Key, Value]) => ({ Key, Value })) : undefined
          }).promise()
        } else {
          throw error
        }
      }

      return {
        version: result.VersionId,
        arn: result.ARN
      }

    } catch (error) {
      throw new Error(`AWS Secrets Manager error: ${error.message}`)
    }
  }

  private async getFromAWS(name: string, version?: string): Promise<string> {
    if (!this.awsSecretsManager) throw new Error('AWS Secrets Manager not configured')

    try {
      const result = await this.awsSecretsManager.getSecretValue({
        SecretId: name,
        VersionId: version
      }).promise()

      return result.SecretString || ''

    } catch (error: any) {
      if (error.code === 'ResourceNotFoundException') {
        throw new Error(`Secret '${name}' not found`)
      }
      throw new Error(`AWS Secrets Manager error: ${error.message}`)
    }
  }

  private async deleteFromAWS(name: string, forceDelete: boolean): Promise<void> {
    if (!this.awsSecretsManager) throw new Error('AWS Secrets Manager not configured')

    try {
      await this.awsSecretsManager.deleteSecret({
        SecretId: name,
        ForceDeleteWithoutRecovery: forceDelete,
        RecoveryWindowInDays: forceDelete ? undefined : 7
      }).promise()

    } catch (error: any) {
      if (error.code === 'ResourceNotFoundException') {
        // Secret already deleted
        return
      }
      throw new Error(`AWS Secrets Manager error: ${error.message}`)
    }
  }

  private async listFromAWS(): Promise<Array<{ name: string; arn?: string; description?: string; lastModified?: Date }>> {
    if (!this.awsSecretsManager) throw new Error('AWS Secrets Manager not configured')

    try {
      const result = await this.awsSecretsManager.listSecrets().promise()

      return (result.SecretList || []).map(secret => ({
        name: secret.Name || '',
        arn: secret.ARN,
        description: secret.Description,
        lastModified: secret.LastChangedDate
      }))

    } catch (error: any) {
      throw new Error(`AWS Secrets Manager error: ${error.message}`)
    }
  }

  // HashiCorp Vault implementation
  private async storeInVault(name: string, value: string, metadata: SecretMetadata): Promise<{ version?: string; arn?: string }> {
    if (!this.vaultConfig) throw new Error('Vault not configured')

    try {
      const url = `${this.vaultConfig.url}/v1/${this.vaultConfig.enginePath}/data/${name}`
      
      const payload = {
        data: {
          value: value,
          metadata: metadata
        }
      }

      const headers = {
        'X-Vault-Token': this.vaultConfig.token,
        'Content-Type': 'application/json'
      }

      if (this.vaultConfig.namespace) {
        headers['X-Vault-Namespace'] = this.vaultConfig.namespace
      }

      const response = await axios.post(url, payload, { headers })

      return {
        version: response.data?.data?.metadata?.version?.toString()
      }

    } catch (error: any) {
      throw new Error(`Vault error: ${error.response?.data?.errors?.[0] || error.message}`)
    }
  }

  private async getFromVault(name: string, version?: string): Promise<string> {
    if (!this.vaultConfig) throw new Error('Vault not configured')

    try {
      let url = `${this.vaultConfig.url}/v1/${this.vaultConfig.enginePath}/data/${name}`
      if (version) {
        url += `?version=${version}`
      }

      const headers = {
        'X-Vault-Token': this.vaultConfig.token
      }

      if (this.vaultConfig.namespace) {
        headers['X-Vault-Namespace'] = this.vaultConfig.namespace
      }

      const response = await axios.get(url, { headers })

      return response.data?.data?.data?.value || ''

    } catch (error: any) {
      if (error.response?.status === 404) {
        throw new Error(`Secret '${name}' not found`)
      }
      throw new Error(`Vault error: ${error.response?.data?.errors?.[0] || error.message}`)
    }
  }

  private async deleteFromVault(name: string): Promise<void> {
    if (!this.vaultConfig) throw new Error('Vault not configured')

    try {
      const url = `${this.vaultConfig.url}/v1/${this.vaultConfig.enginePath}/metadata/${name}`
      
      const headers = {
        'X-Vault-Token': this.vaultConfig.token
      }

      if (this.vaultConfig.namespace) {
        headers['X-Vault-Namespace'] = this.vaultConfig.namespace
      }

      await axios.delete(url, { headers })

    } catch (error: any) {
      if (error.response?.status === 404) {
        // Secret already deleted
        return
      }
      throw new Error(`Vault error: ${error.response?.data?.errors?.[0] || error.message}`)
    }
  }

  private async listFromVault(): Promise<Array<{ name: string; arn?: string; description?: string; lastModified?: Date }>> {
    if (!this.vaultConfig) throw new Error('Vault not configured')

    try {
      const url = `${this.vaultConfig.url}/v1/${this.vaultConfig.enginePath}/metadata?list=true`
      
      const headers = {
        'X-Vault-Token': this.vaultConfig.token
      }

      if (this.vaultConfig.namespace) {
        headers['X-Vault-Namespace'] = this.vaultConfig.namespace
      }

      const response = await axios.get(url, { headers })

      return (response.data?.data?.keys || []).map((name: string) => ({
        name
      }))

    } catch (error: any) {
      throw new Error(`Vault error: ${error.response?.data?.errors?.[0] || error.message}`)
    }
  }

  /**
   * Clear secret from cache
   */
  private async clearSecretCache(name: string): Promise<void> {
    try {
      const pattern = `${this.cachePrefix}${name}:*`
      const keys = await redis.keys(pattern)
      
      if (keys.length > 0) {
        await redis.del(...keys)
      }

    } catch (error) {
      logger.warn('Failed to clear secret cache', { name, error })
    }
  }

  /**
   * Generate a secure random secret
   */
  static generateSecret(length: number = 32, format: 'hex' | 'base64' | 'base64url' = 'base64url'): string {
    const bytes = crypto.randomBytes(length)
    
    switch (format) {
      case 'hex':
        return bytes.toString('hex')
      case 'base64':
        return bytes.toString('base64')
      case 'base64url':
        return bytes.toString('base64url')
      default:
        return bytes.toString('base64url')
    }
  }

  /**
   * Encrypt sensitive data before storage
   */
  static encrypt(data: string, key: string): { encrypted: string; iv: string } {
    const algorithm = 'aes-256-gcm'
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipher(algorithm, key)
    
    let encrypted = cipher.update(data, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    
    return {
      encrypted,
      iv: iv.toString('hex')
    }
  }

  /**
   * Decrypt encrypted data
   */
  static decrypt(encryptedData: string, key: string, iv: string): string {
    const algorithm = 'aes-256-gcm'
    const decipher = crypto.createDecipher(algorithm, key)
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    
    return decrypted
  }

  /**
   * Health check for secret management providers
   */
  async healthCheck(): Promise<{
    aws: { available: boolean; error?: string }
    vault: { available: boolean; error?: string }
  }> {
    const health = {
      aws: { available: false },
      vault: { available: false }
    }

    // Check AWS Secrets Manager
    if (this.awsSecretsManager) {
      try {
        await this.awsSecretsManager.listSecrets({ MaxResults: 1 }).promise()
        health.aws.available = true
      } catch (error) {
        health.aws.error = error.message
      }
    }

    // Check Vault
    if (this.vaultConfig) {
      try {
        const headers = { 'X-Vault-Token': this.vaultConfig.token }
        await axios.get(`${this.vaultConfig.url}/v1/sys/health`, { headers, timeout: 5000 })
        health.vault.available = true
      } catch (error) {
        health.vault.error = error.message
      }
    }

    return health
  }
}

export const secretManagerService = new SecretManagerService()