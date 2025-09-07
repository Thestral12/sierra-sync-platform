import { Request, Response, NextFunction } from 'express'
import { z, ZodError, ZodSchema } from 'zod'
import DOMPurify from 'isomorphic-dompurify'
import validator from 'validator'
import { logger } from '../utils/logger'

/**
 * Sanitize input to prevent XSS attacks
 */
export function sanitizeInput(input: any): any {
  if (typeof input === 'string') {
    // Remove HTML tags and scripts
    let sanitized = DOMPurify.sanitize(input, { 
      ALLOWED_TAGS: [],
      ALLOWED_ATTR: []
    })
    
    // Escape special characters
    sanitized = validator.escape(sanitized)
    
    // Trim whitespace
    sanitized = sanitized.trim()
    
    return sanitized
  }
  
  if (Array.isArray(input)) {
    return input.map(item => sanitizeInput(item))
  }
  
  if (input && typeof input === 'object') {
    const sanitized: any = {}
    for (const key in input) {
      if (input.hasOwnProperty(key)) {
        // Sanitize the key as well
        const sanitizedKey = sanitizeInput(key)
        sanitized[sanitizedKey] = sanitizeInput(input[key])
      }
    }
    return sanitized
  }
  
  return input
}

/**
 * SQL injection prevention
 */
export function preventSQLInjection(input: string): string {
  // Remove or escape dangerous SQL characters
  const sqlBlacklist = [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE',
    'ALTER', 'EXEC', 'EXECUTE', 'UNION', '--', '/*', '*/',
    'xp_', 'sp_', ';', "'"
  ]
  
  let cleaned = input
  sqlBlacklist.forEach(keyword => {
    const regex = new RegExp(keyword, 'gi')
    cleaned = cleaned.replace(regex, '')
  })
  
  return cleaned
}

/**
 * Validate and sanitize email
 */
export function validateEmail(email: string): string {
  const sanitized = sanitizeInput(email).toLowerCase()
  
  if (!validator.isEmail(sanitized)) {
    throw new Error('Invalid email format')
  }
  
  // Additional checks
  if (sanitized.length > 254) {
    throw new Error('Email too long')
  }
  
  // Check for disposable email domains
  const disposableDomains = ['tempmail.com', '10minutemail.com', 'guerrillamail.com']
  const domain = sanitized.split('@')[1]
  if (disposableDomains.includes(domain)) {
    throw new Error('Disposable email addresses are not allowed')
  }
  
  return sanitized
}

/**
 * Validate and sanitize phone number
 */
export function validatePhone(phone: string): string {
  const sanitized = sanitizeInput(phone)
  
  // Remove all non-numeric characters except + for international
  const cleaned = sanitized.replace(/[^\d+]/g, '')
  
  if (!validator.isMobilePhone(cleaned, 'any')) {
    throw new Error('Invalid phone number')
  }
  
  return cleaned
}

/**
 * Validate URL
 */
export function validateURL(url: string): string {
  const sanitized = sanitizeInput(url)
  
  if (!validator.isURL(sanitized, {
    protocols: ['http', 'https'],
    require_protocol: true,
    require_valid_protocol: true,
    require_host: true,
    require_tld: true
  })) {
    throw new Error('Invalid URL format')
  }
  
  // Check for local/internal URLs
  const blacklistedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '192.168', '10.', '172.']
  const urlObj = new URL(sanitized)
  if (blacklistedHosts.some(host => urlObj.hostname.includes(host))) {
    throw new Error('Internal URLs are not allowed')
  }
  
  return sanitized
}

/**
 * Common validation schemas
 */
export const commonSchemas = {
  // User registration schema
  userRegistration: z.object({
    email: z.string().email().max(254),
    password: z.string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number')
      .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
    fullName: z.string().min(2).max(100),
    organizationName: z.string().min(2).max(100).optional()
  }),

  // Lead creation schema
  leadCreation: z.object({
    firstName: z.string().min(1).max(50),
    lastName: z.string().min(1).max(50),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    leadSource: z.string().max(100),
    leadScore: z.number().min(0).max(100).optional(),
    propertyInterests: z.array(z.string()).optional(),
    customFields: z.record(z.any()).optional()
  }),

  // CRM integration schema
  crmIntegration: z.object({
    crmType: z.enum(['hubspot', 'salesforce', 'zoho', 'pipedrive', 'monday']),
    name: z.string().min(1).max(100),
    apiKey: z.string().optional(),
    oauthTokens: z.object({
      accessToken: z.string(),
      refreshToken: z.string().optional(),
      expiresAt: z.string().datetime().optional()
    }).optional(),
    fieldMappings: z.record(z.string()).optional(),
    syncSettings: z.object({
      syncDirection: z.enum(['bidirectional', 'sierra-to-crm', 'crm-to-sierra']),
      syncFrequency: z.enum(['realtime', 'hourly', 'daily']),
      autoSync: z.boolean()
    }).optional()
  }),

  // Webhook payload schema
  webhookPayload: z.object({
    event: z.enum(['lead.created', 'lead.updated', 'lead.deleted', 'deal.created', 'deal.updated']),
    data: z.record(z.any()),
    timestamp: z.string().datetime(),
    signature: z.string().optional()
  }),

  // Pagination schema
  pagination: z.object({
    page: z.number().min(1).default(1),
    limit: z.number().min(1).max(100).default(20),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).default('desc')
  })
}

/**
 * Validation middleware factory
 */
export function validate(schema: ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Sanitize input first
      req.body = sanitizeInput(req.body)
      req.query = sanitizeInput(req.query)
      req.params = sanitizeInput(req.params)
      
      // Validate against schema
      const validated = await schema.parseAsync(req.body)
      req.body = validated
      
      next()
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }))
        
        logger.warn('Validation failed:', { errors, body: req.body })
        
        return res.status(400).json({
          error: 'Validation failed',
          details: errors
        })
      }
      
      logger.error('Validation error:', error)
      return res.status(500).json({ error: 'Internal validation error' })
    }
  }
}

/**
 * File upload validation
 */
export const validateFileUpload = (options: {
  maxSize?: number // in bytes
  allowedTypes?: string[]
  allowedExtensions?: string[]
}) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.file && !req.files) {
      return next()
    }
    
    const files = req.files ? (Array.isArray(req.files) ? req.files : [req.files]) : [req.file]
    
    for (const file of files) {
      if (!file) continue
      
      // Check file size
      if (options.maxSize && file.size > options.maxSize) {
        return res.status(400).json({
          error: `File size exceeds maximum allowed size of ${options.maxSize} bytes`
        })
      }
      
      // Check file type
      if (options.allowedTypes && !options.allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({
          error: `File type ${file.mimetype} is not allowed`
        })
      }
      
      // Check file extension
      if (options.allowedExtensions) {
        const extension = file.originalname.split('.').pop()?.toLowerCase()
        if (!extension || !options.allowedExtensions.includes(extension)) {
          return res.status(400).json({
            error: `File extension .${extension} is not allowed`
          })
        }
      }
      
      // Scan for malicious content (basic check)
      const maliciousPatterns = [
        /<script/i,
        /javascript:/i,
        /on\w+=/i, // Event handlers
        /<iframe/i,
        /<object/i,
        /<embed/i
      ]
      
      // Only check text files
      if (file.mimetype.startsWith('text/')) {
        const content = file.buffer.toString()
        for (const pattern of maliciousPatterns) {
          if (pattern.test(content)) {
            return res.status(400).json({
              error: 'File contains potentially malicious content'
            })
          }
        }
      }
    }
    
    next()
  }
}

/**
 * CSRF Protection Middleware
 */
export class CSRFProtection {
  private readonly tokenLength = 32
  private readonly tokenExpiry = 3600000 // 1 hour
  
  generateToken(): string {
    const crypto = require('crypto')
    return crypto.randomBytes(this.tokenLength).toString('hex')
  }
  
  async storeToken(sessionId: string, token: string): Promise<void> {
    const { redisClient } = require('./rateLimiter')
    await redisClient.setex(
      `csrf:${sessionId}`,
      this.tokenExpiry / 1000,
      token
    )
  }
  
  async validateToken(sessionId: string, token: string): Promise<boolean> {
    const { redisClient } = require('./rateLimiter')
    const storedToken = await redisClient.get(`csrf:${sessionId}`)
    return storedToken === token
  }
  
  middleware() {
    return async (req: Request & { user?: any }, res: Response, next: NextFunction) => {
      // Skip CSRF for safe methods
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next()
      }
      
      // Skip for API key authentication
      if (req.headers['x-api-key']) {
        return next()
      }
      
      const token = req.headers['x-csrf-token'] as string || req.body._csrf
      const sessionId = req.user?.sessionId || req.sessionID
      
      if (!token || !sessionId) {
        return res.status(403).json({ error: 'CSRF token missing' })
      }
      
      const isValid = await this.validateToken(sessionId, token)
      if (!isValid) {
        logger.warn('CSRF validation failed', { sessionId, token })
        return res.status(403).json({ error: 'Invalid CSRF token' })
      }
      
      next()
    }
  }
}

/**
 * Content Security Policy middleware
 */
export function contentSecurityPolicy() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; " +
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "img-src 'self' data: https:; " +
      "font-src 'self' data: https://fonts.gstatic.com; " +
      "connect-src 'self' https://api.sierrainteractive.com https://*.supabase.co; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self';"
    )
    next()
  }
}

export const csrfProtection = new CSRFProtection()