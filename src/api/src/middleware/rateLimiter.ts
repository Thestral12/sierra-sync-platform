import { Request, Response, NextFunction } from 'express'
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible'
import Redis from 'ioredis'
import { logger } from '../utils/logger'

// Redis client for rate limiting
const redisClient = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 3
})

// Different rate limit tiers
const rateLimitTiers = {
  free: {
    points: 100, // Number of requests
    duration: 60, // Per 60 seconds
    blockDuration: 60 // Block for 60 seconds
  },
  starter: {
    points: 500,
    duration: 60,
    blockDuration: 30
  },
  professional: {
    points: 2000,
    duration: 60,
    blockDuration: 10
  },
  enterprise: {
    points: 10000,
    duration: 60,
    blockDuration: 5
  }
}

// API endpoint-specific limits
const endpointLimits = {
  '/api/auth/login': {
    points: 5,
    duration: 900, // 15 minutes
    blockDuration: 900 // Block for 15 minutes after 5 failed attempts
  },
  '/api/auth/register': {
    points: 3,
    duration: 3600, // 1 hour
    blockDuration: 3600
  },
  '/api/sync/trigger': {
    points: 10,
    duration: 60,
    blockDuration: 60
  },
  '/api/webhooks/*': {
    points: 1000,
    duration: 60,
    blockDuration: 10
  }
}

// Create rate limiters for each tier
const rateLimiters: Record<string, RateLimiterRedis> = {}

Object.entries(rateLimitTiers).forEach(([tier, config]) => {
  rateLimiters[tier] = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: `rate_limit_${tier}`,
    points: config.points,
    duration: config.duration,
    blockDuration: config.blockDuration,
    execEvenly: true // Spread requests evenly
  })
})

// Create rate limiters for specific endpoints
const endpointRateLimiters: Record<string, RateLimiterRedis> = {}

Object.entries(endpointLimits).forEach(([endpoint, config]) => {
  endpointRateLimiters[endpoint] = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: `rate_limit_endpoint_${endpoint.replace(/\//g, '_')}`,
    points: config.points,
    duration: config.duration,
    blockDuration: config.blockDuration
  })
})

// Global rate limiter (DDoS protection)
const globalRateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'rate_limit_global',
  points: 10000, // 10,000 requests
  duration: 60, // Per minute
  blockDuration: 600 // Block for 10 minutes
})

/**
 * Get user tier from database or cache
 */
async function getUserTier(organizationId: string): Promise<string> {
  try {
    // Check cache first
    const cached = await redisClient.get(`org_tier:${organizationId}`)
    if (cached) return cached

    // Fetch from database
    const { createClient } = require('@supabase/supabase-js')
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    )

    const { data, error } = await supabase
      .from('organizations')
      .select('subscription_tier')
      .eq('id', organizationId)
      .single()

    if (error || !data) {
      return 'free'
    }

    // Cache for 5 minutes
    await redisClient.setex(`org_tier:${organizationId}`, 300, data.subscription_tier)
    
    return data.subscription_tier
  } catch (error) {
    logger.error('Failed to get user tier:', error)
    return 'free'
  }
}

/**
 * Main rate limiting middleware
 */
export const rateLimiter = async (
  req: Request & { user?: any },
  res: Response,
  next: NextFunction
) => {
  try {
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'
    const endpoint = req.path
    const method = req.method

    // Global rate limiting by IP
    try {
      await globalRateLimiter.consume(ipAddress)
    } catch (rejRes) {
      return handleRateLimitExceeded(res, rejRes as RateLimiterRes, 'global')
    }

    // Endpoint-specific rate limiting
    const endpointKey = Object.keys(endpointLimits).find(key => {
      if (key.includes('*')) {
        const pattern = key.replace('*', '.*')
        return new RegExp(pattern).test(endpoint)
      }
      return key === endpoint
    })

    if (endpointKey && endpointRateLimiters[endpointKey]) {
      const key = `${ipAddress}:${endpoint}:${method}`
      try {
        await endpointRateLimiters[endpointKey].consume(key)
      } catch (rejRes) {
        return handleRateLimitExceeded(res, rejRes as RateLimiterRes, 'endpoint')
      }
    }

    // User tier-based rate limiting (if authenticated)
    if (req.user && req.user.organizationId) {
      const tier = await getUserTier(req.user.organizationId)
      const limiter = rateLimiters[tier] || rateLimiters.free
      
      const key = `${req.user.organizationId}:${endpoint}:${method}`
      try {
        await limiter.consume(key)
      } catch (rejRes) {
        return handleRateLimitExceeded(res, rejRes as RateLimiterRes, tier)
      }
    }

    next()
  } catch (error) {
    logger.error('Rate limiter error:', error)
    // Don't block requests on rate limiter errors
    next()
  }
}

/**
 * Handle rate limit exceeded
 */
function handleRateLimitExceeded(
  res: Response,
  rejRes: RateLimiterRes,
  type: string
): Response {
  const retryAfter = Math.round(rejRes.msBeforeNext / 1000) || 60
  const remainingPoints = rejRes.remainingPoints || 0

  logger.warn(`Rate limit exceeded: ${type}`, {
    remainingPoints,
    retryAfter,
    consumedPoints: rejRes.consumedPoints
  })

  return res.status(429).set({
    'Retry-After': String(retryAfter),
    'X-RateLimit-Limit': String(rejRes.points),
    'X-RateLimit-Remaining': String(remainingPoints),
    'X-RateLimit-Reset': new Date(Date.now() + rejRes.msBeforeNext).toISOString()
  }).json({
    error: 'Too many requests',
    message: `Rate limit exceeded. Please retry after ${retryAfter} seconds.`,
    retryAfter,
    type
  })
}

/**
 * Create custom rate limiter for specific use cases
 */
export function createCustomRateLimiter(options: {
  points: number
  duration: number
  keyPrefix: string
  blockDuration?: number
}): RateLimiterRedis {
  return new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: options.keyPrefix,
    points: options.points,
    duration: options.duration,
    blockDuration: options.blockDuration || options.duration,
    execEvenly: true
  })
}

/**
 * Rate limiter for webhooks (higher limits)
 */
export const webhookRateLimiter = createCustomRateLimiter({
  points: 10000,
  duration: 60,
  keyPrefix: 'webhook_rate_limit',
  blockDuration: 10
})

/**
 * Rate limiter for API key authentication
 */
export const apiKeyRateLimiter = async (
  req: Request & { apiKey?: string },
  res: Response,
  next: NextFunction
) => {
  if (!req.apiKey) {
    return next()
  }

  const limiter = createCustomRateLimiter({
    points: 5000, // 5000 requests per minute for API keys
    duration: 60,
    keyPrefix: 'api_key_rate_limit'
  })

  try {
    await limiter.consume(req.apiKey)
    next()
  } catch (rejRes) {
    return handleRateLimitExceeded(res, rejRes as RateLimiterRes, 'api_key')
  }
}

/**
 * Dynamic rate limiting based on system load
 */
export class DynamicRateLimiter {
  private loadThresholds = {
    low: { cpu: 50, memory: 60, multiplier: 1.0 },
    medium: { cpu: 70, memory: 75, multiplier: 0.7 },
    high: { cpu: 85, memory: 85, multiplier: 0.4 },
    critical: { cpu: 95, memory: 95, multiplier: 0.1 }
  }

  async getSystemLoad(): Promise<{ cpu: number; memory: number }> {
    const os = require('os')
    const cpuUsage = os.loadavg()[0] / os.cpus().length * 100
    const memoryUsage = (1 - os.freemem() / os.totalmem()) * 100
    
    return { cpu: cpuUsage, memory: memoryUsage }
  }

  async getDynamicMultiplier(): Promise<number> {
    const { cpu, memory } = await this.getSystemLoad()
    
    if (cpu >= this.loadThresholds.critical.cpu || memory >= this.loadThresholds.critical.memory) {
      return this.loadThresholds.critical.multiplier
    } else if (cpu >= this.loadThresholds.high.cpu || memory >= this.loadThresholds.high.memory) {
      return this.loadThresholds.high.multiplier
    } else if (cpu >= this.loadThresholds.medium.cpu || memory >= this.loadThresholds.medium.memory) {
      return this.loadThresholds.medium.multiplier
    }
    
    return this.loadThresholds.low.multiplier
  }

  async consume(limiter: RateLimiterRedis, key: string): Promise<void> {
    const multiplier = await this.getDynamicMultiplier()
    const adjustedPoints = Math.ceil(1 / multiplier)
    await limiter.consume(key, adjustedPoints)
  }
}

// Export Redis client for use in other modules
export { redisClient }