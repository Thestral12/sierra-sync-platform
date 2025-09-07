import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { Logtail } from '@logtail/node'
import { LogtailTransport } from '@logtail/winston'
import path from 'path'
import fs from 'fs'
import { hostname } from 'os'

// Ensure log directory exists
const logDir = process.env.LOG_FILE_PATH || '/var/log/sierra-sync'
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}

// Custom log levels
const logLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    verbose: 'cyan',
    debug: 'blue',
    silly: 'gray'
  }
}

// Add colors to winston
winston.addColors(logLevels.colors)

// Custom format for structured logging
const structuredFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  const log = {
    timestamp,
    level,
    message,
    hostname: hostname(),
    environment: process.env.NODE_ENV || 'development',
    service: 'sierra-sync-api',
    ...metadata
  }
  
  // Add request context if available
  if (metadata.req) {
    log.request = {
      method: metadata.req.method,
      url: metadata.req.url,
      ip: metadata.req.ip,
      userAgent: metadata.req.get('user-agent')
    }
    delete metadata.req
  }
  
  // Add error details if present
  if (metadata.error) {
    log.error = {
      message: metadata.error.message,
      stack: metadata.error.stack,
      code: metadata.error.code
    }
    delete metadata.error
  }
  
  return JSON.stringify(log)
})

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let log = `${timestamp} [${level}]: ${message}`
    
    // Add metadata if present
    if (Object.keys(metadata).length > 0) {
      log += ` ${JSON.stringify(metadata, null, 2)}`
    }
    
    return log
  })
)

// Create transports array
const transports: winston.transport[] = []

// Console transport
if (process.env.LOG_OUTPUT !== 'file') {
  transports.push(
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' ? structuredFormat : consoleFormat,
      level: process.env.LOG_LEVEL || 'info'
    })
  )
}

// File transport with rotation
if (process.env.LOG_OUTPUT !== 'stdout') {
  // Error log file
  transports.push(
    new DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        structuredFormat
      )
    })
  )
  
  // Combined log file
  transports.push(
    new DailyRotateFile({
      filename: path.join(logDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        structuredFormat
      )
    })
  )
  
  // Audit log file for security events
  transports.push(
    new DailyRotateFile({
      filename: path.join(logDir, 'audit-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'info',
      maxSize: '20m',
      maxFiles: '90d', // Keep audit logs longer
      format: winston.format.combine(
        winston.format.timestamp(),
        structuredFormat
      ),
      // Filter only audit events
      filter: (info) => info.audit === true
    })
  )
}

// Logtail transport for cloud logging (if configured)
if (process.env.LOGTAIL_SOURCE_TOKEN) {
  const logtail = new Logtail(process.env.LOGTAIL_SOURCE_TOKEN)
  transports.push(new LogtailTransport(logtail))
}

// Create logger instance
const logger = winston.createLogger({
  levels: logLevels.levels,
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] })
  ),
  transports,
  exitOnError: false
})

// Handle uncaught exceptions and rejections
logger.exceptions.handle(
  new winston.transports.File({ 
    filename: path.join(logDir, 'exceptions.log'),
    format: structuredFormat
  })
)

logger.rejections.handle(
  new winston.transports.File({ 
    filename: path.join(logDir, 'rejections.log'),
    format: structuredFormat
  })
)

/**
 * Audit logger for security events
 */
export class AuditLogger {
  static log(event: {
    action: string
    userId?: string
    organizationId?: string
    resource?: string
    resourceId?: string
    result: 'success' | 'failure'
    metadata?: any
  }): void {
    logger.info('Audit Event', {
      audit: true,
      ...event,
      timestamp: new Date().toISOString(),
      ip: event.metadata?.ip,
      userAgent: event.metadata?.userAgent
    })
  }
  
  static logAuth(event: {
    action: 'login' | 'logout' | 'register' | 'password_reset' | 'token_refresh'
    userId?: string
    email?: string
    success: boolean
    reason?: string
    ip?: string
    userAgent?: string
  }): void {
    this.log({
      action: `auth.${event.action}`,
      userId: event.userId,
      result: event.success ? 'success' : 'failure',
      metadata: {
        email: event.email,
        reason: event.reason,
        ip: event.ip,
        userAgent: event.userAgent
      }
    })
  }
  
  static logDataAccess(event: {
    action: 'read' | 'write' | 'delete'
    userId: string
    resource: string
    resourceId: string
    success: boolean
    reason?: string
  }): void {
    this.log({
      action: `data.${event.action}`,
      userId: event.userId,
      resource: event.resource,
      resourceId: event.resourceId,
      result: event.success ? 'success' : 'failure',
      metadata: { reason: event.reason }
    })
  }
  
  static logApiAccess(event: {
    method: string
    path: string
    userId?: string
    apiKey?: string
    statusCode: number
    duration: number
    ip: string
  }): void {
    this.log({
      action: 'api.access',
      userId: event.userId,
      resource: event.path,
      result: event.statusCode < 400 ? 'success' : 'failure',
      metadata: {
        method: event.method,
        apiKey: event.apiKey ? `${event.apiKey.slice(0, 8)}...` : undefined,
        statusCode: event.statusCode,
        duration: event.duration,
        ip: event.ip
      }
    })
  }
}

/**
 * Performance logger for slow operations
 */
export class PerformanceLogger {
  private static slowQueryThreshold = 1000 // 1 second
  private static slowApiThreshold = 5000 // 5 seconds
  private static slowJobThreshold = 30000 // 30 seconds
  
  static logSlowQuery(query: string, duration: number, params?: any): void {
    if (duration > this.slowQueryThreshold) {
      logger.warn('Slow database query detected', {
        performance: true,
        query: query.slice(0, 500), // Truncate long queries
        duration,
        params: params ? JSON.stringify(params).slice(0, 200) : undefined,
        threshold: this.slowQueryThreshold
      })
    }
  }
  
  static logSlowApi(
    service: string,
    endpoint: string,
    duration: number,
    statusCode?: number
  ): void {
    if (duration > this.slowApiThreshold) {
      logger.warn('Slow API call detected', {
        performance: true,
        service,
        endpoint,
        duration,
        statusCode,
        threshold: this.slowApiThreshold
      })
    }
  }
  
  static logSlowJob(
    queue: string,
    jobName: string,
    duration: number,
    success: boolean
  ): void {
    if (duration > this.slowJobThreshold) {
      logger.warn('Slow job execution detected', {
        performance: true,
        queue,
        jobName,
        duration,
        success,
        threshold: this.slowJobThreshold
      })
    }
  }
}

/**
 * Request logger middleware
 */
export function requestLogger(req: any, res: any, next: any): void {
  const startTime = Date.now()
  
  // Log request
  logger.http('Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('user-agent')
  })
  
  // Log response
  const originalSend = res.send
  res.send = function(data: any): any {
    res.send = originalSend
    
    const duration = Date.now() - startTime
    const logLevel = res.statusCode >= 400 ? 'warn' : 'http'
    
    logger[logLevel]('Request completed', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration,
      ip: req.ip,
      userId: req.user?.id
    })
    
    // Audit log for API access
    AuditLogger.logApiAccess({
      method: req.method,
      path: req.path,
      userId: req.user?.id,
      apiKey: req.headers['x-api-key'],
      statusCode: res.statusCode,
      duration,
      ip: req.ip
    })
    
    return res.send(data)
  }
  
  next()
}

/**
 * Error logger middleware
 */
export function errorLogger(err: any, req: any, res: any, next: any): void {
  logger.error('Request error', {
    error: {
      message: err.message,
      stack: err.stack,
      code: err.code,
      statusCode: err.statusCode || 500
    },
    request: {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userId: req.user?.id
    }
  })
  
  next(err)
}

/**
 * Child logger factory for service-specific logging
 */
export function createServiceLogger(service: string): winston.Logger {
  return logger.child({ service })
}

// Export logger instance
export { logger }

// Log startup
logger.info('Logger initialized', {
  level: logger.level,
  transports: transports.map(t => t.constructor.name),
  environment: process.env.NODE_ENV,
  logDir
})