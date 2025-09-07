import Bull, { Queue, Job, JobOptions, QueueOptions, QueueScheduler, Worker } from 'bull'
import { Redis } from 'ioredis'
import { logger } from '../utils/logger'
import { captureError, PerformanceMonitor } from '../utils/monitoring'
import { CircuitBreakerFactory } from '../utils/circuitBreaker'

interface QueueConfig {
  redis: {
    host: string
    port: number
    password?: string
  }
  defaultJobOptions?: JobOptions
  metrics?: boolean
}

interface JobResult {
  success: boolean
  data?: any
  error?: string
  duration?: number
}

/**
 * Queue manager for handling async tasks
 */
export class QueueManager {
  private queues: Map<string, Queue> = new Map()
  private workers: Map<string, Worker> = new Map()
  private schedulers: Map<string, QueueScheduler> = new Map()
  private config: QueueConfig
  private redisClient: Redis
  
  constructor(config: QueueConfig) {
    this.config = config
    this.redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: 3
    })
  }
  
  /**
   * Create or get a queue
   */
  getQueue(name: string, options?: QueueOptions): Queue {
    if (!this.queues.has(name)) {
      const queue = new Bull(name, {
        redis: this.config.redis,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 500,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          ...this.config.defaultJobOptions
        },
        ...options
      })
      
      this.queues.set(name, queue)
      this.setupQueueEventHandlers(queue, name)
      
      // Create scheduler for delayed jobs
      const scheduler = new QueueScheduler(name, {
        connection: this.config.redis
      })
      this.schedulers.set(name, scheduler)
    }
    
    return this.queues.get(name)!
  }
  
  /**
   * Create a worker for processing jobs
   */
  createWorker(
    queueName: string,
    processor: (job: Job) => Promise<any>,
    concurrency: number = 1
  ): Worker {
    if (this.workers.has(queueName)) {
      throw new Error(`Worker already exists for queue: ${queueName}`)
    }
    
    const worker = new Worker(
      queueName,
      async (job: Job) => {
        const startTime = Date.now()
        const transactionId = PerformanceMonitor.startTransaction({
          name: `queue.${queueName}.process`,
          op: 'queue',
          data: { jobId: job.id, jobName: job.name }
        })
        
        try {
          logger.info(`Processing job ${job.id} from queue ${queueName}`)
          const result = await processor(job)
          
          const duration = Date.now() - startTime
          PerformanceMonitor.endTransaction(transactionId, 'ok')
          
          if (this.config.metrics) {
            PerformanceMonitor.sendMetric(`queue.${queueName}.duration`, {
              value: duration,
              unit: 'millisecond',
              tags: { jobName: job.name || 'default' }
            })
          }
          
          return result
        } catch (error) {
          PerformanceMonitor.endTransaction(transactionId, 'error')
          
          captureError(error as Error, {
            tags: {
              queue: queueName,
              jobId: job.id?.toString() || 'unknown',
              jobName: job.name || 'unknown'
            },
            extra: {
              jobData: job.data,
              attemptNumber: job.attemptsMade
            }
          })
          
          throw error
        }
      },
      {
        connection: this.config.redis,
        concurrency,
        limiter: {
          max: concurrency * 2,
          duration: 1000
        }
      }
    )
    
    this.workers.set(queueName, worker)
    this.setupWorkerEventHandlers(worker, queueName)
    
    return worker
  }
  
  /**
   * Setup queue event handlers
   */
  private setupQueueEventHandlers(queue: Queue, name: string): void {
    queue.on('error', (error) => {
      logger.error(`Queue ${name} error:`, error)
      captureError(error, { tags: { queue: name } })
    })
    
    queue.on('waiting', (jobId) => {
      logger.debug(`Job ${jobId} waiting in queue ${name}`)
    })
    
    queue.on('stalled', (job) => {
      logger.warn(`Job ${job.id} stalled in queue ${name}`)
    })
    
    queue.on('removed', (job) => {
      logger.debug(`Job ${job.id} removed from queue ${name}`)
    })
  }
  
  /**
   * Setup worker event handlers
   */
  private setupWorkerEventHandlers(worker: Worker, name: string): void {
    worker.on('completed', (job, result) => {
      logger.info(`Job ${job.id} completed in queue ${name}`, {
        duration: Date.now() - job.processedOn!,
        result: typeof result === 'object' ? JSON.stringify(result).slice(0, 100) : result
      })
      
      if (this.config.metrics) {
        PerformanceMonitor.sendMetric(`queue.${name}.completed`, {
          value: 1,
          unit: 'none',
          tags: { jobName: job.name || 'default' }
        })
      }
    })
    
    worker.on('failed', (job, error) => {
      logger.error(`Job ${job?.id} failed in queue ${name}:`, error)
      
      if (this.config.metrics) {
        PerformanceMonitor.sendMetric(`queue.${name}.failed`, {
          value: 1,
          unit: 'none',
          tags: { 
            jobName: job?.name || 'default',
            errorType: error.name
          }
        })
      }
    })
    
    worker.on('error', (error) => {
      logger.error(`Worker error in queue ${name}:`, error)
      captureError(error, { tags: { queue: name, component: 'worker' } })
    })
  }
  
  /**
   * Add a job to queue
   */
  async addJob(
    queueName: string,
    jobName: string,
    data: any,
    options?: JobOptions
  ): Promise<Job> {
    const queue = this.getQueue(queueName)
    
    const job = await queue.add(jobName, data, {
      ...this.config.defaultJobOptions,
      ...options
    })
    
    logger.info(`Job ${job.id} added to queue ${queueName}`)
    
    return job
  }
  
  /**
   * Add bulk jobs
   */
  async addBulkJobs(
    queueName: string,
    jobs: Array<{ name: string; data: any; opts?: JobOptions }>
  ): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    
    const bulkJobs = jobs.map(job => ({
      name: job.name,
      data: job.data,
      opts: { ...this.config.defaultJobOptions, ...job.opts }
    }))
    
    const addedJobs = await queue.addBulk(bulkJobs)
    
    logger.info(`${addedJobs.length} jobs added to queue ${queueName}`)
    
    return addedJobs
  }
  
  /**
   * Get queue metrics
   */
  async getQueueMetrics(queueName: string): Promise<{
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
    paused: boolean
  }> {
    const queue = this.getQueue(queueName)
    
    const [waiting, active, completed, failed, delayed, isPaused] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
      queue.isPaused()
    ])
    
    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused: isPaused
    }
  }
  
  /**
   * Pause a queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    await queue.pause()
    logger.info(`Queue ${queueName} paused`)
  }
  
  /**
   * Resume a queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    await queue.resume()
    logger.info(`Queue ${queueName} resumed`)
  }
  
  /**
   * Clean queue
   */
  async cleanQueue(
    queueName: string,
    grace: number = 0,
    status?: 'completed' | 'wait' | 'active' | 'delayed' | 'failed'
  ): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    const removed = await queue.clean(grace, status)
    logger.info(`Cleaned ${removed.length} jobs from queue ${queueName}`)
    return removed
  }
  
  /**
   * Shutdown all queues and workers
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down queue manager...')
    
    // Close all workers
    for (const [name, worker] of this.workers) {
      await worker.close()
      logger.info(`Worker ${name} closed`)
    }
    
    // Close all schedulers
    for (const [name, scheduler] of this.schedulers) {
      await scheduler.close()
      logger.info(`Scheduler ${name} closed`)
    }
    
    // Close all queues
    for (const [name, queue] of this.queues) {
      await queue.close()
      logger.info(`Queue ${name} closed`)
    }
    
    // Close Redis connection
    this.redisClient.disconnect()
    
    logger.info('Queue manager shutdown complete')
  }
}

/**
 * Job processors for different task types
 */
export class JobProcessors {
  /**
   * Process lead sync job
   */
  static async processLeadSync(job: Job): Promise<JobResult> {
    const startTime = Date.now()
    const { leadId, crmType, operation } = job.data
    
    try {
      logger.info(`Syncing lead ${leadId} to ${crmType}`)
      
      // Use circuit breaker for external API calls
      const breaker = CircuitBreakerFactory.getBreaker(`crm-${crmType}`, {
        timeout: 30000,
        errorThreshold: 5,
        resetTimeout: 60000
      })
      
      const result = await breaker.execute(async () => {
        // Actual sync logic would go here
        // This is a placeholder
        return { success: true, syncedAt: new Date() }
      })
      
      return {
        success: true,
        data: result,
        duration: Date.now() - startTime
      }
    } catch (error) {
      logger.error(`Lead sync failed for ${leadId}:`, error)
      
      return {
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime
      }
    }
  }
  
  /**
   * Process webhook delivery job
   */
  static async processWebhookDelivery(job: Job): Promise<JobResult> {
    const { url, payload, headers, retryCount = 0 } = job.data
    
    try {
      const breaker = CircuitBreakerFactory.getBreaker(`webhook-${new URL(url).hostname}`, {
        timeout: 10000,
        errorThreshold: 3,
        resetTimeout: 30000
      })
      
      const response = await breaker.execute(async () => {
        const axios = require('axios')
        return axios.post(url, payload, { headers, timeout: 10000 })
      })
      
      return {
        success: true,
        data: {
          statusCode: response.status,
          responseTime: response.headers['x-response-time']
        }
      }
    } catch (error) {
      // Retry logic
      if (retryCount < 3) {
        throw error // Let Bull handle retry
      }
      
      return {
        success: false,
        error: (error as Error).message
      }
    }
  }
  
  /**
   * Process email notification job
   */
  static async processEmailNotification(job: Job): Promise<JobResult> {
    const { to, subject, template, data } = job.data
    
    try {
      // Email sending logic would go here
      logger.info(`Sending email to ${to}: ${subject}`)
      
      return {
        success: true,
        data: { messageId: `msg-${Date.now()}` }
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      }
    }
  }
  
  /**
   * Process analytics aggregation job
   */
  static async processAnalyticsAggregation(job: Job): Promise<JobResult> {
    const { organizationId, dateRange } = job.data
    
    try {
      logger.info(`Aggregating analytics for org ${organizationId}`)
      
      // Analytics logic would go here
      const metrics = {
        totalSyncs: 1000,
        successRate: 98.5,
        averageResponseTime: 245
      }
      
      return {
        success: true,
        data: metrics
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      }
    }
  }
}

/**
 * Queue initialization
 */
export function initializeQueues(config: QueueConfig): QueueManager {
  const queueManager = new QueueManager(config)
  
  // Create workers for different job types
  queueManager.createWorker('lead-sync', JobProcessors.processLeadSync, 5)
  queueManager.createWorker('webhook-delivery', JobProcessors.processWebhookDelivery, 10)
  queueManager.createWorker('email-notifications', JobProcessors.processEmailNotification, 3)
  queueManager.createWorker('analytics', JobProcessors.processAnalyticsAggregation, 2)
  
  // Schedule recurring jobs
  const analyticsQueue = queueManager.getQueue('analytics')
  analyticsQueue.add(
    'daily-aggregation',
    { type: 'daily' },
    {
      repeat: {
        cron: '0 2 * * *' // Run at 2 AM daily
      }
    }
  )
  
  logger.info('Queue system initialized')
  
  return queueManager
}