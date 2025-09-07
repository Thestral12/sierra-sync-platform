import * as Sentry from '@sentry/node'
import { ProfilingIntegration } from '@sentry/profiling-node'
import { CaptureConsole } from '@sentry/integrations'
import { Application, Request, Response, NextFunction } from 'express'
import { logger } from './logger'
import os from 'os'
import { performance } from 'perf_hooks'

interface MetricData {
  value: number
  unit: string
  tags?: Record<string, string>
}

interface TransactionContext {
  name: string
  op: string
  data?: Record<string, any>
}

/**
 * Initialize Sentry monitoring
 */
export function initializeSentry(app: Application): void {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    integrations: [
      // Enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
      // Enable Express.js middleware tracing
      new Sentry.Integrations.Express({ app }),
      // Enable profiling
      new ProfilingIntegration(),
      // Capture console errors
      new CaptureConsole({
        levels: ['error', 'warn']
      }),
      // Prisma integration if using Prisma
      new Sentry.Integrations.Prisma({ client: true })
    ],
    
    // Performance Monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    
    // Release tracking
    release: process.env.SENTRY_RELEASE || 'sierra-sync@1.0.0',
    
    // Server name
    serverName: os.hostname(),
    
    // Filtering
    beforeSend(event, hint) {
      // Filter out sensitive data
      if (event.request) {
        // Remove sensitive headers
        const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key']
        sensitiveHeaders.forEach(header => {
          if (event.request.headers?.[header]) {
            event.request.headers[header] = '[REDACTED]'
          }
        })
        
        // Remove sensitive body fields
        if (event.request.data) {
          const sensitiveFields = ['password', 'apiKey', 'secret', 'token', 'creditCard']
          const data = event.request.data as any
          sensitiveFields.forEach(field => {
            if (data[field]) {
              data[field] = '[REDACTED]'
            }
          })
        }
      }
      
      // Filter out non-critical errors in development
      if (process.env.NODE_ENV !== 'production') {
        const error = hint.originalException as Error
        if (error?.message?.includes('ECONNREFUSED')) {
          return null // Don't send connection errors in dev
        }
      }
      
      return event
    },
    
    // Breadcrumbs configuration
    beforeBreadcrumb(breadcrumb) {
      // Filter out noisy breadcrumbs
      if (breadcrumb.category === 'console' && breadcrumb.level === 'debug') {
        return null
      }
      return breadcrumb
    },
    
    // Auto session tracking
    autoSessionTracking: true,
    
    // Attachments
    attachStacktrace: true,
    
    // Sample rate for errors
    sampleRate: process.env.NODE_ENV === 'production' ? 0.9 : 1.0
  })

  // Sentry request handler
  app.use(Sentry.Handlers.requestHandler())
  
  // Sentry tracing handler
  app.use(Sentry.Handlers.tracingHandler())
}

/**
 * Sentry error handler middleware (should be used after all other middleware)
 */
export function sentryErrorHandler(): any {
  return Sentry.Handlers.errorHandler({
    shouldHandleError(error) {
      // Capture errors with status code 500 or undefined
      if (!error.status || error.status >= 500) {
        return true
      }
      return false
    }
  })
}

/**
 * Custom error tracking with additional context
 */
export function captureError(
  error: Error,
  context?: {
    user?: { id: string; email?: string }
    tags?: Record<string, string>
    extra?: Record<string, any>
    level?: Sentry.SeverityLevel
  }
): void {
  Sentry.withScope(scope => {
    // Set user context
    if (context?.user) {
      scope.setUser({
        id: context.user.id,
        email: context.user.email
      })
    }
    
    // Set tags
    if (context?.tags) {
      Object.entries(context.tags).forEach(([key, value]) => {
        scope.setTag(key, value)
      })
    }
    
    // Set extra context
    if (context?.extra) {
      Object.entries(context.extra).forEach(([key, value]) => {
        scope.setExtra(key, value)
      })
    }
    
    // Set level
    if (context?.level) {
      scope.setLevel(context.level)
    }
    
    // Add breadcrumb
    scope.addBreadcrumb({
      message: `Error captured: ${error.message}`,
      level: 'error',
      timestamp: Date.now()
    })
    
    Sentry.captureException(error)
  })
  
  // Also log to our logger
  logger.error('Error captured', { error: error.message, stack: error.stack, context })
}

/**
 * Performance monitoring
 */
export class PerformanceMonitor {
  private static transactions: Map<string, any> = new Map()
  
  /**
   * Start a performance transaction
   */
  static startTransaction(context: TransactionContext): string {
    const transaction = Sentry.startTransaction({
      op: context.op,
      name: context.name,
      data: context.data
    })
    
    const transactionId = `${context.op}-${Date.now()}`
    this.transactions.set(transactionId, transaction)
    
    Sentry.getCurrentHub().configureScope(scope => scope.setSpan(transaction))
    
    return transactionId
  }
  
  /**
   * End a performance transaction
   */
  static endTransaction(transactionId: string, status?: string): void {
    const transaction = this.transactions.get(transactionId)
    if (transaction) {
      if (status) {
        transaction.setStatus(status)
      }
      transaction.finish()
      this.transactions.delete(transactionId)
    }
  }
  
  /**
   * Measure operation performance
   */
  static async measureOperation<T>(
    name: string,
    operation: () => Promise<T>,
    tags?: Record<string, string>
  ): Promise<T> {
    const startTime = performance.now()
    const transaction = Sentry.startTransaction({
      op: 'operation',
      name,
      data: { tags }
    })
    
    try {
      const result = await operation()
      transaction.setStatus('ok')
      return result
    } catch (error) {
      transaction.setStatus('internal_error')
      throw error
    } finally {
      const duration = performance.now() - startTime
      transaction.finish()
      
      // Send custom metric
      this.sendMetric(`operation.${name}.duration`, {
        value: duration,
        unit: 'millisecond',
        tags
      })
    }
  }
  
  /**
   * Send custom metric to Sentry
   */
  static sendMetric(name: string, data: MetricData): void {
    const transaction = Sentry.getCurrentHub().getScope()?.getTransaction()
    if (transaction) {
      transaction.setMeasurement(name, data.value, data.unit)
    }
    
    // Also send as breadcrumb for debugging
    Sentry.addBreadcrumb({
      category: 'metric',
      message: name,
      level: 'info',
      data: {
        value: data.value,
        unit: data.unit,
        ...data.tags
      }
    })
  }
}

/**
 * System metrics collector
 */
export class SystemMetrics {
  private static interval: NodeJS.Timeout | null = null
  
  /**
   * Start collecting system metrics
   */
  static startCollection(intervalMs: number = 60000): void {
    if (this.interval) {
      return // Already collecting
    }
    
    this.interval = setInterval(() => {
      this.collectMetrics()
    }, intervalMs)
    
    // Collect immediately
    this.collectMetrics()
  }
  
  /**
   * Stop collecting system metrics
   */
  static stopCollection(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
  
  /**
   * Collect current system metrics
   */
  private static collectMetrics(): void {
    const metrics = {
      // CPU metrics
      cpuUsage: process.cpuUsage(),
      loadAverage: os.loadavg(),
      
      // Memory metrics
      memoryUsage: process.memoryUsage(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      memoryPercent: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
      
      // Process metrics
      uptime: process.uptime(),
      pid: process.pid,
      nodeVersion: process.version,
      
      // System info
      platform: os.platform(),
      cpuCount: os.cpus().length
    }
    
    // Send to Sentry as context
    Sentry.configureScope(scope => {
      scope.setContext('system_metrics', metrics)
    })
    
    // Log high memory usage
    if (metrics.memoryPercent > 80) {
      logger.warn('High memory usage detected', { memoryPercent: metrics.memoryPercent })
      Sentry.captureMessage('High memory usage', 'warning')
    }
    
    // Log high CPU usage
    const cpuPercent = (metrics.loadAverage[0] / metrics.cpuCount) * 100
    if (cpuPercent > 80) {
      logger.warn('High CPU usage detected', { cpuPercent, loadAverage: metrics.loadAverage })
      Sentry.captureMessage('High CPU usage', 'warning')
    }
  }
}

/**
 * Request performance middleware
 */
export function requestPerformanceMiddleware(
  req: Request & { startTime?: number; transaction?: any },
  res: Response,
  next: NextFunction
): void {
  req.startTime = Date.now()
  
  // Start Sentry transaction
  const transaction = Sentry.startTransaction({
    op: 'http.server',
    name: `${req.method} ${req.path}`,
    data: {
      'http.method': req.method,
      'http.url': req.url,
      'http.target': req.path,
      'http.host': req.hostname,
      'http.scheme': req.protocol,
      'http.user_agent': req.get('user-agent'),
      'http.client_ip': req.ip
    }
  })
  
  req.transaction = transaction
  
  // Set transaction on scope
  Sentry.getCurrentHub().configureScope(scope => {
    scope.setSpan(transaction)
  })
  
  // Track response
  const originalSend = res.send
  res.send = function(data: any): Response {
    res.send = originalSend
    
    if (req.startTime) {
      const duration = Date.now() - req.startTime
      
      // Set transaction data
      if (req.transaction) {
        req.transaction.setHttpStatus(res.statusCode)
        req.transaction.setData('http.response.status_code', res.statusCode)
        req.transaction.setMeasurement('http.response_time', duration, 'millisecond')
        req.transaction.finish()
      }
      
      // Log slow requests
      if (duration > 1000) {
        logger.warn('Slow request detected', {
          method: req.method,
          path: req.path,
          duration,
          statusCode: res.statusCode
        })
      }
      
      // Add performance header
      res.set('X-Response-Time', `${duration}ms`)
    }
    
    return res.send(data)
  }
  
  next()
}

/**
 * User activity tracking
 */
export function trackUserActivity(
  userId: string,
  action: string,
  metadata?: Record<string, any>
): void {
  Sentry.addBreadcrumb({
    category: 'user',
    message: `User ${action}`,
    level: 'info',
    data: {
      userId,
      action,
      ...metadata
    }
  })
  
  // Track in analytics
  PerformanceMonitor.sendMetric(`user.${action}`, {
    value: 1,
    unit: 'none',
    tags: { userId }
  })
}

/**
 * API call tracking
 */
export function trackAPICall(
  service: string,
  endpoint: string,
  duration: number,
  success: boolean,
  statusCode?: number
): void {
  const metricName = `api.${service}.${endpoint.replace(/\//g, '_')}`
  
  PerformanceMonitor.sendMetric(`${metricName}.duration`, {
    value: duration,
    unit: 'millisecond',
    tags: {
      service,
      endpoint,
      success: success.toString(),
      statusCode: statusCode?.toString() || 'unknown'
    }
  })
  
  if (!success) {
    Sentry.captureMessage(`API call failed: ${service} ${endpoint}`, 'warning')
  }
  
  // Log slow API calls
  if (duration > 5000) {
    logger.warn('Slow API call detected', {
      service,
      endpoint,
      duration,
      success
    })
  }
}