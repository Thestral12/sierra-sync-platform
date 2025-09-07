import { AuthService } from '../../../src/api/src/middleware/auth'
import Redis from 'ioredis'
import jwt from 'jsonwebtoken'

describe('AuthService', () => {
  let authService: AuthService
  let mockRedis: jest.Mocked<Redis>
  let mockSupabase: any

  beforeEach(() => {
    mockRedis = {
      setex: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      multi: jest.fn(() => ({
        setex: jest.fn().mockReturnThis(),
        del: jest.fn().mockReturnThis(),
        exec: jest.fn()
      }))
    } as any

    mockSupabase = {
      from: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn(),
        update: jest.fn().mockReturnThis()
      }))
    }

    authService = new AuthService({
      redis: mockRedis,
      supabaseUrl: 'http://localhost',
      supabaseKey: 'test-key',
      jwtSecret: 'test-secret',
      jwtRefreshSecret: 'test-refresh-secret',
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d'
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('generateTokens', () => {
    it('should generate access and refresh tokens', async () => {
      const user = {
        id: 'user-123',
        email: 'test@example.com',
        organizationId: 'org-123',
        role: 'user'
      }

      mockRedis.setex.mockResolvedValue('OK')

      const result = await authService.generateTokens(user)

      expect(result).toHaveProperty('accessToken')
      expect(result).toHaveProperty('refreshToken')
      expect(result).toHaveProperty('expiresIn')
      expect(typeof result.accessToken).toBe('string')
      expect(typeof result.refreshToken).toBe('string')
      expect(typeof result.expiresIn).toBe('number')

      // Verify Redis calls
      expect(mockRedis.setex).toHaveBeenCalledTimes(2) // session and token family
    })

    it('should create valid JWT tokens', async () => {
      const user = {
        id: 'user-123',
        email: 'test@example.com',
        organizationId: 'org-123',
        role: 'user'
      }

      mockRedis.setex.mockResolvedValue('OK')

      const result = await authService.generateTokens(user)

      // Verify access token
      const decodedAccess = jwt.verify(result.accessToken, 'test-secret') as any
      expect(decodedAccess.userId).toBe(user.id)
      expect(decodedAccess.email).toBe(user.email)
      expect(decodedAccess.organizationId).toBe(user.organizationId)
      expect(decodedAccess.role).toBe(user.role)

      // Verify refresh token
      const decodedRefresh = jwt.verify(result.refreshToken, 'test-refresh-secret') as any
      expect(decodedRefresh.userId).toBe(user.id)
      expect(decodedRefresh.tokenType).toBe('refresh')
    })
  })

  describe('verifyAccessToken', () => {
    it('should verify valid access token', async () => {
      const user = {
        id: 'user-123',
        email: 'test@example.com',
        organizationId: 'org-123',
        role: 'user'
      }

      const token = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          organizationId: user.organizationId,
          role: user.role,
          sessionId: 'session-123'
        },
        'test-secret',
        { expiresIn: '15m' }
      )

      mockRedis.get.mockResolvedValue('active')

      const result = await authService.verifyAccessToken(token)

      expect(result).toEqual({
        valid: true,
        user: {
          id: user.id,
          email: user.email,
          organizationId: user.organizationId,
          role: user.role
        }
      })

      expect(mockRedis.get).toHaveBeenCalledWith('session:session-123')
    })

    it('should reject expired token', async () => {
      const expiredToken = jwt.sign(
        { userId: 'user-123' },
        'test-secret',
        { expiresIn: '-1h' }
      )

      const result = await authService.verifyAccessToken(expiredToken)

      expect(result).toEqual({
        valid: false,
        error: 'Token expired'
      })
    })

    it('should reject token with invalid signature', async () => {
      const invalidToken = jwt.sign(
        { userId: 'user-123' },
        'wrong-secret',
        { expiresIn: '15m' }
      )

      const result = await authService.verifyAccessToken(invalidToken)

      expect(result).toEqual({
        valid: false,
        error: 'Invalid token'
      })
    })

    it('should reject token with inactive session', async () => {
      const token = jwt.sign(
        {
          userId: 'user-123',
          sessionId: 'session-123'
        },
        'test-secret',
        { expiresIn: '15m' }
      )

      mockRedis.get.mockResolvedValue(null)

      const result = await authService.verifyAccessToken(token)

      expect(result).toEqual({
        valid: false,
        error: 'Session not found'
      })
    })
  })

  describe('refreshTokens', () => {
    it('should generate new tokens with valid refresh token', async () => {
      const userId = 'user-123'
      const tokenFamily = 'family-123'
      
      const refreshToken = jwt.sign(
        {
          userId,
          tokenFamily,
          tokenType: 'refresh'
        },
        'test-refresh-secret',
        { expiresIn: '7d' }
      )

      mockRedis.get.mockResolvedValue(tokenFamily)
      mockRedis.setex.mockResolvedValue('OK')
      mockSupabase.from().select().eq().single.mockResolvedValue({
        data: {
          id: userId,
          email: 'test@example.com',
          organization_id: 'org-123',
          role: 'user'
        },
        error: null
      })

      const result = await authService.refreshTokens(refreshToken)

      expect(result).toHaveProperty('accessToken')
      expect(result).toHaveProperty('refreshToken')
      expect(result).toHaveProperty('expiresIn')
      expect(result.accessToken).toBeDefined()
      expect(result.refreshToken).toBeDefined()
    })

    it('should reject invalid refresh token', async () => {
      const invalidToken = jwt.sign(
        { userId: 'user-123' },
        'wrong-secret'
      )

      await expect(authService.refreshTokens(invalidToken))
        .rejects.toThrow('Invalid refresh token')
    })

    it('should reject token with invalid family', async () => {
      const refreshToken = jwt.sign(
        {
          userId: 'user-123',
          tokenFamily: 'family-123',
          tokenType: 'refresh'
        },
        'test-refresh-secret'
      )

      mockRedis.get.mockResolvedValue('different-family')

      await expect(authService.refreshTokens(refreshToken))
        .rejects.toThrow('Invalid token family')
    })
  })

  describe('revokeSession', () => {
    it('should revoke session successfully', async () => {
      const sessionId = 'session-123'

      mockRedis.del.mockResolvedValue(1)

      await authService.revokeSession(sessionId)

      expect(mockRedis.del).toHaveBeenCalledWith(`session:${sessionId}`)
    })
  })

  describe('revokeUserSessions', () => {
    it('should revoke all user sessions', async () => {
      const userId = 'user-123'

      mockRedis.del.mockResolvedValue(1)
      const mockMulti = {
        del: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([])
      }
      mockRedis.multi.mockReturnValue(mockMulti as any)

      await authService.revokeUserSessions(userId)

      expect(mockRedis.del).toHaveBeenCalledWith(`user_sessions:${userId}`)
      expect(mockMulti.del).toHaveBeenCalled()
    })
  })

  describe('trackSecurityEvent', () => {
    it('should track security events', async () => {
      const event = {
        userId: 'user-123',
        event: 'login',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        metadata: { success: true }
      }

      mockRedis.setex.mockResolvedValue('OK')

      await authService.trackSecurityEvent(
        event.userId,
        event.event,
        event.ipAddress,
        event.userAgent,
        event.metadata
      )

      expect(mockRedis.setex).toHaveBeenCalled()
    })
  })

  describe('checkRateLimit', () => {
    it('should allow requests within rate limit', async () => {
      const key = 'login:192.168.1.1'
      
      mockRedis.get.mockResolvedValue('5') // 5 attempts
      mockRedis.setex.mockResolvedValue('OK')

      const result = await authService.checkRateLimit(key, 10, 3600)

      expect(result).toEqual({
        allowed: true,
        remaining: 5,
        resetTime: expect.any(Number)
      })
    })

    it('should block requests exceeding rate limit', async () => {
      const key = 'login:192.168.1.1'
      
      mockRedis.get.mockResolvedValue('10') // 10 attempts, limit is 10

      const result = await authService.checkRateLimit(key, 10, 3600)

      expect(result).toEqual({
        allowed: false,
        remaining: 0,
        resetTime: expect.any(Number)
      })
    })

    it('should handle first request', async () => {
      const key = 'login:192.168.1.1'
      
      mockRedis.get.mockResolvedValue(null) // No previous attempts
      mockRedis.setex.mockResolvedValue('OK')

      const result = await authService.checkRateLimit(key, 10, 3600)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(9)
    })
  })
})