import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { createClient } from '@supabase/supabase-js'
import { redis } from '../utils/redis'
import { logger } from '../utils/logger'
import crypto from 'crypto'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

interface JWTPayload {
  userId: string
  organizationId: string
  email: string
  role: string
  sessionId: string
}

interface RefreshTokenPayload {
  userId: string
  sessionId: string
  tokenFamily: string
}

export class AuthService {
  private readonly accessTokenSecret = process.env.JWT_ACCESS_SECRET!
  private readonly refreshTokenSecret = process.env.JWT_REFRESH_SECRET!
  private readonly accessTokenExpiry = '15m'
  private readonly refreshTokenExpiry = '7d'
  private readonly tokenFamilyExpiry = 60 * 60 * 24 * 30 // 30 days in seconds

  /**
   * Generate access and refresh tokens for a user
   */
  async generateTokens(user: any): Promise<{
    accessToken: string
    refreshToken: string
    expiresIn: number
  }> {
    const sessionId = crypto.randomUUID()
    const tokenFamily = crypto.randomUUID()

    // Create access token
    const accessTokenPayload: JWTPayload = {
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      role: user.role,
      sessionId
    }

    const accessToken = jwt.sign(
      accessTokenPayload,
      this.accessTokenSecret,
      { 
        expiresIn: this.accessTokenExpiry,
        issuer: 'sierra-sync',
        audience: 'sierra-sync-api'
      }
    )

    // Create refresh token
    const refreshTokenPayload: RefreshTokenPayload = {
      userId: user.id,
      sessionId,
      tokenFamily
    }

    const refreshToken = jwt.sign(
      refreshTokenPayload,
      this.refreshTokenSecret,
      { 
        expiresIn: this.refreshTokenExpiry,
        issuer: 'sierra-sync',
        audience: 'sierra-sync-api'
      }
    )

    // Store refresh token family in Redis for rotation detection
    await redis.setex(
      `token_family:${tokenFamily}`,
      this.tokenFamilyExpiry,
      JSON.stringify({
        userId: user.id,
        sessionId,
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      })
    )

    // Store active session
    await redis.setex(
      `session:${sessionId}`,
      this.tokenFamilyExpiry,
      JSON.stringify({
        userId: user.id,
        organizationId: user.organization_id,
        tokenFamily,
        createdAt: new Date().toISOString()
      })
    )

    // Log authentication event
    await this.logAuthEvent(user.id, 'login', { sessionId })

    return {
      accessToken,
      refreshToken,
      expiresIn: 900 // 15 minutes in seconds
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string
    refreshToken: string
    expiresIn: number
  }> {
    try {
      // Verify refresh token
      const decoded = jwt.verify(
        refreshToken,
        this.refreshTokenSecret,
        {
          issuer: 'sierra-sync',
          audience: 'sierra-sync-api'
        }
      ) as RefreshTokenPayload

      // Check if token family exists (detect token reuse)
      const tokenFamilyKey = `token_family:${decoded.tokenFamily}`
      const tokenFamily = await redis.get(tokenFamilyKey)

      if (!tokenFamily) {
        // Token family not found - possible token reuse attack
        await this.revokeAllUserSessions(decoded.userId)
        throw new Error('Invalid refresh token - all sessions revoked')
      }

      // Get user data
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', decoded.userId)
        .single()

      if (error || !user) {
        throw new Error('User not found')
      }

      // Generate new token pair
      const newTokens = await this.generateTokens(user)

      // Update token family last used time
      const familyData = JSON.parse(tokenFamily)
      familyData.lastUsed = new Date().toISOString()
      await redis.setex(
        tokenFamilyKey,
        this.tokenFamilyExpiry,
        JSON.stringify(familyData)
      )

      // Log refresh event
      await this.logAuthEvent(user.id, 'token_refresh', { 
        sessionId: decoded.sessionId 
      })

      return newTokens
    } catch (error) {
      logger.error('Token refresh failed:', error)
      throw new Error('Invalid refresh token')
    }
  }

  /**
   * Revoke all sessions for a user (security measure)
   */
  async revokeAllUserSessions(userId: string): Promise<void> {
    // Get all sessions for user
    const sessionKeys = await redis.keys(`session:*`)
    
    for (const key of sessionKeys) {
      const session = await redis.get(key)
      if (session) {
        const sessionData = JSON.parse(session)
        if (sessionData.userId === userId) {
          await redis.del(key)
          await redis.del(`token_family:${sessionData.tokenFamily}`)
        }
      }
    }

    // Log security event
    await this.logAuthEvent(userId, 'sessions_revoked', {
      reason: 'Potential token reuse detected'
    })

    logger.warn(`All sessions revoked for user ${userId} due to security concern`)
  }

  /**
   * Validate access token
   */
  async validateAccessToken(token: string): Promise<JWTPayload> {
    try {
      const decoded = jwt.verify(
        token,
        this.accessTokenSecret,
        {
          issuer: 'sierra-sync',
          audience: 'sierra-sync-api'
        }
      ) as JWTPayload

      // Check if session is still active
      const session = await redis.get(`session:${decoded.sessionId}`)
      if (!session) {
        throw new Error('Session expired or revoked')
      }

      return decoded
    } catch (error) {
      throw new Error('Invalid access token')
    }
  }

  /**
   * Logout - revoke tokens
   */
  async logout(sessionId: string): Promise<void> {
    const session = await redis.get(`session:${sessionId}`)
    if (session) {
      const sessionData = JSON.parse(session)
      await redis.del(`session:${sessionId}`)
      await redis.del(`token_family:${sessionData.tokenFamily}`)
      
      await this.logAuthEvent(sessionData.userId, 'logout', { sessionId })
    }
  }

  /**
   * Log authentication events for audit
   */
  private async logAuthEvent(
    userId: string, 
    event: string, 
    metadata: any = {}
  ): Promise<void> {
    try {
      await supabase.from('auth_logs').insert({
        user_id: userId,
        event,
        metadata,
        ip_address: metadata.ipAddress,
        user_agent: metadata.userAgent,
        created_at: new Date().toISOString()
      })
    } catch (error) {
      logger.error('Failed to log auth event:', error)
    }
  }
}

/**
 * Express middleware for JWT authentication
 */
export const authenticateToken = async (
  req: Request & { user?: JWTPayload },
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader && authHeader.split(' ')[1]

    if (!token) {
      return res.status(401).json({ error: 'Access token required' })
    }

    const authService = new AuthService()
    const payload = await authService.validateAccessToken(token)
    
    req.user = payload
    next()
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' })
  }
}

/**
 * Middleware to check user role
 */
export const requireRole = (roles: string[]) => {
  return (req: Request & { user?: JWTPayload }, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }

    next()
  }
}

/**
 * Middleware to check organization access
 */
export const requireOrganization = async (
  req: Request & { user?: JWTPayload },
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const organizationId = req.params.organizationId || req.body.organizationId
    
    if (organizationId && organizationId !== req.user.organizationId) {
      // Check if user has cross-organization access (admin only)
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied to this organization' })
      }
    }

    next()
  } catch (error) {
    return res.status(500).json({ error: 'Authorization check failed' })
  }
}