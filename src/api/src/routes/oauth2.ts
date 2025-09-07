import { Router } from 'express'
import { body, query, validationResult } from 'express-validator'
import { authMiddleware } from '../middleware/auth'
import { oauth2PKCEService } from '../services/oauth2Pkce'
import { logger } from '../utils/logger'
import { monitoringService } from '../utils/monitoring'

const router = Router()

/**
 * GET /oauth2/authorize
 * OAuth2 authorization endpoint
 */
router.get('/authorize', [
  query('client_id').isString().notEmpty().withMessage('Client ID is required'),
  query('redirect_uri').isURL().withMessage('Valid redirect URI is required'),
  query('response_type').equals('code').withMessage('Response type must be "code"'),
  query('code_challenge').isString().notEmpty().withMessage('Code challenge is required'),
  query('code_challenge_method').optional().isIn(['S256', 'plain']).withMessage('Invalid code challenge method'),
  query('scope').optional().isString().withMessage('Scope must be a string'),
  query('state').optional().isString().withMessage('State must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Validation failed',
        details: errors.array()
      })
    }

    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method = 'S256',
      scope = 'read',
      state
    } = req.query

    // If user is not authenticated, redirect to login
    if (!req.user) {
      const loginUrl = new URL('/login', process.env.WEB_BASE_URL || 'http://localhost:3000')
      loginUrl.searchParams.set('redirect', req.originalUrl)
      
      return res.redirect(loginUrl.toString())
    }

    // Parse scopes
    const scopes = (scope as string).split(' ').filter(s => s.length > 0)

    // Show authorization consent page
    res.render('oauth2/authorize', {
      client_id,
      redirect_uri,
      scopes,
      state,
      code_challenge,
      code_challenge_method,
      user: req.user
    })

  } catch (error) {
    logger.error('OAuth2 authorization request failed', { error })
    
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error'
    })
  }
})

/**
 * POST /oauth2/authorize
 * Handle authorization consent
 */
router.post('/authorize', [
  authMiddleware, // Ensure user is authenticated
  body('client_id').isString().notEmpty().withMessage('Client ID is required'),
  body('redirect_uri').isURL().withMessage('Valid redirect URI is required'),
  body('code_challenge').isString().notEmpty().withMessage('Code challenge is required'),
  body('code_challenge_method').optional().isIn(['S256', 'plain']).withMessage('Invalid code challenge method'),
  body('scopes').isArray().withMessage('Scopes must be an array'),
  body('scopes.*').isString().withMessage('Each scope must be a string'),
  body('state').optional().isString().withMessage('State must be a string'),
  body('consent').equals('allow').withMessage('User consent is required')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Validation failed',
        details: errors.array()
      })
    }

    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method = 'S256',
      scopes,
      state,
      consent
    } = req.body

    if (consent !== 'allow') {
      // User denied consent - redirect with error
      const errorUrl = new URL(redirect_uri)
      errorUrl.searchParams.set('error', 'access_denied')
      errorUrl.searchParams.set('error_description', 'User denied access')
      if (state) errorUrl.searchParams.set('state', state)
      
      return res.redirect(errorUrl.toString())
    }

    // Generate authorization code
    const { redirectUrl } = await oauth2PKCEService.authorizeRequest(
      client_id,
      req.user!.id,
      req.user!.organizationId,
      redirect_uri,
      scopes,
      code_challenge,
      code_challenge_method,
      state
    )

    // Redirect back to client with authorization code
    res.redirect(redirectUrl)

  } catch (error) {
    logger.error('OAuth2 authorization failed', {
      clientId: req.body.client_id,
      userId: req.user?.id,
      error
    })

    monitoringService.captureException(error, {
      context: 'oauth2_authorization',
      user: req.user,
      extra: { clientId: req.body.client_id }
    })

    // Redirect back to client with error
    const errorUrl = new URL(req.body.redirect_uri)
    errorUrl.searchParams.set('error', 'server_error')
    errorUrl.searchParams.set('error_description', 'Authorization failed')
    if (req.body.state) errorUrl.searchParams.set('state', req.body.state)
    
    res.redirect(errorUrl.toString())
  }
})

/**
 * POST /oauth2/token
 * OAuth2 token endpoint
 */
router.post('/token', [
  body('grant_type').equals('authorization_code').withMessage('Grant type must be "authorization_code"'),
  body('client_id').isString().notEmpty().withMessage('Client ID is required'),
  body('code').isString().notEmpty().withMessage('Authorization code is required'),
  body('redirect_uri').isURL().withMessage('Valid redirect URI is required'),
  body('code_verifier').isString().notEmpty().withMessage('Code verifier is required'),
  body('client_secret').optional().isString().withMessage('Client secret must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Validation failed',
        details: errors.array()
      })
    }

    const {
      client_id,
      code,
      redirect_uri,
      code_verifier,
      client_secret
    } = req.body

    // Exchange authorization code for tokens
    const tokens = await oauth2PKCEService.exchangeCodeForToken(
      client_id,
      code,
      redirect_uri,
      code_verifier,
      client_secret
    )

    res.json(tokens)

  } catch (error) {
    logger.error('OAuth2 token exchange failed', {
      clientId: req.body.client_id,
      error
    })

    monitoringService.captureException(error, {
      context: 'oauth2_token_exchange',
      extra: { clientId: req.body.client_id }
    })

    if (error.message.includes('Invalid') || error.message.includes('expired')) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: error.message
      })
    }

    res.status(500).json({
      error: 'server_error',
      error_description: 'Token exchange failed'
    })
  }
})

/**
 * POST /oauth2/token (refresh token grant)
 */
router.post('/token/refresh', [
  body('grant_type').equals('refresh_token').withMessage('Grant type must be "refresh_token"'),
  body('client_id').isString().notEmpty().withMessage('Client ID is required'),
  body('refresh_token').isString().notEmpty().withMessage('Refresh token is required'),
  body('client_secret').optional().isString().withMessage('Client secret must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Validation failed',
        details: errors.array()
      })
    }

    const {
      client_id,
      refresh_token,
      client_secret
    } = req.body

    // Refresh tokens
    const tokens = await oauth2PKCEService.refreshToken(
      client_id,
      refresh_token,
      client_secret
    )

    res.json(tokens)

  } catch (error) {
    logger.error('OAuth2 token refresh failed', {
      clientId: req.body.client_id,
      error
    })

    monitoringService.captureException(error, {
      context: 'oauth2_token_refresh',
      extra: { clientId: req.body.client_id }
    })

    if (error.message.includes('Invalid') || error.message.includes('expired')) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: error.message
      })
    }

    res.status(500).json({
      error: 'server_error',
      error_description: 'Token refresh failed'
    })
  }
})

/**
 * POST /oauth2/revoke
 * OAuth2 token revocation endpoint
 */
router.post('/revoke', [
  body('token').isString().notEmpty().withMessage('Token is required'),
  body('client_id').optional().isString().withMessage('Client ID must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Validation failed',
        details: errors.array()
      })
    }

    const { token, client_id } = req.body

    await oauth2PKCEService.revokeToken(token, client_id)

    // Always return success per RFC 7009
    res.status(200).json({
      success: true
    })

  } catch (error) {
    logger.error('OAuth2 token revocation failed', {
      clientId: req.body.client_id,
      error
    })

    // Always return success per RFC 7009
    res.status(200).json({
      success: true
    })
  }
})

/**
 * GET /oauth2/userinfo
 * OAuth2 UserInfo endpoint (protected)
 */
router.get('/userinfo', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'Bearer token required'
      })
    }

    const token = authHeader.substring(7)
    const tokenData = await oauth2PKCEService.validateAccessToken(token)

    if (!tokenData) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'Invalid or expired token'
      })
    }

    // Get user info (scope-based filtering would be applied here)
    const userInfo = {
      sub: tokenData.userId,
      organization_id: tokenData.organizationId,
      scope: tokenData.scopes.join(' ')
    }

    // Add additional claims based on scopes
    if (tokenData.scopes.includes('profile')) {
      // Add profile information
      userInfo.profile = {
        // Would fetch from database
      }
    }

    if (tokenData.scopes.includes('email')) {
      // Add email information
      userInfo.email = {
        // Would fetch from database
      }
    }

    res.json(userInfo)

  } catch (error) {
    logger.error('OAuth2 userinfo request failed', { error })

    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to get user info'
    })
  }
})

/**
 * Client management endpoints (protected)
 */

/**
 * POST /oauth2/clients
 * Register a new OAuth2 client
 */
router.post('/clients', [
  authMiddleware,
  body('name').isString().isLength({ min: 1, max: 100 }).withMessage('Name is required (1-100 characters)'),
  body('redirect_uris').isArray().withMessage('Redirect URIs must be an array'),
  body('redirect_uris.*').isURL().withMessage('Each redirect URI must be a valid URL'),
  body('scopes').optional().isArray().withMessage('Scopes must be an array'),
  body('scopes.*').isString().withMessage('Each scope must be a string'),
  body('client_type').optional().isIn(['public', 'confidential']).withMessage('Invalid client type')
], async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      })
    }

    const { name, redirect_uris, scopes = ['read'], client_type = 'public' } = req.body
    const organizationId = req.user!.organizationId

    const result = await oauth2PKCEService.registerClient(
      organizationId,
      name,
      redirect_uris,
      scopes,
      client_type
    )

    res.status(201).json({
      success: true,
      data: {
        client_id: result.clientId,
        client_secret: result.clientSecret,
        name,
        redirect_uris,
        scopes,
        client_type,
        created_at: new Date().toISOString()
      },
      warning: client_type === 'confidential' ? 'Store the client secret securely - it will not be shown again!' : undefined
    })

  } catch (error) {
    logger.error('OAuth2 client registration failed', {
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'oauth2_client_registration',
      user: req.user
    })

    res.status(500).json({
      success: false,
      error: 'Failed to register OAuth2 client'
    })
  }
})

/**
 * GET /oauth2/.well-known/authorization_server
 * OAuth2 Authorization Server Metadata (RFC 8414)
 */
router.get('/.well-known/authorization_server', (req, res) => {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3001'
  
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth2/authorize`,
    token_endpoint: `${baseUrl}/oauth2/token`,
    userinfo_endpoint: `${baseUrl}/oauth2/userinfo`,
    revocation_endpoint: `${baseUrl}/oauth2/revoke`,
    scopes_supported: ['read', 'write', 'admin', 'profile', 'email'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    claims_supported: ['sub', 'organization_id', 'scope']
  })
})

export default router