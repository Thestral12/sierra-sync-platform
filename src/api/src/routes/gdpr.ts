import express from 'express'
import { authMiddleware } from '../middleware/auth'
import { rateLimiter } from '../middleware/rateLimiter'
import { validateInput } from '../middleware/validation'
import { z } from 'zod'

const router = express.Router()

// Validation schemas
const gdprRequestSchema = z.object({
  type: z.enum(['access', 'portability', 'rectification', 'erasure', 'restriction']),
  description: z.string().optional(),
  dataTypes: z.array(z.string()).optional()
})

const consentSchema = z.object({
  email: z.string().email(),
  consentType: z.enum(['marketing', 'analytics', 'functional', 'necessary']),
  granted: z.boolean(),
  source: z.enum(['website', 'api', 'admin', 'import']).optional(),
  legalBasis: z.enum(['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests']).optional()
})

/**
 * @swagger
 * /api/gdpr/request:
 *   post:
 *     summary: Submit GDPR data subject request
 *     tags: [GDPR]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [access, portability, rectification, erasure, restriction]
 *                 description: Type of GDPR request
 *               description:
 *                 type: string
 *                 description: Additional description of the request
 *               dataTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Specific data types to include in request
 *     responses:
 *       202:
 *         description: GDPR request submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 requestId:
 *                   type: string
 *                 message:
 *                   type: string
 *                 estimatedTime:
 *                   type: string
 */
router.post('/request',
  authMiddleware,
  rateLimiter('gdpr', { windowMs: 24 * 60 * 60 * 1000, max: 5 }), // 5 requests per day
  validateInput(gdprRequestSchema),
  async (req: any, res) => {
    try {
      const { type, description, dataTypes } = req.body

      const gdprRequest = await req.app.locals.gdprService.submitGDPRRequest(
        req.user.organizationId,
        req.user.id,
        type,
        req.user.email,
        { description, dataTypes }
      )

      // Determine estimated processing time
      const estimatedTimes = {
        access: '3-5 business days',
        portability: '3-5 business days',
        rectification: '5-10 business days',
        erasure: '10-15 business days',
        restriction: '2-3 business days'
      }

      res.status(202).json({
        success: true,
        requestId: gdprRequest.id,
        message: `Your ${type} request has been submitted and will be processed according to GDPR requirements.`,
        estimatedTime: estimatedTimes[type],
        contactEmail: process.env.DPO_EMAIL || 'privacy@sierrasync.com'
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to submit GDPR request',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/requests:
 *   get:
 *     summary: Get user's GDPR requests
 *     tags: [GDPR]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, completed, rejected]
 *     responses:
 *       200:
 *         description: GDPR requests retrieved
 */
router.get('/requests',
  authMiddleware,
  async (req: any, res) => {
    try {
      let query = req.app.locals.supabase
        .from('gdpr_requests')
        .select('*')
        .eq('user_id', req.user.id)

      if (req.query.status) {
        query = query.eq('status', req.query.status)
      }

      const { data: requests, error } = await query.order('created_at', { ascending: false })

      if (error) throw error

      res.json({
        success: true,
        requests: requests.map(request => ({
          id: request.id,
          type: request.type,
          status: request.status,
          description: request.description,
          createdAt: request.created_at,
          completedAt: request.completed_at,
          hasResponse: !!request.response_data
        }))
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve GDPR requests',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/requests/{requestId}:
 *   get:
 *     summary: Get specific GDPR request details
 *     tags: [GDPR]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: GDPR request details
 */
router.get('/requests/:requestId',
  authMiddleware,
  async (req: any, res) => {
    try {
      const { requestId } = req.params

      const { data: request, error } = await req.app.locals.supabase
        .from('gdpr_requests')
        .select('*')
        .eq('id', requestId)
        .eq('user_id', req.user.id) // Ensure user can only see their own requests
        .single()

      if (error || !request) {
        return res.status(404).json({
          success: false,
          error: 'GDPR request not found'
        })
      }

      res.json({
        success: true,
        request: {
          id: request.id,
          type: request.type,
          status: request.status,
          description: request.description,
          dataTypes: request.data_types,
          responseData: request.response_data,
          createdAt: request.created_at,
          completedAt: request.completed_at,
          updatedAt: request.updated_at
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve GDPR request',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/consent:
 *   post:
 *     summary: Record user consent
 *     tags: [GDPR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - consentType
 *               - granted
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               consentType:
 *                 type: string
 *                 enum: [marketing, analytics, functional, necessary]
 *               granted:
 *                 type: boolean
 *               source:
 *                 type: string
 *                 enum: [website, api, admin, import]
 *               legalBasis:
 *                 type: string
 *                 enum: [consent, contract, legal_obligation, vital_interests, public_task, legitimate_interests]
 *     responses:
 *       200:
 *         description: Consent recorded successfully
 */
router.post('/consent',
  rateLimiter('consent', { windowMs: 60 * 1000, max: 50 }), // 50 per minute
  validateInput(consentSchema),
  async (req: any, res) => {
    try {
      const { email, consentType, granted, source, legalBasis } = req.body

      // Determine organization ID (could be from auth or header)
      const organizationId = req.user?.organizationId || req.headers['x-organization-id']

      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'Organization ID required'
        })
      }

      const consentRecord = await req.app.locals.gdprService.recordConsent(
        organizationId,
        email,
        consentType,
        granted,
        {
          userId: req.user?.id,
          source: source || 'api',
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          legalBasis: legalBasis || 'consent'
        }
      )

      res.json({
        success: true,
        consentId: consentRecord.id,
        message: `Consent ${granted ? 'granted' : 'revoked'} successfully`,
        timestamp: consentRecord.createdAt
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to record consent',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/consent/check:
 *   post:
 *     summary: Check user consent status
 *     tags: [GDPR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - consentType
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               consentType:
 *                 type: string
 *                 enum: [marketing, analytics, functional, necessary]
 *     responses:
 *       200:
 *         description: Consent status retrieved
 */
router.post('/consent/check',
  rateLimiter('consent', { windowMs: 60 * 1000, max: 100 }),
  async (req: any, res) => {
    try {
      const { email, consentType } = req.body

      const organizationId = req.user?.organizationId || req.headers['x-organization-id']

      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'Organization ID required'
        })
      }

      const { granted, consentRecord } = await req.app.locals.gdprService.checkConsent(
        organizationId,
        email,
        consentType
      )

      res.json({
        success: true,
        granted,
        consentRecord: consentRecord ? {
          id: consentRecord.id,
          grantedAt: consentRecord.grantedAt,
          revokedAt: consentRecord.revokedAt,
          expiresAt: consentRecord.expiresAt,
          source: consentRecord.source,
          legalBasis: consentRecord.legalBasis
        } : null
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to check consent',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/consent/history:
 *   get:
 *     summary: Get consent history for authenticated user
 *     tags: [GDPR]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Consent history retrieved
 */
router.get('/consent/history',
  authMiddleware,
  async (req: any, res) => {
    try {
      const consentHistory = await req.app.locals.gdprService.getConsentHistory(
        req.user.organizationId,
        req.user.email
      )

      res.json({
        success: true,
        consentHistory: consentHistory.map(consent => ({
          id: consent.id,
          consentType: consent.consentType,
          granted: consent.granted,
          source: consent.source,
          legalBasis: consent.legalBasis,
          grantedAt: consent.grantedAt,
          revokedAt: consent.revokedAt,
          expiresAt: consent.expiresAt,
          createdAt: consent.createdAt
        }))
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve consent history',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/privacy-notice:
 *   get:
 *     summary: Get current privacy notice
 *     tags: [GDPR]
 *     parameters:
 *       - in: query
 *         name: language
 *         schema:
 *           type: string
 *           default: en
 *     responses:
 *       200:
 *         description: Privacy notice retrieved
 */
router.get('/privacy-notice',
  async (req: any, res) => {
    try {
      const language = req.query.language || 'en'

      const { data: privacyNotice, error } = await req.app.locals.supabase
        .from('privacy_notices')
        .select('*')
        .eq('language', language)
        .eq('is_active', true)
        .order('effective_date', { ascending: false })
        .limit(1)
        .single()

      if (error || !privacyNotice) {
        return res.status(404).json({
          success: false,
          error: 'Privacy notice not found'
        })
      }

      res.json({
        success: true,
        privacyNotice: {
          id: privacyNotice.id,
          version: privacyNotice.version,
          content: privacyNotice.content,
          effectiveDate: privacyNotice.effective_date,
          language: privacyNotice.language
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve privacy notice',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/data-retention:
 *   get:
 *     summary: Get data retention policies
 *     tags: [GDPR]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Data retention policies retrieved
 */
router.get('/data-retention',
  authMiddleware,
  async (req: any, res) => {
    try {
      const retentionPolicies = await req.app.locals.gdprService.getDataRetentionPolicies()

      res.json({
        success: true,
        retentionPolicies: retentionPolicies.map(policy => ({
          dataType: policy.dataType,
          retentionPeriod: policy.retentionPeriod,
          legalBasis: policy.legalBasis,
          deletionMethod: policy.deletionMethod
        }))
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve data retention policies',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/gdpr/my-data:
 *   get:
 *     summary: Get summary of user's stored data (GDPR Article 15 - simplified)
 *     tags: [GDPR]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User data summary
 */
router.get('/my-data',
  authMiddleware,
  rateLimiter('gdpr', { windowMs: 60 * 60 * 1000, max: 10 }), // 10 per hour
  async (req: any, res) => {
    try {
      // Get user data summary without full export
      const { data: userData, error: userError } = await req.app.locals.supabase
        .from('users')
        .select('id, email, first_name, last_name, created_at, last_login')
        .eq('id', req.user.id)
        .single()

      if (userError) throw userError

      // Get leads count
      const { count: leadsCount } = await req.app.locals.supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', req.user.organizationId)

      // Get sync logs count
      const { count: syncLogsCount } = await req.app.locals.supabase
        .from('sync_logs')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', req.user.organizationId)

      // Get consent records
      const consentHistory = await req.app.locals.gdprService.getConsentHistory(
        req.user.organizationId,
        req.user.email
      )

      res.json({
        success: true,
        dataSummary: {
          profile: {
            email: userData.email,
            name: `${userData.first_name} ${userData.last_name}`,
            accountCreated: userData.created_at,
            lastLogin: userData.last_login
          },
          dataTypes: {
            leads: leadsCount,
            syncLogs: syncLogsCount,
            consentRecords: consentHistory.length
          },
          activeConsents: consentHistory.filter(c => c.granted).map(c => ({
            type: c.consentType,
            grantedAt: c.grantedAt,
            source: c.source
          })),
          rights: [
            'Request access to your data (Article 15)',
            'Request data portability (Article 20)',
            'Request rectification of your data (Article 16)',
            'Request erasure of your data (Article 17)',
            'Request restriction of processing (Article 18)',
            'Withdraw consent at any time'
          ]
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve data summary',
        details: error.message
      })
    }
  }
)

export default router