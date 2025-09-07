import { Redis } from 'ioredis'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'
import { EventEmitter } from 'events'
import axios, { AxiosError } from 'axios'
import crypto from 'crypto'

interface WebhookAttempt {
  id: string
  webhookId: string
  organizationId: string
  url: string
  payload: any
  headers: Record<string, string>
  attempt: number
  maxAttempts: number
  status: 'pending' | 'success' | 'failed' | 'expired'
  httpStatus?: number
  responseBody?: string
  errorMessage?: string
  nextAttemptAt: Date
  createdAt: Date
  updatedAt: Date
}

interface WebhookConfig {
  id: string
  organizationId: string
  name: string
  url: string
  events: string[]
  secret?: string
  isActive: boolean
  maxAttempts: number
  retryDelays: number[] // in seconds
  timeout: number // in milliseconds
  headers?: Record<string, string>
}

interface RetryConfig {
  redis: Redis
  supabaseUrl: string
  supabaseKey: string
  defaultMaxAttempts: number
  defaultRetryDelays: number[]
  defaultTimeout: number
  maxPayloadSize: number
  rateLimitWindow: number // seconds
  rateLimitMax: number
}

export class WebhookRetryService extends EventEmitter {
  private redis: Redis
  private supabase: any
  private config: RetryConfig
  private isRunning = false
  private processingInterval?: NodeJS.Timeout

  constructor(config: RetryConfig) {
    super()
    
    this.config = config
    this.redis = config.redis
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)
  }

  /**
   * Start the retry service
   */
  async start(): Promise<void> {
    if (this.isRunning) return

    this.isRunning = true
    
    // Start processing retry queue
    this.processingInterval = setInterval(() => {
      this.processRetryQueue().catch(error => {
        logger.error('Error processing retry queue:', error)
      })
    }, 10000) // Check every 10 seconds

    logger.info('Webhook retry service started')
  }

  /**
   * Stop the retry service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    this.isRunning = false
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval)
      this.processingInterval = undefined
    }

    logger.info('Webhook retry service stopped')
  }

  /**
   * Send webhook with retry logic
   */
  async sendWebhook(
    organizationId: string,
    eventType: string,
    payload: any,
    webhookConfigId?: string
  ): Promise<void> {
    try {
      // Get webhook configurations for this organization and event
      const webhookConfigs = await this.getWebhookConfigs(organizationId, eventType, webhookConfigId)
      
      if (webhookConfigs.length === 0) {
        logger.debug('No webhook configurations found', { organizationId, eventType })
        return
      }

      // Send to each configured webhook
      for (const config of webhookConfigs) {
        await this.scheduleWebhookAttempt(config, payload)
      }

    } catch (error) {
      logger.error('Failed to send webhook:', error)
      throw error
    }
  }

  /**
   * Schedule webhook attempt
   */
  private async scheduleWebhookAttempt(
    webhookConfig: WebhookConfig,
    payload: any
  ): Promise<void> {
    // Check rate limiting
    const rateLimitKey = `webhook_rate_limit:${webhookConfig.organizationId}:${webhookConfig.id}`
    const currentCount = await this.redis.get(rateLimitKey)
    
    if (currentCount && parseInt(currentCount) >= this.config.rateLimitMax) {
      logger.warn('Webhook rate limit exceeded', {
        organizationId: webhookConfig.organizationId,
        webhookId: webhookConfig.id
      })
      return
    }

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Sierra-Sync-Webhook/1.0',
      'X-Sierra-Event': payload.event || 'unknown',
      'X-Sierra-Timestamp': new Date().toISOString(),
      ...webhookConfig.headers
    }

    // Add signature if secret is configured
    if (webhookConfig.secret) {
      const signature = this.generateSignature(payload, webhookConfig.secret)
      headers['X-Sierra-Signature'] = signature
    }

    const webhookAttempt: WebhookAttempt = {
      id: crypto.randomUUID(),
      webhookId: webhookConfig.id,
      organizationId: webhookConfig.organizationId,
      url: webhookConfig.url,
      payload,
      headers,
      attempt: 1,
      maxAttempts: webhookConfig.maxAttempts,
      status: 'pending',
      nextAttemptAt: new Date(), // Immediate first attempt
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // Store in database
    await this.storeWebhookAttempt(webhookAttempt)

    // Add to retry queue
    await this.redis.zadd('webhook_retry_queue', Date.now(), webhookAttempt.id)

    // Increment rate limit counter
    await this.redis.multi()
      .incr(rateLimitKey)
      .expire(rateLimitKey, this.config.rateLimitWindow)
      .exec()

    logger.info('Webhook attempt scheduled', {
      attemptId: webhookAttempt.id,
      webhookId: webhookConfig.id,
      url: webhookConfig.url
    })
  }

  /**
   * Process retry queue
   */
  private async processRetryQueue(): Promise<void> {
    if (!this.isRunning) return

    try {
      const now = Date.now()
      
      // Get attempts ready for execution
      const readyAttempts = await this.redis.zrangebyscore('webhook_retry_queue', 0, now, 'LIMIT', 0, 10)

      for (const attemptId of readyAttempts) {
        await this.executeWebhookAttempt(attemptId)
      }

    } catch (error) {
      logger.error('Error processing webhook retry queue:', error)
    }
  }

  /**
   * Execute webhook attempt
   */
  private async executeWebhookAttempt(attemptId: string): Promise<void> {
    try {
      // Get attempt details
      const attempt = await this.getWebhookAttempt(attemptId)
      if (!attempt || attempt.status !== 'pending') {
        // Remove from queue if not pending
        await this.redis.zrem('webhook_retry_queue', attemptId)
        return
      }

      logger.info('Executing webhook attempt', {
        attemptId: attempt.id,
        attempt: attempt.attempt,
        url: attempt.url
      })

      // Execute HTTP request
      const startTime = Date.now()
      let success = false
      let httpStatus: number | undefined
      let responseBody: string | undefined
      let errorMessage: string | undefined

      try {
        const response = await axios.post(attempt.url, attempt.payload, {
          headers: attempt.headers,
          timeout: this.getWebhookTimeout(attempt.webhookId),
          validateStatus: (status) => status >= 200 && status < 300
        })

        success = true
        httpStatus = response.status
        responseBody = JSON.stringify(response.data).substring(0, 1000) // Limit response size

      } catch (error) {
        if (error.response) {
          // HTTP error response
          httpStatus = error.response.status
          responseBody = JSON.stringify(error.response.data).substring(0, 1000)
          errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`
        } else if (error.request) {
          // Network error
          errorMessage = `Network error: ${error.message}`
        } else {
          // Other error
          errorMessage = error.message
        }
      }

      const duration = Date.now() - startTime

      // Update attempt
      await this.updateWebhookAttempt(attemptId, {
        status: success ? 'success' : (attempt.attempt >= attempt.maxAttempts ? 'failed' : 'pending'),
        httpStatus,
        responseBody,
        errorMessage,
        updatedAt: new Date()
      })

      // Remove from current queue
      await this.redis.zrem('webhook_retry_queue', attemptId)

      if (success) {
        // Success - emit event
        this.emit('webhook_success', {
          attemptId: attempt.id,
          webhookId: attempt.webhookId,
          organizationId: attempt.organizationId,
          url: attempt.url,
          attempt: attempt.attempt,
          duration
        })

        logger.info('Webhook delivered successfully', {
          attemptId: attempt.id,
          attempt: attempt.attempt,
          url: attempt.url,
          duration: `${duration}ms`
        })

      } else if (attempt.attempt < attempt.maxAttempts) {
        // Retry needed - schedule next attempt
        const nextAttempt = await this.scheduleRetry(attemptId, attempt.attempt + 1)
        
        logger.warn('Webhook attempt failed, scheduling retry', {
          attemptId: attempt.id,
          attempt: attempt.attempt,
          nextAttempt: nextAttempt.toISOString(),
          error: errorMessage
        })

      } else {
        // Max attempts reached - mark as failed
        this.emit('webhook_failed', {
          attemptId: attempt.id,
          webhookId: attempt.webhookId,
          organizationId: attempt.organizationId,
          url: attempt.url,
          totalAttempts: attempt.attempt,
          finalError: errorMessage
        })

        logger.error('Webhook delivery failed after all attempts', {
          attemptId: attempt.id,
          totalAttempts: attempt.attempt,
          url: attempt.url,
          error: errorMessage
        })
      }

      // Track metrics
      await this.trackWebhookMetrics(attempt.organizationId, success, duration, attempt.attempt)

    } catch (error) {
      logger.error('Error executing webhook attempt:', error)
      await this.redis.zrem('webhook_retry_queue', attemptId)
    }
  }

  /**
   * Schedule retry attempt
   */
  private async scheduleRetry(attemptId: string, attemptNumber: number): Promise<Date> {
    const webhookConfig = await this.getWebhookConfigForAttempt(attemptId)
    if (!webhookConfig) {
      throw new Error('Webhook configuration not found')
    }

    // Calculate delay
    const retryDelays = webhookConfig.retryDelays || this.config.defaultRetryDelays
    const delayIndex = Math.min(attemptNumber - 2, retryDelays.length - 1)
    const delaySeconds = retryDelays[delayIndex]
    
    // Add jitter (±25%)
    const jitter = Math.random() * 0.5 - 0.25 // -0.25 to +0.25
    const actualDelay = delaySeconds * (1 + jitter)
    
    const nextAttemptAt = new Date(Date.now() + actualDelay * 1000)

    // Update attempt
    await this.updateWebhookAttempt(attemptId, {
      attempt: attemptNumber,
      nextAttemptAt,
      updatedAt: new Date()
    })

    // Schedule in queue
    await this.redis.zadd('webhook_retry_queue', nextAttemptAt.getTime(), attemptId)

    return nextAttemptAt
  }

  /**
   * Generate webhook signature
   */
  private generateSignature(payload: any, secret: string): string {
    const payloadString = JSON.stringify(payload)
    return crypto
      .createHmac('sha256', secret)
      .update(payloadString)
      .digest('hex')
  }

  /**
   * Get webhook configurations
   */
  private async getWebhookConfigs(
    organizationId: string,
    eventType: string,
    webhookConfigId?: string
  ): Promise<WebhookConfig[]> {
    let query = this.supabase
      .from('webhook_configs')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .contains('events', [eventType])

    if (webhookConfigId) {
      query = query.eq('id', webhookConfigId)
    }

    const { data, error } = await query

    if (error) throw error

    return data.map(config => ({
      id: config.id,
      organizationId: config.organization_id,
      name: config.name,
      url: config.url,
      events: config.events,
      secret: config.secret,
      isActive: config.is_active,
      maxAttempts: config.max_attempts || this.config.defaultMaxAttempts,
      retryDelays: config.retry_delays || this.config.defaultRetryDelays,
      timeout: config.timeout || this.config.defaultTimeout,
      headers: config.headers
    }))
  }

  /**
   * Store webhook attempt
   */
  private async storeWebhookAttempt(attempt: WebhookAttempt): Promise<void> {
    const { error } = await this.supabase
      .from('webhook_attempts')
      .insert({
        id: attempt.id,
        webhook_id: attempt.webhookId,
        organization_id: attempt.organizationId,
        url: attempt.url,
        payload: attempt.payload,
        headers: attempt.headers,
        attempt: attempt.attempt,
        max_attempts: attempt.maxAttempts,
        status: attempt.status,
        http_status: attempt.httpStatus,
        response_body: attempt.responseBody,
        error_message: attempt.errorMessage,
        next_attempt_at: attempt.nextAttemptAt.toISOString(),
        created_at: attempt.createdAt.toISOString(),
        updated_at: attempt.updatedAt.toISOString()
      })

    if (error) throw error
  }

  /**
   * Update webhook attempt
   */
  private async updateWebhookAttempt(attemptId: string, updates: Partial<WebhookAttempt>): Promise<void> {
    const dbUpdates: any = {
      updated_at: new Date().toISOString()
    }

    if (updates.status) dbUpdates.status = updates.status
    if (updates.httpStatus) dbUpdates.http_status = updates.httpStatus
    if (updates.responseBody) dbUpdates.response_body = updates.responseBody
    if (updates.errorMessage) dbUpdates.error_message = updates.errorMessage
    if (updates.attempt) dbUpdates.attempt = updates.attempt
    if (updates.nextAttemptAt) dbUpdates.next_attempt_at = updates.nextAttemptAt.toISOString()

    const { error } = await this.supabase
      .from('webhook_attempts')
      .update(dbUpdates)
      .eq('id', attemptId)

    if (error) throw error
  }

  /**
   * Get webhook attempt
   */
  private async getWebhookAttempt(attemptId: string): Promise<WebhookAttempt | null> {
    const { data, error } = await this.supabase
      .from('webhook_attempts')
      .select('*')
      .eq('id', attemptId)
      .single()

    if (error || !data) return null

    return {
      id: data.id,
      webhookId: data.webhook_id,
      organizationId: data.organization_id,
      url: data.url,
      payload: data.payload,
      headers: data.headers,
      attempt: data.attempt,
      maxAttempts: data.max_attempts,
      status: data.status,
      httpStatus: data.http_status,
      responseBody: data.response_body,
      errorMessage: data.error_message,
      nextAttemptAt: new Date(data.next_attempt_at),
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    }
  }

  /**
   * Get webhook configuration for attempt
   */
  private async getWebhookConfigForAttempt(attemptId: string): Promise<WebhookConfig | null> {
    const { data, error } = await this.supabase
      .from('webhook_attempts')
      .select(`
        webhook_id,
        webhook_configs!inner(*)
      `)
      .eq('id', attemptId)
      .single()

    if (error || !data) return null

    const config = data.webhook_configs
    return {
      id: config.id,
      organizationId: config.organization_id,
      name: config.name,
      url: config.url,
      events: config.events,
      secret: config.secret,
      isActive: config.is_active,
      maxAttempts: config.max_attempts || this.config.defaultMaxAttempts,
      retryDelays: config.retry_delays || this.config.defaultRetryDelays,
      timeout: config.timeout || this.config.defaultTimeout,
      headers: config.headers
    }
  }

  /**
   * Get webhook timeout for configuration
   */
  private getWebhookTimeout(webhookId: string): number {
    // This could be cached or looked up from config
    return this.config.defaultTimeout
  }

  /**
   * Track webhook metrics
   */
  private async trackWebhookMetrics(
    organizationId: string,
    success: boolean,
    duration: number,
    attempt: number
  ): Promise<void> {
    const date = new Date().toISOString().split('T')[0] // YYYY-MM-DD
    const key = `webhook_metrics:${organizationId}:${date}`

    await this.redis.multi()
      .hincrby(key, 'total', 1)
      .hincrby(key, success ? 'success' : 'failed', 1)
      .hincrby(key, 'total_duration', duration)
      .hincrby(key, `attempt_${attempt}`, 1)
      .expire(key, 86400 * 30) // 30 days
      .exec()
  }

  /**
   * Get webhook metrics
   */
  async getWebhookMetrics(organizationId: string, days: number = 7): Promise<any> {
    const metrics: any = {
      organizationId,
      period: `${days} days`,
      daily: {},
      summary: {
        total: 0,
        success: 0,
        failed: 0,
        averageDuration: 0,
        successRate: 0
      }
    }

    let totalCount = 0
    let totalSuccess = 0
    let totalFailed = 0
    let totalDuration = 0

    for (let i = 0; i < days; i++) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split('T')[0]
      
      const key = `webhook_metrics:${organizationId}:${dateStr}`
      const dayMetrics = await this.redis.hgetall(key)

      const dayTotal = parseInt(dayMetrics.total || '0')
      const daySuccess = parseInt(dayMetrics.success || '0')
      const dayFailed = parseInt(dayMetrics.failed || '0')
      const dayDuration = parseInt(dayMetrics.total_duration || '0')

      metrics.daily[dateStr] = {
        total: dayTotal,
        success: daySuccess,
        failed: dayFailed,
        averageDuration: dayTotal > 0 ? Math.round(dayDuration / dayTotal) : 0
      }

      totalCount += dayTotal
      totalSuccess += daySuccess
      totalFailed += dayFailed
      totalDuration += dayDuration
    }

    metrics.summary = {
      total: totalCount,
      success: totalSuccess,
      failed: totalFailed,
      averageDuration: totalCount > 0 ? Math.round(totalDuration / totalCount) : 0,
      successRate: totalCount > 0 ? Math.round((totalSuccess / totalCount) * 100) : 0
    }

    return metrics
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    details: any
  }> {
    try {
      const queueLength = await this.redis.zcard('webhook_retry_queue')
      const processingRate = await this.getProcessingRate()

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      const issues: string[] = []

      // Check queue backlog
      if (queueLength > 1000) {
        status = 'unhealthy'
        issues.push(`Critical webhook queue backlog: ${queueLength}`)
      } else if (queueLength > 100) {
        status = 'degraded'
        issues.push(`Webhook queue backlog: ${queueLength}`)
      }

      // Check processing rate
      if (processingRate < 10) { // Less than 10 webhooks per minute
        if (queueLength > 50) {
          status = status === 'unhealthy' ? 'unhealthy' : 'degraded'
          issues.push('Low webhook processing rate with pending queue')
        }
      }

      return {
        status,
        details: {
          isRunning: this.isRunning,
          queueLength,
          processingRate: `${processingRate}/min`,
          issues: issues.length > 0 ? issues : ['All systems operational'],
          timestamp: new Date().toISOString()
        }
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error.message,
          timestamp: new Date().toISOString()
        }
      }
    }
  }

  /**
   * Get processing rate (webhooks per minute)
   */
  private async getProcessingRate(): Promise<number> {
    const key = 'webhook_processing_rate'
    const count = await this.redis.get(key)
    return parseInt(count || '0')
  }
}