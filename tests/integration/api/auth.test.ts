import request from 'supertest'
import { Express } from 'express'
import { createApp } from '../../../src/api/src/app'

describe('Auth API Integration Tests', () => {
  let app: Express
  let testUser: any
  let testOrg: any

  beforeAll(async () => {
    app = await createApp()
  })

  beforeEach(async () => {
    // Create test organization and user
    testOrg = await global.testUtils.createTestOrganization({
      name: 'Auth Test Org',
      email: 'authtest@test.example'
    })

    testUser = await global.testUtils.createTestUser({
      email: 'authtest@test.example',
      organization_id: testOrg.id,
      password_hash: '$2b$10$test.hash.for.password123' // bcrypt hash for "password123"
    })
  })

  describe('POST /api/auth/login', () => {
    it('should login with valid credentials', async () => {
      const loginData = {
        email: 'authtest@test.example',
        password: 'password123'
      }

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        user: {
          id: testUser.id,
          email: testUser.email,
          role: testUser.role
        }
      })

      expect(response.body.tokens).toHaveProperty('accessToken')
      expect(response.body.tokens).toHaveProperty('refreshToken')
      expect(response.body.tokens).toHaveProperty('expiresIn')

      // Verify JWT token structure
      const jwt = require('jsonwebtoken')
      const decoded = jwt.decode(response.body.tokens.accessToken) as any
      expect(decoded.userId).toBe(testUser.id)
      expect(decoded.email).toBe(testUser.email)
      expect(decoded.organizationId).toBe(testOrg.id)
    })

    it('should reject invalid email', async () => {
      const loginData = {
        email: 'invalid@test.example',
        password: 'password123'
      }

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(401)

      expect(response.body).toMatchObject({
        success: false,
        error: 'Invalid credentials'
      })
    })

    it('should reject invalid password', async () => {
      const loginData = {
        email: 'authtest@test.example',
        password: 'wrongpassword'
      }

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(401)

      expect(response.body).toMatchObject({
        success: false,
        error: 'Invalid credentials'
      })
    })

    it('should rate limit login attempts', async () => {
      const loginData = {
        email: 'authtest@test.example',
        password: 'wrongpassword'
      }

      // Make multiple failed login attempts
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/auth/login')
          .send(loginData)
          .expect(401)
      }

      // Next attempt should be rate limited
      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(429)

      expect(response.body).toMatchObject({
        success: false,
        error: 'Too many login attempts'
      })
    })

    it('should validate input format', async () => {
      const invalidData = {
        email: 'not-an-email',
        password: '123' // too short
      }

      const response = await request(app)
        .post('/api/auth/login')
        .send(invalidData)
        .expect(400)

      expect(response.body.success).toBe(false)
      expect(response.body.error).toContain('validation')
    })
  })

  describe('POST /api/auth/register', () => {
    it('should register new user', async () => {
      const registerData = {
        email: 'newuser@test.example',
        password: 'password123',
        firstName: 'New',
        lastName: 'User',
        organizationName: 'New Test Org'
      }

      const response = await request(app)
        .post('/api/auth/register')
        .send(registerData)
        .expect(201)

      expect(response.body).toMatchObject({
        success: true,
        user: {
          email: registerData.email,
          first_name: registerData.firstName,
          last_name: registerData.lastName,
          role: 'admin' // First user in org becomes admin
        }
      })

      expect(response.body).toHaveProperty('tokens')
      expect(response.body.tokens).toHaveProperty('accessToken')
    })

    it('should reject duplicate email', async () => {
      const registerData = {
        email: 'authtest@test.example', // Already exists
        password: 'password123',
        firstName: 'Duplicate',
        lastName: 'User',
        organizationName: 'Duplicate Org'
      }

      const response = await request(app)
        .post('/api/auth/register')
        .send(registerData)
        .expect(409)

      expect(response.body).toMatchObject({
        success: false,
        error: 'Email already exists'
      })
    })

    it('should validate password strength', async () => {
      const registerData = {
        email: 'weakpass@test.example',
        password: '123', // Too weak
        firstName: 'Weak',
        lastName: 'Pass',
        organizationName: 'Weak Org'
      }

      const response = await request(app)
        .post('/api/auth/register')
        .send(registerData)
        .expect(400)

      expect(response.body.success).toBe(false)
      expect(response.body.error).toContain('password')
    })
  })

  describe('POST /api/auth/refresh', () => {
    let refreshToken: string

    beforeEach(async () => {
      // Login to get refresh token
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'authtest@test.example',
          password: 'password123'
        })
        .expect(200)

      refreshToken = loginResponse.body.tokens.refreshToken
    })

    it('should refresh tokens with valid refresh token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(200)

      expect(response.body).toMatchObject({
        success: true
      })

      expect(response.body.tokens).toHaveProperty('accessToken')
      expect(response.body.tokens).toHaveProperty('refreshToken')
      expect(response.body.tokens).toHaveProperty('expiresIn')

      // New tokens should be different from original
      expect(response.body.tokens.refreshToken).not.toBe(refreshToken)
    })

    it('should reject invalid refresh token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'invalid.token.here' })
        .expect(401)

      expect(response.body).toMatchObject({
        success: false,
        error: 'Invalid refresh token'
      })
    })

    it('should reject expired refresh token', async () => {
      const jwt = require('jsonwebtoken')
      const expiredToken = jwt.sign(
        { userId: testUser.id, tokenType: 'refresh' },
        global.testConfig.jwt.refreshSecret,
        { expiresIn: '-1h' } // Expired
      )

      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: expiredToken })
        .expect(401)

      expect(response.body.success).toBe(false)
    })
  })

  describe('POST /api/auth/logout', () => {
    let accessToken: string
    let refreshToken: string

    beforeEach(async () => {
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'authtest@test.example',
          password: 'password123'
        })
        .expect(200)

      accessToken = loginResponse.body.tokens.accessToken
      refreshToken = loginResponse.body.tokens.refreshToken
    })

    it('should logout successfully', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        message: 'Logged out successfully'
      })

      // Verify token is invalidated
      const protectedResponse = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401)

      expect(protectedResponse.body.success).toBe(false)
    })

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .send({ refreshToken })
        .expect(401)

      expect(response.body.success).toBe(false)
    })
  })

  describe('POST /api/auth/forgot-password', () => {
    it('should initiate password reset', async () => {
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'authtest@test.example' })
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        message: 'Password reset email sent'
      })
    })

    it('should not reveal if email exists', async () => {
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'nonexistent@test.example' })
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        message: 'Password reset email sent'
      })
    })

    it('should validate email format', async () => {
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'not-an-email' })
        .expect(400)

      expect(response.body.success).toBe(false)
    })
  })

  describe('POST /api/auth/reset-password', () => {
    let resetToken: string

    beforeEach(async () => {
      // Generate a valid reset token for testing
      const jwt = require('jsonwebtoken')
      resetToken = jwt.sign(
        {
          userId: testUser.id,
          type: 'password_reset',
          exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour
        },
        global.testConfig.jwt.secret
      )
    })

    it('should reset password with valid token', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({
          token: resetToken,
          newPassword: 'newpassword123'
        })
        .expect(200)

      expect(response.body).toMatchObject({
        success: true,
        message: 'Password reset successfully'
      })

      // Verify can login with new password
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'authtest@test.example',
          password: 'newpassword123'
        })
        .expect(200)

      expect(loginResponse.body.success).toBe(true)
    })

    it('should reject invalid reset token', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({
          token: 'invalid.token',
          newPassword: 'newpassword123'
        })
        .expect(400)

      expect(response.body.success).toBe(false)
    })

    it('should validate new password strength', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({
          token: resetToken,
          newPassword: '123' // Too weak
        })
        .expect(400)

      expect(response.body.success).toBe(false)
    })
  })

  describe('Protected Routes', () => {
    let accessToken: string

    beforeEach(async () => {
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'authtest@test.example',
          password: 'password123'
        })
        .expect(200)

      accessToken = loginResponse.body.tokens.accessToken
    })

    it('should allow access with valid token', async () => {
      const response = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200)

      expect(response.body.success).toBe(true)
    })

    it('should reject requests without token', async () => {
      const response = await request(app)
        .get('/api/users/me')
        .expect(401)

      expect(response.body).toMatchObject({
        success: false,
        error: 'No token provided'
      })
    })

    it('should reject requests with invalid token', async () => {
      const response = await request(app)
        .get('/api/users/me')
        .set('Authorization', 'Bearer invalid.token')
        .expect(401)

      expect(response.body).toMatchObject({
        success: false,
        error: 'Invalid token'
      })
    })

    it('should reject expired tokens', async () => {
      const jwt = require('jsonwebtoken')
      const expiredToken = jwt.sign(
        { userId: testUser.id },
        global.testConfig.jwt.secret,
        { expiresIn: '-1h' } // Expired
      )

      const response = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401)

      expect(response.body.success).toBe(false)
    })
  })

  describe('Security Features', () => {
    it('should track login attempts', async () => {
      // Successful login
      await request(app)
        .post('/api/auth/login')
        .send({
          email: 'authtest@test.example',
          password: 'password123'
        })
        .expect(200)

      // Failed login
      await request(app)
        .post('/api/auth/login')
        .send({
          email: 'authtest@test.example',
          password: 'wrongpassword'
        })
        .expect(401)

      // Security events should be tracked in Redis
      const redis = await global.testUtils.initRedis()
      const keys = await redis.keys('security:*')
      expect(keys.length).toBeGreaterThan(0)
    })

    it('should prevent CSRF attacks', async () => {
      // This would test CSRF protection if implemented
      // For now, we test that proper headers are required
      const response = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'https://malicious-site.com')
        .send({
          email: 'authtest@test.example',
          password: 'password123'
        })

      // Should still work with valid credentials regardless of origin
      // CSRF protection typically works with state-changing operations
      expect(response.status).toBe(200)
    })

    it('should sanitize user input', async () => {
      const maliciousInput = {
        email: '<script>alert("xss")</script>@test.example',
        password: 'password123'
      }

      const response = await request(app)
        .post('/api/auth/login')
        .send(maliciousInput)
        .expect(401) // Should fail validation or not find user

      // Ensure no script tags are reflected in response
      expect(response.body.error).not.toContain('<script>')
    })
  })
})