import crypto from 'crypto'
import { EventEmitter } from 'events'
import jwt from 'jsonwebtoken'
import { logger } from '../utils/logger'
import { monitoringService } from '../utils/monitoring'
import { redis } from '../config/redis'
import { supabase } from '../config/supabase'

interface OAuth2Client {
  id: string
  name: string
  organizationId: string
  redirectUris: string[]
  scopes: string[]
  clientType: 'public' | 'confidential'
  createdAt: Date
  isActive: boolean
}

interface AuthorizationCode {
  code: string
  clientId: string
  userId: string
  organizationId: string
  redirectUri: string
  scopes: string[]
  codeChallenge: string
  codeChallengeMethod: 'S256' | 'plain'
  expiresAt: Date
  used: boolean
}

interface AccessToken {
  token: string
  clientId: string
  userId: string
  organizationId: string
  scopes: string[]
  expiresAt: Date
  refreshToken?: string
}

export class OAuth2PKCEService extends EventEmitter {
  private readonly authCodeTTL = 600 // 10 minutes
  private readonly accessTokenTTL = 3600 // 1 hour
  private readonly refreshTokenTTL = 86400 * 30 // 30 days

  constructor() {
    super()
  }

  /**
   * Register a new OAuth2 client
   */
  async registerClient(
    organizationId: string,
    name: string,
    redirectUris: string[],
    scopes: string[] = ['read'],
    clientType: 'public' | 'confidential' = 'public'
  ): Promise<{ clientId: string; clientSecret?: string }> {
    try {
      const clientId = this.generateClientId()
      const clientSecret = clientType === 'confidential' ? this.generateClientSecret() : undefined

      const { error } = await supabase
        .from('oauth2_clients')
        .insert({
          id: clientId,
          name,
          organization_id: organizationId,
          redirect_uris: redirectUris,
          scopes,
          client_type: clientType,
          client_secret_hash: clientSecret ? this.hashSecret(clientSecret) : null,
          is_active: true
        })

      if (error) throw error

      logger.info('OAuth2 client registered', {
        clientId,
        organizationId,
        name,
        clientType
      })

      monitoringService.addBreadcrumb({
        message: 'OAuth2 client registered',
        data: { clientId, organizationId, name }
      })

      return { clientId, clientSecret }

    } catch (error) {
      logger.error('Failed to register OAuth2 client', {
        organizationId,
        name,
        error
      })

      monitoringService.captureException(error, {
        context: 'oauth2_client_registration',
        extra: { organizationId, name }
      })

      throw error
    }
  }

  /**
   * Generate authorization URL for PKCE flow
   */
  generateAuthorizationUrl(
    clientId: string,
    redirectUri: string,
    scopes: string[],
    state: string,
    codeChallenge: string,
    codeChallengeMethod: 'S256' | 'plain' = 'S256'
  ): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod
    })

    return `${process.env.API_BASE_URL}/oauth2/authorize?${params.toString()}`
  }

  /**
   * Handle authorization request (user consent)
   */
  async authorizeRequest(
    clientId: string,
    userId: string,
    organizationId: string,
    redirectUri: string,
    scopes: string[],
    codeChallenge: string,
    codeChallengeMethod: 'S256' | 'plain' = 'S256',
    state?: string
  ): Promise<{ code: string; redirectUrl: string }> {
    try {
      // Validate client
      const client = await this.getClient(clientId)
      if (!client || !client.isActive) {
        throw new Error('Invalid or inactive client')
      }

      // Validate redirect URI
      if (!client.redirectUris.includes(redirectUri)) {
        throw new Error('Invalid redirect URI')
      }

      // Validate scopes
      const invalidScopes = scopes.filter(scope => !client.scopes.includes(scope))
      if (invalidScopes.length > 0) {
        throw new Error(`Invalid scopes: ${invalidScopes.join(', ')}`)
      }

      // Generate authorization code
      const authCode = this.generateAuthorizationCode()
      const expiresAt = new Date(Date.now() + (this.authCodeTTL * 1000))

      // Store authorization code
      const codeData: AuthorizationCode = {
        code: authCode,
        clientId,
        userId,
        organizationId,
        redirectUri,
        scopes,
        codeChallenge,
        codeChallengeMethod,
        expiresAt,
        used: false
      }

      await redis.setex(
        `oauth2:auth_code:${authCode}`,
        this.authCodeTTL,
        JSON.stringify(codeData)
      )

      // Also store in database for audit trail
      await supabase
        .from('oauth2_authorization_codes')
        .insert({
          code: authCode,
          client_id: clientId,
          user_id: userId,
          organization_id: organizationId,
          redirect_uri: redirectUri,
          scopes,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          expires_at: expiresAt.toISOString(),
          used: false
        })

      // Build redirect URL
      const redirectParams = new URLSearchParams({
        code: authCode,
        ...(state && { state })
      })

      const redirectUrl = `${redirectUri}?${redirectParams.toString()}`

      logger.info('Authorization code generated', {
        clientId,
        userId,
        organizationId,
        scopes
      })

      this.emit('authorizationGranted', {
        clientId,
        userId,
        organizationId,
        scopes,
        code: authCode
      })

      return { code: authCode, redirectUrl }

    } catch (error) {
      logger.error('Authorization request failed', {
        clientId,
        userId,
        error
      })

      monitoringService.captureException(error, {
        context: 'oauth2_authorization',
        extra: { clientId, userId }
      })

      throw error
    }
  }

  /**
   * Exchange authorization code for access token (PKCE)
   */
  async exchangeCodeForToken(
    clientId: string,
    code: string,
    redirectUri: string,
    codeVerifier: string,
    clientSecret?: string
  ): Promise<{
    access_token: string
    token_type: string
    expires_in: number
    refresh_token: string
    scope: string
  }> {
    try {
      // Validate client
      const client = await this.getClient(clientId)
      if (!client || !client.isActive) {
        throw new Error('Invalid or inactive client')
      }

      // Validate client secret for confidential clients
      if (client.clientType === 'confidential') {
        if (!clientSecret || !await this.validateClientSecret(clientId, clientSecret)) {
          throw new Error('Invalid client secret')
        }
      }

      // Retrieve authorization code
      const codeKey = `oauth2:auth_code:${code}`
      const codeDataStr = await redis.get(codeKey)
      
      if (!codeDataStr) {
        throw new Error('Invalid or expired authorization code')
      }

      const codeData: AuthorizationCode = JSON.parse(codeDataStr)

      // Validate code data
      if (codeData.clientId !== clientId) {
        throw new Error('Code was issued to a different client')
      }

      if (codeData.redirectUri !== redirectUri) {
        throw new Error('Redirect URI mismatch')
      }

      if (codeData.used) {
        throw new Error('Authorization code already used')
      }

      if (new Date() > codeData.expiresAt) {
        throw new Error('Authorization code expired')
      }

      // Verify PKCE code challenge
      if (!this.verifyCodeChallenge(codeVerifier, codeData.codeChallenge, codeData.codeChallengeMethod)) {
        throw new Error('Invalid code verifier')
      }

      // Generate tokens
      const accessToken = this.generateAccessToken({
        clientId,
        userId: codeData.userId,
        organizationId: codeData.organizationId,
        scopes: codeData.scopes
      })

      const refreshToken = this.generateRefreshToken({
        clientId,
        userId: codeData.userId,
        organizationId: codeData.organizationId
      })

      // Store tokens
      const tokenData: AccessToken = {
        token: accessToken,
        clientId,
        userId: codeData.userId,
        organizationId: codeData.organizationId,
        scopes: codeData.scopes,
        expiresAt: new Date(Date.now() + (this.accessTokenTTL * 1000)),
        refreshToken
      }

      await redis.setex(
        `oauth2:access_token:${accessToken}`,
        this.accessTokenTTL,
        JSON.stringify(tokenData)
      )

      await redis.setex(
        `oauth2:refresh_token:${refreshToken}`,
        this.refreshTokenTTL,
        JSON.stringify({
          clientId,
          userId: codeData.userId,
          organizationId: codeData.organizationId,
          accessToken
        })
      )

      // Mark authorization code as used
      codeData.used = true
      await redis.setex(codeKey, this.authCodeTTL, JSON.stringify(codeData))

      // Update database
      await supabase
        .from('oauth2_authorization_codes')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('code', code)

      // Log token issuance
      await supabase
        .from('oauth2_token_events')
        .insert({
          client_id: clientId,
          user_id: codeData.userId,
          organization_id: codeData.organizationId,
          event_type: 'token_issued',
          scopes: codeData.scopes,
          access_token_hash: this.hashToken(accessToken),
          refresh_token_hash: this.hashToken(refreshToken)
        })

      logger.info('OAuth2 tokens issued', {
        clientId,
        userId: codeData.userId,
        organizationId: codeData.organizationId,
        scopes: codeData.scopes
      })

      this.emit('tokensIssued', {
        clientId,
        userId: codeData.userId,
        organizationId: codeData.organizationId,
        scopes: codeData.scopes
      })

      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: this.accessTokenTTL,
        refresh_token: refreshToken,
        scope: codeData.scopes.join(' ')
      }

    } catch (error) {
      logger.error('Token exchange failed', {
        clientId,
        error
      })

      monitoringService.captureException(error, {
        context: 'oauth2_token_exchange',
        extra: { clientId }
      })

      throw error
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(
    clientId: string,
    refreshToken: string,
    clientSecret?: string
  ): Promise<{
    access_token: string
    token_type: string
    expires_in: number
    refresh_token: string
    scope: string
  }> {
    try {
      // Validate client
      const client = await this.getClient(clientId)
      if (!client || !client.isActive) {
        throw new Error('Invalid or inactive client')
      }

      // Validate client secret for confidential clients
      if (client.clientType === 'confidential') {
        if (!clientSecret || !await this.validateClientSecret(clientId, clientSecret)) {
          throw new Error('Invalid client secret')
        }
      }

      // Retrieve refresh token data
      const refreshTokenKey = `oauth2:refresh_token:${refreshToken}`
      const refreshDataStr = await redis.get(refreshTokenKey)
      
      if (!refreshDataStr) {
        throw new Error('Invalid or expired refresh token')
      }

      const refreshData = JSON.parse(refreshDataStr)

      if (refreshData.clientId !== clientId) {
        throw new Error('Refresh token was issued to a different client')
      }

      // Get original token data to preserve scopes
      const originalTokenData = await redis.get(`oauth2:access_token:${refreshData.accessToken}`)
      const scopes = originalTokenData ? JSON.parse(originalTokenData).scopes : ['read']

      // Generate new tokens
      const newAccessToken = this.generateAccessToken({
        clientId,
        userId: refreshData.userId,
        organizationId: refreshData.organizationId,
        scopes
      })

      const newRefreshToken = this.generateRefreshToken({
        clientId,
        userId: refreshData.userId,
        organizationId: refreshData.organizationId
      })

      // Store new tokens
      const newTokenData: AccessToken = {
        token: newAccessToken,
        clientId,
        userId: refreshData.userId,
        organizationId: refreshData.organizationId,
        scopes,
        expiresAt: new Date(Date.now() + (this.accessTokenTTL * 1000)),
        refreshToken: newRefreshToken
      }

      await redis.setex(
        `oauth2:access_token:${newAccessToken}`,
        this.accessTokenTTL,
        JSON.stringify(newTokenData)
      )

      await redis.setex(
        `oauth2:refresh_token:${newRefreshToken}`,
        this.refreshTokenTTL,
        JSON.stringify({
          clientId,
          userId: refreshData.userId,
          organizationId: refreshData.organizationId,
          accessToken: newAccessToken
        })
      )

      // Invalidate old tokens
      await redis.del(`oauth2:access_token:${refreshData.accessToken}`)
      await redis.del(refreshTokenKey)

      // Log token refresh
      await supabase
        .from('oauth2_token_events')
        .insert({
          client_id: clientId,
          user_id: refreshData.userId,
          organization_id: refreshData.organizationId,
          event_type: 'token_refreshed',
          scopes,
          access_token_hash: this.hashToken(newAccessToken),
          refresh_token_hash: this.hashToken(newRefreshToken)
        })

      logger.info('OAuth2 tokens refreshed', {
        clientId,
        userId: refreshData.userId,
        organizationId: refreshData.organizationId
      })

      return {
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: this.accessTokenTTL,
        refresh_token: newRefreshToken,
        scope: scopes.join(' ')
      }

    } catch (error) {
      logger.error('Token refresh failed', {
        clientId,
        error
      })

      monitoringService.captureException(error, {
        context: 'oauth2_token_refresh',
        extra: { clientId }
      })

      throw error
    }
  }

  /**
   * Validate access token
   */
  async validateAccessToken(token: string): Promise<AccessToken | null> {
    try {
      const tokenKey = `oauth2:access_token:${token}`
      const tokenDataStr = await redis.get(tokenKey)
      
      if (!tokenDataStr) {
        return null
      }

      const tokenData: AccessToken = JSON.parse(tokenDataStr)

      if (new Date() > tokenData.expiresAt) {
        await redis.del(tokenKey)
        return null
      }

      return tokenData

    } catch (error) {
      logger.error('Token validation failed', { error })
      return null
    }
  }

  /**
   * Revoke access token
   */
  async revokeToken(token: string, clientId?: string): Promise<void> {
    try {
      const tokenData = await this.validateAccessToken(token)
      
      if (tokenData && (!clientId || tokenData.clientId === clientId)) {
        // Revoke access token
        await redis.del(`oauth2:access_token:${token}`)
        
        // Revoke associated refresh token
        if (tokenData.refreshToken) {
          await redis.del(`oauth2:refresh_token:${tokenData.refreshToken}`)
        }

        // Log revocation
        await supabase
          .from('oauth2_token_events')
          .insert({
            client_id: tokenData.clientId,
            user_id: tokenData.userId,
            organization_id: tokenData.organizationId,
            event_type: 'token_revoked',
            access_token_hash: this.hashToken(token)
          })

        logger.info('OAuth2 token revoked', {
          clientId: tokenData.clientId,
          userId: tokenData.userId
        })
      }

    } catch (error) {
      logger.error('Token revocation failed', { error })
      throw error
    }
  }

  // Helper methods

  private async getClient(clientId: string): Promise<OAuth2Client | null> {
    try {
      const { data, error } = await supabase
        .from('oauth2_clients')
        .select('*')
        .eq('id', clientId)
        .single()

      if (error) return null

      return data as OAuth2Client

    } catch (error) {
      return null
    }
  }

  private async validateClientSecret(clientId: string, clientSecret: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('oauth2_clients')
        .select('client_secret_hash')
        .eq('id', clientId)
        .single()

      if (error || !data?.client_secret_hash) return false

      return this.verifySecret(clientSecret, data.client_secret_hash)

    } catch (error) {
      return false
    }
  }

  private generateClientId(): string {
    return crypto.randomBytes(16).toString('hex')
  }

  private generateClientSecret(): string {
    return crypto.randomBytes(32).toString('hex')
  }

  private generateAuthorizationCode(): string {
    return crypto.randomBytes(32).toString('base64url')
  }

  private generateAccessToken(payload: any): string {
    return jwt.sign(payload, process.env.JWT_SECRET!, {
      expiresIn: this.accessTokenTTL,
      issuer: 'sierra-sync',
      audience: 'sierra-sync-api'
    })
  }

  private generateRefreshToken(payload: any): string {
    return jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, {
      expiresIn: this.refreshTokenTTL,
      issuer: 'sierra-sync',
      audience: 'sierra-sync-refresh'
    })
  }

  private verifyCodeChallenge(
    codeVerifier: string,
    codeChallenge: string,
    method: 'S256' | 'plain'
  ): boolean {
    if (method === 'plain') {
      return codeVerifier === codeChallenge
    } else if (method === 'S256') {
      const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      return hash === codeChallenge
    }
    return false
  }

  private hashSecret(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex')
  }

  private verifySecret(secret: string, hash: string): boolean {
    return this.hashSecret(secret) === hash
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  static generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url')
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    
    return { codeVerifier, codeChallenge }
  }
}

export const oauth2PKCEService = new OAuth2PKCEService()