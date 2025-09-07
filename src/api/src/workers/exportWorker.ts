import { Worker } from 'worker_threads'
import { Redis } from 'ioredis'
import { DataExportService } from '../services/dataExport'
import { logger } from '../utils/logger'
import { createClient } from '@supabase/supabase-js'

interface WorkerConfig {
  redis: Redis
  supabaseUrl: string
  supabaseKey: string
  s3Config: {
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
  }
  concurrency: number
  maxFileSize: number
  expirationHours: number
}

export class ExportWorkerManager {
  private workers: Worker[] = []
  private redis: Redis
  private config: WorkerConfig
  private dataExportService: DataExportService
  private isRunning = false

  constructor(config: WorkerConfig) {
    this.config = config
    this.redis = config.redis
    
    this.dataExportService = new DataExportService({
      redis: this.redis,
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      s3: config.s3Config,
      maxFileSize: config.maxFileSize,
      expirationHours: config.expirationHours
    })
  }

  /**
   * Start the worker manager
   */
  async start(): Promise<void> {
    if (this.isRunning) return

    this.isRunning = true
    logger.info(`Starting export worker manager with ${this.config.concurrency} workers`)

    // Start export queue processor
    this.processExportQueue()
    
    // Start import queue processor
    this.processImportQueue()

    // Start cleanup scheduler
    this.scheduleCleanup()

    logger.info('Export worker manager started successfully')
  }

  /**
   * Stop the worker manager
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    this.isRunning = false
    
    // Terminate all workers
    await Promise.all(
      this.workers.map(worker => 
        new Promise(resolve => {
          worker.terminate(() => resolve(void 0))
        })
      )
    )
    
    this.workers = []
    logger.info('Export worker manager stopped')
  }

  /**
   * Process export queue
   */
  private async processExportQueue(): Promise<void> {
    while (this.isRunning) {
      try {
        // Block until job available
        const job = await this.redis.brpop('export_queue', 5) // 5 second timeout
        
        if (!job) continue

        const jobData = JSON.parse(job[1])
        logger.info('Processing export job', { requestId: jobData.requestId })

        // Process export in background
        this.processExport(jobData.requestId).catch(error => {
          logger.error('Export processing failed', {
            requestId: jobData.requestId,
            error: error.message,
            stack: error.stack
          })
        })

      } catch (error) {
        logger.error('Export queue processing error:', error)
        await new Promise(resolve => setTimeout(resolve, 1000)) // Wait 1 second before retry
      }
    }
  }

  /**
   * Process import queue
   */
  private async processImportQueue(): Promise<void> {
    while (this.isRunning) {
      try {
        // Block until job available
        const job = await this.redis.brpop('import_queue', 5) // 5 second timeout
        
        if (!job) continue

        const jobData = JSON.parse(job[1])
        logger.info('Processing import job', { requestId: jobData.requestId })

        // Process import in background
        this.processImport(jobData.requestId).catch(error => {
          logger.error('Import processing failed', {
            requestId: jobData.requestId,
            error: error.message,
            stack: error.stack
          })
        })

      } catch (error) {
        logger.error('Import queue processing error:', error)
        await new Promise(resolve => setTimeout(resolve, 1000)) // Wait 1 second before retry
      }
    }
  }

  /**
   * Process single export
   */
  private async processExport(requestId: string): Promise<void> {
    const startTime = Date.now()
    
    try {
      await this.dataExportService.processExport(requestId)
      
      const duration = Date.now() - startTime
      logger.info('Export completed successfully', {
        requestId,
        duration: `${duration}ms`
      })

      // Track metrics
      await this.redis.hincrby('export_metrics', 'completed', 1)
      await this.redis.hincrby('export_metrics', 'total_duration', duration)

    } catch (error) {
      logger.error('Export failed', {
        requestId,
        error: error.message,
        stack: error.stack
      })

      // Track failure metrics
      await this.redis.hincrby('export_metrics', 'failed', 1)
    }
  }

  /**
   * Process single import
   */
  private async processImport(requestId: string): Promise<void> {
    const startTime = Date.now()
    
    try {
      await this.dataExportService.processImport(requestId)
      
      const duration = Date.now() - startTime
      logger.info('Import completed successfully', {
        requestId,
        duration: `${duration}ms`
      })

      // Track metrics
      await this.redis.hincrby('import_metrics', 'completed', 1)
      await this.redis.hincrby('import_metrics', 'total_duration', duration)

    } catch (error) {
      logger.error('Import failed', {
        requestId,
        error: error.message,
        stack: error.stack
      })

      // Track failure metrics
      await this.redis.hincrby('import_metrics', 'failed', 1)
    }
  }

  /**
   * Schedule cleanup tasks
   */
  private scheduleCleanup(): void {
    // Run cleanup every hour
    const cleanupInterval = setInterval(async () => {
      if (!this.isRunning) {
        clearInterval(cleanupInterval)
        return
      }

      try {
        await this.dataExportService.cleanupExpiredExports()
        logger.info('Cleanup completed successfully')
      } catch (error) {
        logger.error('Cleanup failed:', error)
      }
    }, 60 * 60 * 1000) // 1 hour
  }

  /**
   * Get worker metrics
   */
  async getMetrics(): Promise<{
    export: any
    import: any
    queue: any
  }> {
    const [exportMetrics, importMetrics] = await Promise.all([
      this.redis.hgetall('export_metrics'),
      this.redis.hgetall('import_metrics')
    ])

    const [exportQueueLength, importQueueLength] = await Promise.all([
      this.redis.llen('export_queue'),
      this.redis.llen('import_queue')
    ])

    return {
      export: {
        completed: parseInt(exportMetrics.completed || '0'),
        failed: parseInt(exportMetrics.failed || '0'),
        totalDuration: parseInt(exportMetrics.total_duration || '0'),
        averageDuration: exportMetrics.completed > 0 
          ? Math.round(parseInt(exportMetrics.total_duration || '0') / parseInt(exportMetrics.completed))
          : 0,
        queueLength: exportQueueLength
      },
      import: {
        completed: parseInt(importMetrics.completed || '0'),
        failed: parseInt(importMetrics.failed || '0'),
        totalDuration: parseInt(importMetrics.total_duration || '0'),
        averageDuration: importMetrics.completed > 0 
          ? Math.round(parseInt(importMetrics.total_duration || '0') / parseInt(importMetrics.completed))
          : 0,
        queueLength: importQueueLength
      },
      queue: {
        exportLength: exportQueueLength,
        importLength: importQueueLength,
        totalPending: exportQueueLength + importQueueLength
      }
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy'
    details: any
  }> {
    try {
      const metrics = await this.getMetrics()
      
      // Check if queues are backing up
      const totalPending = metrics.queue.totalPending
      const maxQueueLength = 100 // Threshold for degraded status
      const criticalQueueLength = 500 // Threshold for unhealthy status

      // Check error rates
      const exportErrorRate = metrics.export.completed + metrics.export.failed > 0
        ? metrics.export.failed / (metrics.export.completed + metrics.export.failed)
        : 0
        
      const importErrorRate = metrics.import.completed + metrics.import.failed > 0
        ? metrics.import.failed / (metrics.import.completed + metrics.import.failed)
        : 0

      const maxErrorRate = 0.1 // 10% error rate threshold

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      const issues: string[] = []

      if (totalPending > criticalQueueLength) {
        status = 'unhealthy'
        issues.push(`Critical queue backlog: ${totalPending} pending jobs`)
      } else if (totalPending > maxQueueLength) {
        status = 'degraded'
        issues.push(`Queue backlog: ${totalPending} pending jobs`)
      }

      if (exportErrorRate > maxErrorRate) {
        status = status === 'unhealthy' ? 'unhealthy' : 'degraded'
        issues.push(`High export error rate: ${(exportErrorRate * 100).toFixed(1)}%`)
      }

      if (importErrorRate > maxErrorRate) {
        status = status === 'unhealthy' ? 'unhealthy' : 'degraded'
        issues.push(`High import error rate: ${(importErrorRate * 100).toFixed(1)}%`)
      }

      return {
        status,
        details: {
          isRunning: this.isRunning,
          workerCount: this.workers.length,
          metrics,
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
}

// Factory function to create and start worker manager
export async function createExportWorkerManager(config: WorkerConfig): Promise<ExportWorkerManager> {
  const manager = new ExportWorkerManager(config)
  await manager.start()
  return manager
}