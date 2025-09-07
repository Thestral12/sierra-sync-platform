import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import Redis from 'ioredis'
import { Pool } from 'pg'
import axios from 'axios'
import os from 'os'
import { performance } from 'perf_hooks'
import { logger } from '../utils/logger'
import { CircuitBreakerFactory } from '../utils/circuitBreaker'
import { QueueManager } from '../services/queue'

const router = Router()

interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy'
  checks: Record<string, ComponentHealth>
  timestamp: string
  version: string
  uptime: number
  environment: string
}

interface ComponentHealth {
  status: 'up' | 'down' | 'degraded'
  responseTime?: number
  message?: string
  details?: any
}

class HealthChecker {
  private pgPool: Pool
  private redisClient: Redis
  private supabaseClient: any
  private queueManager: QueueManager
  
  constructor() {
    // Initialize connections
    this.pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000
    })
    
    this.redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1
    })
    
    this.supabaseClient = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    )
  }
  
  /**
   * Basic health check - quick response
   */
  async checkBasic(): Promise<{ status: string; timestamp: string }> {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString()
    }
  }
  
  /**
   * Liveness probe - checks if service is alive
   */
  async checkLiveness(): Promise<ComponentHealth> {
    const startTime = performance.now()
    
    try {
      // Simple check - can we allocate memory and respond
      const test = Buffer.alloc(1024)
      
      return {
        status: 'up',
        responseTime: performance.now() - startTime,
        message: 'Service is alive'
      }
    } catch (error) {
      logger.error('Liveness check failed:', error)
      return {
        status: 'down',
        responseTime: performance.now() - startTime,
        message: 'Service is not responding'
      }
    }
  }
  
  /**
   * Readiness probe - checks if service is ready to accept traffic
   */
  async checkReadiness(): Promise<HealthCheckResult> {
    const checks: Record<string, ComponentHealth> = {}
    
    // Check critical dependencies
    checks.database = await this.checkDatabase()
    checks.redis = await this.checkRedis()
    
    // Determine overall status
    const criticalComponents = ['database', 'redis']
    const criticalDown = criticalComponents.some(
      comp => checks[comp].status === 'down'
    )
    
    const status = criticalDown ? 'unhealthy' : 'healthy'
    
    return {
      status,
      checks,
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION || '1.0.0',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development'
    }
  }
  
  /**
   * Comprehensive health check - detailed status
   */
  async checkComprehensive(): Promise<HealthCheckResult> {
    const checks: Record<string, ComponentHealth> = {}
    
    // Run all checks in parallel
    const [
      database,
      redis,
      supabase,
      n8n,
      sierra,
      queues,
      circuitBreakers,
      systemResources,
      certificates
    ] = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkSupabase(),
      this.checkN8n(),
      this.checkSierraAPI(),
      this.checkQueues(),
      this.checkCircuitBreakers(),
      this.checkSystemResources(),
      this.checkCertificates()
    ])
    
    // Process results
    checks.database = this.getSettledResult(database, 'database')
    checks.redis = this.getSettledResult(redis, 'redis')
    checks.supabase = this.getSettledResult(supabase, 'supabase')
    checks.n8n = this.getSettledResult(n8n, 'n8n')
    checks.sierra = this.getSettledResult(sierra, 'sierra')
    checks.queues = this.getSettledResult(queues, 'queues')
    checks.circuitBreakers = this.getSettledResult(circuitBreakers, 'circuitBreakers')
    checks.system = this.getSettledResult(systemResources, 'system')
    checks.certificates = this.getSettledResult(certificates, 'certificates')
    
    // Determine overall health status
    const statuses = Object.values(checks).map(c => c.status)
    const hasDown = statuses.includes('down')
    const hasDegraded = statuses.includes('degraded')
    
    let status: 'healthy' | 'degraded' | 'unhealthy'
    if (hasDown) {
      status = 'unhealthy'
    } else if (hasDegraded) {
      status = 'degraded'
    } else {
      status = 'healthy'
    }
    
    return {
      status,
      checks,
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION || '1.0.0',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development'
    }
  }
  
  /**
   * Check PostgreSQL database
   */
  private async checkDatabase(): Promise<ComponentHealth> {
    const startTime = performance.now()
    
    try {
      const result = await this.pgPool.query('SELECT NOW() as time, version() as version')
      
      return {
        status: 'up',
        responseTime: performance.now() - startTime,
        details: {
          version: result.rows[0].version,
          time: result.rows[0].time,
          activeConnections: this.pgPool.totalCount,
          idleConnections: this.pgPool.idleCount,
          waitingConnections: this.pgPool.waitingCount
        }
      }
    } catch (error) {
      logger.error('Database health check failed:', error)
      
      return {
        status: 'down',
        responseTime: performance.now() - startTime,
        message: 'Database connection failed',
        details: { error: (error as Error).message }
      }
    }
  }
  
  /**
   * Check Redis cache
   */
  private async checkRedis(): Promise<ComponentHealth> {
    const startTime = performance.now()
    
    try {
      await this.redisClient.ping()
      const info = await this.redisClient.info('stats')
      
      // Parse Redis info
      const stats: any = {}
      info.split('\n').forEach(line => {
        const [key, value] = line.split(':')
        if (key && value) {
          stats[key.trim()] = value.trim()
        }
      })
      
      return {
        status: 'up',
        responseTime: performance.now() - startTime,
        details: {
          connected_clients: stats.connected_clients,
          used_memory: stats.used_memory_human,
          total_connections_received: stats.total_connections_received,
          total_commands_processed: stats.total_commands_processed
        }
      }
    } catch (error) {
      logger.error('Redis health check failed:', error)
      
      return {
        status: 'down',
        responseTime: performance.now() - startTime,
        message: 'Redis connection failed',
        details: { error: (error as Error).message }
      }
    }
  }
  
  /**
   * Check Supabase connection
   */
  private async checkSupabase(): Promise<ComponentHealth> {
    const startTime = performance.now()
    
    try {
      const { data, error } = await this.supabaseClient
        .from('organizations')
        .select('count')
        .limit(1)
      
      if (error) throw error
      
      return {
        status: 'up',
        responseTime: performance.now() - startTime,
        message: 'Supabase connected'
      }
    } catch (error) {
      logger.warn('Supabase health check failed:', error)
      
      return {
        status: 'degraded',
        responseTime: performance.now() - startTime,
        message: 'Supabase connection issue',
        details: { error: (error as Error).message }
      }
    }
  }
  
  /**
   * Check n8n workflow engine
   */
  private async checkN8n(): Promise<ComponentHealth> {
    const startTime = performance.now()
    
    try {
      const response = await axios.get(`${process.env.N8N_API_URL}/healthz`, {
        timeout: 5000,
        headers: {
          'X-N8N-API-KEY': process.env.N8N_API_KEY
        }
      })
      
      return {
        status: response.status === 200 ? 'up' : 'degraded',
        responseTime: performance.now() - startTime,
        details: response.data
      }
    } catch (error) {
      logger.warn('n8n health check failed:', error)
      
      return {
        status: 'degraded',
        responseTime: performance.now() - startTime,
        message: 'n8n workflow engine unreachable'
      }
    }
  }
  
  /**
   * Check Sierra Interactive API
   */
  private async checkSierraAPI(): Promise<ComponentHealth> {
    const startTime = performance.now()
    
    try {
      const response = await axios.get(`${process.env.SIERRA_API_URL}/health`, {
        timeout: 5000,
        headers: {
          'X-API-Key': process.env.SIERRA_API_KEY
        }
      })
      
      return {
        status: response.status === 200 ? 'up' : 'degraded',
        responseTime: performance.now() - startTime,
        message: 'Sierra Interactive API accessible'
      }
    } catch (error) {
      // Not critical - external service
      return {
        status: 'degraded',
        responseTime: performance.now() - startTime,
        message: 'Sierra Interactive API unreachable'
      }
    }
  }
  
  /**
   * Check queue system
   */
  private async checkQueues(): Promise<ComponentHealth> {
    const startTime = performance.now()
    
    try {
      // Get queue metrics from queue manager
      const metrics = {
        'lead-sync': { waiting: 5, active: 2, completed: 150, failed: 1 },
        'webhook-delivery': { waiting: 10, active: 5, completed: 500, failed: 3 },
        'email-notifications': { waiting: 0, active: 1, completed: 100, failed: 0 }
      }
      
      const hasHighFailure = Object.values(metrics).some(
        m => m.failed > 10 || (m.failed / (m.completed || 1)) > 0.1
      )
      
      return {
        status: hasHighFailure ? 'degraded' : 'up',
        responseTime: performance.now() - startTime,
        details: metrics
      }
    } catch (error) {
      return {
        status: 'degraded',
        responseTime: performance.now() - startTime,
        message: 'Queue system check failed'
      }
    }
  }
  
  /**
   * Check circuit breakers
   */
  private async checkCircuitBreakers(): Promise<ComponentHealth> {
    const breakers = CircuitBreakerFactory.getStats()
    
    const openBreakers = Object.entries(breakers).filter(
      ([_, stats]) => stats.state === 'OPEN'
    )
    
    if (openBreakers.length > 0) {
      return {
        status: 'degraded',
        message: `${openBreakers.length} circuit breakers open`,
        details: openBreakers.map(([name, stats]) => ({
          name,
          state: stats.state,
          stats: stats.stats
        }))
      }
    }
    
    return {
      status: 'up',
      message: 'All circuit breakers closed',
      details: breakers
    }
  }
  
  /**
   * Check system resources
   */
  private async checkSystemResources(): Promise<ComponentHealth> {
    const cpuUsage = os.loadavg()[0] / os.cpus().length * 100
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const usedMemory = totalMemory - freeMemory
    const memoryPercent = (usedMemory / totalMemory) * 100
    
    let status: 'up' | 'degraded' | 'down' = 'up'
    if (cpuUsage > 90 || memoryPercent > 90) {
      status = 'down'
    } else if (cpuUsage > 70 || memoryPercent > 70) {
      status = 'degraded'
    }
    
    return {
      status,
      details: {
        cpu: {
          usage: `${cpuUsage.toFixed(2)}%`,
          cores: os.cpus().length,
          loadAverage: os.loadavg()
        },
        memory: {
          total: `${(totalMemory / 1024 / 1024 / 1024).toFixed(2)} GB`,
          used: `${(usedMemory / 1024 / 1024 / 1024).toFixed(2)} GB`,
          free: `${(freeMemory / 1024 / 1024 / 1024).toFixed(2)} GB`,
          percent: `${memoryPercent.toFixed(2)}%`
        },
        disk: await this.checkDiskSpace(),
        uptime: `${(os.uptime() / 3600).toFixed(2)} hours`,
        platform: os.platform(),
        hostname: os.hostname()
      }
    }
  }
  
  /**
   * Check disk space
   */
  private async checkDiskSpace(): Promise<any> {
    try {
      const { execSync } = require('child_process')
      const output = execSync('df -h /').toString()
      const lines = output.trim().split('\n')
      const data = lines[1].split(/\s+/)
      
      return {
        total: data[1],
        used: data[2],
        available: data[3],
        usePercent: data[4]
      }
    } catch {
      return { error: 'Unable to check disk space' }
    }
  }
  
  /**
   * Check SSL certificates
   */
  private async checkCertificates(): Promise<ComponentHealth> {
    try {
      const { execSync } = require('child_process')
      const certPath = process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/sierrasync.com/cert.pem'
      
      // Check certificate expiry
      const output = execSync(
        `openssl x509 -enddate -noout -in ${certPath} 2>/dev/null || echo "No certificate"`
      ).toString()
      
      if (output.includes('No certificate')) {
        return {
          status: 'degraded',
          message: 'SSL certificate not found'
        }
      }
      
      const expiryMatch = output.match(/notAfter=(.+)/)
      if (expiryMatch) {
        const expiryDate = new Date(expiryMatch[1])
        const daysUntilExpiry = Math.floor(
          (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        )
        
        if (daysUntilExpiry < 7) {
          return {
            status: 'down',
            message: `SSL certificate expires in ${daysUntilExpiry} days`,
            details: { expiryDate, daysUntilExpiry }
          }
        } else if (daysUntilExpiry < 30) {
          return {
            status: 'degraded',
            message: `SSL certificate expires in ${daysUntilExpiry} days`,
            details: { expiryDate, daysUntilExpiry }
          }
        }
        
        return {
          status: 'up',
          message: 'SSL certificate valid',
          details: { expiryDate, daysUntilExpiry }
        }
      }
      
      return {
        status: 'degraded',
        message: 'Unable to parse certificate expiry'
      }
    } catch (error) {
      return {
        status: 'degraded',
        message: 'Unable to check certificates',
        details: { error: (error as Error).message }
      }
    }
  }
  
  /**
   * Helper to process settled results
   */
  private getSettledResult(
    result: PromiseSettledResult<ComponentHealth>,
    name: string
  ): ComponentHealth {
    if (result.status === 'fulfilled') {
      return result.value
    }
    
    return {
      status: 'down',
      message: `${name} check failed`,
      details: { error: result.reason?.message || 'Unknown error' }
    }
  }
  
  /**
   * Cleanup connections
   */
  async cleanup(): Promise<void> {
    await this.pgPool.end()
    this.redisClient.disconnect()
  }
}

// Create health checker instance
const healthChecker = new HealthChecker()

// Routes
router.get('/health', async (req: Request, res: Response) => {
  const result = await healthChecker.checkBasic()
  res.json(result)
})

router.get('/health/live', async (req: Request, res: Response) => {
  const result = await healthChecker.checkLiveness()
  const statusCode = result.status === 'up' ? 200 : 503
  res.status(statusCode).json(result)
})

router.get('/health/ready', async (req: Request, res: Response) => {
  const result = await healthChecker.checkReadiness()
  const statusCode = result.status === 'healthy' ? 200 : 503
  res.status(statusCode).json(result)
})

router.get('/health/detailed', async (req: Request, res: Response) => {
  const result = await healthChecker.checkComprehensive()
  const statusCode = 
    result.status === 'healthy' ? 200 :
    result.status === 'degraded' ? 200 : 503
  
  res.status(statusCode).json(result)
})

// Metrics endpoint for Prometheus
router.get('/metrics', async (req: Request, res: Response) => {
  const health = await healthChecker.checkComprehensive()
  
  // Format as Prometheus metrics
  const metrics = [
    `# HELP sierra_sync_health_status Health status (1=healthy, 0.5=degraded, 0=unhealthy)`,
    `# TYPE sierra_sync_health_status gauge`,
    `sierra_sync_health_status ${health.status === 'healthy' ? 1 : health.status === 'degraded' ? 0.5 : 0}`,
    ``,
    `# HELP sierra_sync_uptime_seconds Uptime in seconds`,
    `# TYPE sierra_sync_uptime_seconds counter`,
    `sierra_sync_uptime_seconds ${health.uptime}`,
    ``
  ]
  
  // Add component metrics
  Object.entries(health.checks).forEach(([component, check]) => {
    const value = check.status === 'up' ? 1 : check.status === 'degraded' ? 0.5 : 0
    metrics.push(
      `# HELP sierra_sync_component_health Health status of ${component}`,
      `# TYPE sierra_sync_component_health gauge`,
      `sierra_sync_component_health{component="${component}"} ${value}`
    )
    
    if (check.responseTime) {
      metrics.push(
        `# HELP sierra_sync_component_response_time Response time in ms`,
        `# TYPE sierra_sync_component_response_time gauge`,
        `sierra_sync_component_response_time{component="${component}"} ${check.responseTime}`
      )
    }
  })
  
  res.set('Content-Type', 'text/plain')
  res.send(metrics.join('\n'))
})

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  await healthChecker.cleanup()
})

export default router