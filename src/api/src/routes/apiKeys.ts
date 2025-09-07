import { Router } from 'express'
import { body, param, query, validationResult } from 'express-validator'
import { authMiddleware } from '../middleware/auth'
import { apiKeyRotationService } from '../services/apiKeyRotation'
import { logger } from '../utils/logger'
import { monitoringService } from '../utils/monitoring'

const router = Router()

// Apply authentication to all routes
router.use(authMiddleware)

/**
 * GET /api/keys
 * List organization's API keys
 */
router.get('/', async (req, res) => {
  try {
    const organizationId = req.user?.organizationId

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: 'Organization ID required'
      })
    }

    const keys = await apiKeyRotationService.listApiKeys(organizationId)
    
    res.json({
      success: true,
      data: keys
    })

  } catch (error) {
    logger.error('Failed to list API keys', {
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'api_keys_list',
      user: req.user
    })

    res.status(500).json({
      success: false,
      error: 'Failed to list API keys'
    })
  }
})

/**
 * POST /api/keys
 * Create a new API key
 */
router.post('/', [
  body('name').isString().isLength({ min: 1, max: 100 }).withMessage('Name is required (1-100 characters)'),
  body('scopes').isArray().withMessage('Scopes must be an array'),
  body('scopes.*').isIn(['read', 'write', 'admin']).withMessage('Invalid scope'),
  body('expiresInDays').optional().isInt({ min: 1, max: 3650 }).withMessage('Expires in days must be between 1 and 3650'),
  body('rotationSchedule').optional().isIn(['never', 'weekly', 'monthly', 'quarterly', 'yearly']).withMessage('Invalid rotation schedule')
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

    const { name, scopes, expiresInDays, rotationSchedule } = req.body
    const organizationId = req.user?.organizationId

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: 'Organization ID required'
      })
    }

    const result = await apiKeyRotationService.generateApiKey(
      organizationId,
      name,
      scopes,
      expiresInDays
    )

    // Set rotation schedule if provided
    if (rotationSchedule && rotationSchedule !== 'never') {
      await apiKeyRotationService.setRotationSchedule(result.keyId, rotationSchedule)
    }

    res.status(201).json({
      success: true,
      data: {
        keyId: result.keyId,
        key: result.key, // Only returned once!
        name,
        scopes,
        createdAt: new Date().toISOString(),
        rotationSchedule: rotationSchedule || 'never'
      },
      warning: 'Store this key securely - it will not be shown again!'
    })

  } catch (error) {
    logger.error('Failed to create API key', {
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'api_key_creation',
      user: req.user
    })

    res.status(500).json({
      success: false,
      error: 'Failed to create API key'
    })
  }
})

/**
 * PUT /api/keys/:keyId/rotate
 * Rotate an API key
 */
router.put('/:keyId/rotate', [
  param('keyId').isUUID().withMessage('Invalid key ID'),
  body('reason').optional().isString().isLength({ max: 500 }).withMessage('Reason must be a string (max 500 characters)'),
  body('gracePeriodDays').optional().isInt({ min: 0, max: 30 }).withMessage('Grace period must be between 0 and 30 days')
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

    const { keyId } = req.params
    const { reason = 'Manual rotation', gracePeriodDays = 7 } = req.body

    const result = await apiKeyRotationService.rotateApiKey(
      keyId,
      'manual',
      reason,
      gracePeriodDays
    )

    res.json({
      success: true,
      data: {
        newKeyId: result.newKeyId,
        newKey: result.newKey, // Only returned once!
        oldKeyId: result.oldKeyId,
        gracePeriodDays,
        message: `Old key will expire in ${gracePeriodDays} days`
      },
      warning: 'Store this new key securely - it will not be shown again!'
    })

  } catch (error) {
    logger.error('Failed to rotate API key', {
      keyId: req.params.keyId,
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'api_key_rotation',
      user: req.user,
      extra: { keyId: req.params.keyId }
    })

    res.status(500).json({
      success: false,
      error: 'Failed to rotate API key'
    })
  }
})

/**
 * PUT /api/keys/:keyId/emergency-rotate
 * Emergency rotation (immediate deactivation)
 */
router.put('/:keyId/emergency-rotate', [
  param('keyId').isUUID().withMessage('Invalid key ID'),
  body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Reason is required (max 500 characters)')
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

    const { keyId } = req.params
    const { reason } = req.body

    const result = await apiKeyRotationService.emergencyRotateApiKey(keyId, reason)

    res.json({
      success: true,
      data: {
        newKeyId: result.newKeyId,
        newKey: result.newKey, // Only returned once!
        message: 'Old key has been immediately deactivated'
      },
      warning: 'Store this new key securely - it will not be shown again!'
    })

  } catch (error) {
    logger.error('Failed to perform emergency rotation', {
      keyId: req.params.keyId,
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'emergency_key_rotation',
      user: req.user,
      extra: { keyId: req.params.keyId }
    })

    res.status(500).json({
      success: false,
      error: 'Failed to perform emergency rotation'
    })
  }
})

/**
 * PUT /api/keys/:keyId/schedule
 * Set rotation schedule for a key
 */
router.put('/:keyId/schedule', [
  param('keyId').isUUID().withMessage('Invalid key ID'),
  body('schedule').isIn(['never', 'weekly', 'monthly', 'quarterly', 'yearly']).withMessage('Invalid rotation schedule')
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

    const { keyId } = req.params
    const { schedule } = req.body

    await apiKeyRotationService.setRotationSchedule(keyId, schedule)

    res.json({
      success: true,
      message: `Rotation schedule updated to: ${schedule}`
    })

  } catch (error) {
    logger.error('Failed to update rotation schedule', {
      keyId: req.params.keyId,
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'rotation_schedule_update',
      user: req.user,
      extra: { keyId: req.params.keyId }
    })

    res.status(500).json({
      success: false,
      error: 'Failed to update rotation schedule'
    })
  }
})

/**
 * GET /api/keys/:keyId/usage
 * Get API key usage statistics
 */
router.get('/:keyId/usage', [
  param('keyId').isUUID().withMessage('Invalid key ID')
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

    const { keyId } = req.params

    const usage = await apiKeyRotationService.getKeyUsageStats(keyId)

    res.json({
      success: true,
      data: usage
    })

  } catch (error) {
    logger.error('Failed to get key usage stats', {
      keyId: req.params.keyId,
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'key_usage_stats',
      user: req.user,
      extra: { keyId: req.params.keyId }
    })

    res.status(500).json({
      success: false,
      error: 'Failed to get usage statistics'
    })
  }
})

/**
 * DELETE /api/keys/:keyId
 * Revoke an API key
 */
router.delete('/:keyId', [
  param('keyId').isUUID().withMessage('Invalid key ID'),
  body('reason').optional().isString().isLength({ max: 500 }).withMessage('Reason must be a string (max 500 characters)')
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

    const { keyId } = req.params
    const { reason = 'Manual revocation' } = req.body

    await apiKeyRotationService.revokeApiKey(keyId, reason)

    res.json({
      success: true,
      message: 'API key revoked successfully'
    })

  } catch (error) {
    logger.error('Failed to revoke API key', {
      keyId: req.params.keyId,
      organizationId: req.user?.organizationId,
      error
    })

    monitoringService.captureException(error, {
      context: 'api_key_revocation',
      user: req.user,
      extra: { keyId: req.params.keyId }
    })

    res.status(500).json({
      success: false,
      error: 'Failed to revoke API key'
    })
  }
})

export default router