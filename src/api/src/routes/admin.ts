import express from 'express'
import { authMiddleware } from '../middleware/auth'
import { rateLimiter } from '../middleware/rateLimiter'
import { validateInput } from '../middleware/validation'
import { z } from 'zod'
import { logger } from '../utils/logger'

const router = express.Router()

// Admin role check middleware
const requireAdmin = (req: any, res: any, next: any) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    })
  }
  next()
}

// Validation schemas
const organizationUpdateSchema = z.object({
  name: z.string().optional(),
  status: z.enum(['active', 'suspended', 'cancelled']).optional(),
  plan: z.enum(['starter', 'pro', 'enterprise']).optional(),
  maxUsers: z.number().optional()
})

const alertResolveSchema = z.object({
  resolved: z.boolean().optional()
})

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Get admin dashboard statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalOrganizations:
 *                   type: number
 *                 totalUsers:
 *                   type: number
 *                 activeIntegrations:
 *                   type: number
 *                 syncEvents24h:
 *                   type: number
 *                 errorRate:
 *                   type: number
 *                 systemHealth:
 *                   type: string
 *                   enum: [healthy, degraded, unhealthy]
 *                 revenue:
 *                   type: object
 *                   properties:
 *                     mrr:
 *                       type: number
 *                     churn:
 *                       type: number
 *                     newSubscriptions:
 *                       type: number
 */
router.get('/stats',
  authMiddleware,
  requireAdmin,
  rateLimiter('admin', { windowMs: 60 * 1000, max: 100 }),
  async (req: any, res) => {
    try {
      // Get organization statistics
      const { data: orgStats, error: orgError } = await req.app.locals.supabase
        .from('organizations')
        .select('id, status, plan, created_at')

      if (orgError) throw orgError

      // Get user statistics
      const { data: userStats, error: userError } = await req.app.locals.supabase
        .from('users')
        .select('id, role, created_at')

      if (userError) throw userError

      // Get integration statistics
      const { data: integrationStats, error: integrationError } = await req.app.locals.supabase
        .from('crm_integrations')
        .select('id, is_active')

      if (integrationError) throw integrationError

      // Get sync events from last 24 hours
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const { data: syncEvents, error: syncError } = await req.app.locals.supabase
        .from('sync_logs')
        .select('id, status')
        .gte('created_at', yesterday.toISOString())

      if (syncError) throw syncError

      // Calculate error rate
      const errorEvents = syncEvents.filter(event => event.status === 'failed').length
      const errorRate = syncEvents.length > 0 ? (errorEvents / syncEvents.length) * 100 : 0

      // Get billing statistics (mock data - replace with actual Stripe queries)
      const revenue = {
        mrr: 45000, // Monthly Recurring Revenue
        churn: 2.5, // Churn rate percentage
        newSubscriptions: 12 // New subscriptions this month
      }

      // Get webhook statistics
      const webhookMetrics = await req.app.locals.webhookRetryService?.getWebhookMetrics('system', 1)
      const webhooks = {
        total: webhookMetrics?.summary.total || 0,
        successful: webhookMetrics?.summary.success || 0,
        failed: webhookMetrics?.summary.failed || 0
      }

      // Get export statistics
      const { data: exportStats, error: exportError } = await req.app.locals.supabase
        .from('export_requests')
        .select('status')

      if (exportError) throw exportError

      const exports = {
        pending: exportStats.filter(exp => exp.status === 'pending').length,
        processing: exportStats.filter(exp => exp.status === 'processing').length,
        completed: exportStats.filter(exp => exp.status === 'completed').length
      }

      // Determine system health
      let systemHealth: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
      
      if (errorRate > 20) {
        systemHealth = 'unhealthy'
      } else if (errorRate > 10 || exports.pending > 50) {
        systemHealth = 'degraded'
      }

      const stats = {
        totalOrganizations: orgStats.length,
        totalUsers: userStats.length,
        activeIntegrations: integrationStats.filter(int => int.is_active).length,
        syncEvents24h: syncEvents.length,
        errorRate: Math.round(errorRate * 100) / 100,
        systemHealth,
        revenue,
        webhooks,
        exports
      }

      res.json(stats)

    } catch (error) {
      logger.error('Failed to fetch admin stats:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to fetch statistics',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/alerts:
 *   get:
 *     summary: Get system alerts
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System alerts
 */
router.get('/alerts',
  authMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const { data: alerts, error } = await req.app.locals.supabase
        .from('system_alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) throw error

      res.json({
        success: true,
        alerts: alerts.map(alert => ({
          id: alert.id,
          type: alert.type,
          title: alert.title,
          message: alert.message,
          timestamp: alert.created_at,
          resolved: alert.resolved
        }))
      })

    } catch (error) {
      logger.error('Failed to fetch alerts:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to fetch alerts',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/alerts/{alertId}/resolve:
 *   post:
 *     summary: Resolve system alert
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: alertId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Alert resolved
 */
router.post('/alerts/:alertId/resolve',
  authMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const { alertId } = req.params

      const { error } = await req.app.locals.supabase
        .from('system_alerts')
        .update({
          resolved: true,
          resolved_at: new Date().toISOString(),
          resolved_by: req.user.id
        })
        .eq('id', alertId)

      if (error) throw error

      res.json({
        success: true,
        message: 'Alert resolved successfully'
      })

    } catch (error) {
      logger.error('Failed to resolve alert:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to resolve alert',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/organizations:
 *   get:
 *     summary: Get organizations with admin details
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, suspended, cancelled]
 *       - in: query
 *         name: plan
 *         schema:
 *           type: string
 *           enum: [starter, pro, enterprise]
 *     responses:
 *       200:
 *         description: Organizations list
 */
router.get('/organizations',
  authMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const page = parseInt(req.query.page) || 1
      const limit = Math.min(parseInt(req.query.limit) || 50, 100)
      const offset = (page - 1) * limit

      let query = req.app.locals.supabase
        .from('organizations')
        .select(`
          *,
          users(count)
        `, { count: 'exact' })

      // Apply filters
      if (req.query.status) {
        query = query.eq('status', req.query.status)
      }

      if (req.query.plan) {
        query = query.eq('plan', req.query.plan)
      }

      const { data: organizations, error, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw error

      res.json({
        success: true,
        organizations: organizations.map(org => ({
          id: org.id,
          name: org.name,
          email: org.email,
          status: org.status,
          plan: org.plan,
          userCount: org.users[0]?.count || 0,
          createdAt: org.created_at,
          updatedAt: org.updated_at
        })),
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit)
        }
      })

    } catch (error) {
      logger.error('Failed to fetch organizations:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to fetch organizations',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/organizations/{orgId}:
 *   put:
 *     summary: Update organization
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orgId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, suspended, cancelled]
 *               plan:
 *                 type: string
 *                 enum: [starter, pro, enterprise]
 *               maxUsers:
 *                 type: number
 *     responses:
 *       200:
 *         description: Organization updated
 */
router.put('/organizations/:orgId',
  authMiddleware,
  requireAdmin,
  validateInput(organizationUpdateSchema),
  async (req: any, res) => {
    try {
      const { orgId } = req.params
      const updates = req.body

      const { data, error } = await req.app.locals.supabase
        .from('organizations')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', orgId)
        .select()
        .single()

      if (error) throw error

      // Log admin action
      await req.app.locals.supabase
        .from('admin_audit_log')
        .insert({
          admin_id: req.user.id,
          action: 'organization_update',
          target_type: 'organization',
          target_id: orgId,
          changes: updates,
          created_at: new Date().toISOString()
        })

      res.json({
        success: true,
        organization: data,
        message: 'Organization updated successfully'
      })

    } catch (error) {
      logger.error('Failed to update organization:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to update organization',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Get users with admin details
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [admin, user]
 *       - in: query
 *         name: organizationId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Users list
 */
router.get('/users',
  authMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const page = parseInt(req.query.page) || 1
      const limit = Math.min(parseInt(req.query.limit) || 50, 100)
      const offset = (page - 1) * limit

      let query = req.app.locals.supabase
        .from('users')
        .select(`
          *,
          organizations(name, plan)
        `, { count: 'exact' })

      // Apply filters
      if (req.query.role) {
        query = query.eq('role', req.query.role)
      }

      if (req.query.organizationId) {
        query = query.eq('organization_id', req.query.organizationId)
      }

      const { data: users, error, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw error

      res.json({
        success: true,
        users: users.map(user => ({
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          isActive: user.is_active,
          organizationId: user.organization_id,
          organizationName: user.organizations?.name,
          organizationPlan: user.organizations?.plan,
          lastLogin: user.last_login,
          createdAt: user.created_at
        })),
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit)
        }
      })

    } catch (error) {
      logger.error('Failed to fetch users:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to fetch users',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/system/health:
 *   get:
 *     summary: Get detailed system health
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System health details
 */
router.get('/system/health',
  authMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const healthChecks = []

      // Database health
      try {
        await req.app.locals.supabase.from('users').select('id').limit(1)
        healthChecks.push({
          service: 'Database',
          status: 'healthy',
          responseTime: 50
        })
      } catch (error) {
        healthChecks.push({
          service: 'Database',
          status: 'unhealthy',
          error: error.message
        })
      }

      // Redis health
      try {
        await req.app.locals.redis.ping()
        healthChecks.push({
          service: 'Redis',
          status: 'healthy',
          responseTime: 10
        })
      } catch (error) {
        healthChecks.push({
          service: 'Redis',
          status: 'unhealthy',
          error: error.message
        })
      }

      // Webhook service health
      if (req.app.locals.webhookRetryService) {
        const webhookHealth = await req.app.locals.webhookRetryService.healthCheck()
        healthChecks.push({
          service: 'Webhook Service',
          status: webhookHealth.status,
          details: webhookHealth.details
        })
      }

      // Export service health
      if (req.app.locals.exportWorkerManager) {
        const exportHealth = await req.app.locals.exportWorkerManager.healthCheck()
        healthChecks.push({
          service: 'Export Service',
          status: exportHealth.status,
          details: exportHealth.details
        })
      }

      const overallStatus = healthChecks.every(check => check.status === 'healthy') 
        ? 'healthy' 
        : healthChecks.some(check => check.status === 'unhealthy') 
        ? 'unhealthy' 
        : 'degraded'

      res.json({
        success: true,
        overallStatus,
        services: healthChecks,
        timestamp: new Date().toISOString()
      })

    } catch (error) {
      logger.error('Failed to get system health:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to get system health',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/metrics:
 *   get:
 *     summary: Get system metrics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *           maximum: 30
 *     responses:
 *       200:
 *         description: System metrics
 */
router.get('/metrics',
  authMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const days = Math.min(parseInt(req.query.days) || 7, 30)

      // Get webhook metrics
      const webhookMetrics = req.app.locals.webhookRetryService 
        ? await req.app.locals.webhookRetryService.getWebhookMetrics('system', days)
        : null

      // Get export metrics
      const exportMetrics = req.app.locals.exportWorkerManager
        ? await req.app.locals.exportWorkerManager.getMetrics()
        : null

      // Get sync metrics from Redis
      const syncMetrics = {}
      for (let i = 0; i < days; i++) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        const dateStr = date.toISOString().split('T')[0]
        
        const key = `sync_metrics:${dateStr}`
        const dayMetrics = await req.app.locals.redis.hgetall(key)
        
        syncMetrics[dateStr] = {
          total: parseInt(dayMetrics.total || '0'),
          success: parseInt(dayMetrics.success || '0'),
          failed: parseInt(dayMetrics.failed || '0')
        }
      }

      res.json({
        success: true,
        metrics: {
          webhooks: webhookMetrics,
          exports: exportMetrics,
          syncs: syncMetrics
        },
        period: `${days} days`,
        timestamp: new Date().toISOString()
      })

    } catch (error) {
      logger.error('Failed to get metrics:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to get metrics',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/admin/audit-log:
 *   get:
 *     summary: Get admin audit log
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Audit log entries
 */
router.get('/audit-log',
  authMiddleware,
  requireAdmin,
  async (req: any, res) => {
    try {
      const page = parseInt(req.query.page) || 1
      const limit = Math.min(parseInt(req.query.limit) || 50, 100)
      const offset = (page - 1) * limit

      const { data: auditLog, error, count } = await req.app.locals.supabase
        .from('admin_audit_log')
        .select(`
          *,
          users(email, first_name, last_name)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw error

      res.json({
        success: true,
        auditLog: auditLog.map(entry => ({
          id: entry.id,
          action: entry.action,
          targetType: entry.target_type,
          targetId: entry.target_id,
          changes: entry.changes,
          adminEmail: entry.users?.email,
          adminName: `${entry.users?.first_name || ''} ${entry.users?.last_name || ''}`.trim(),
          createdAt: entry.created_at
        })),
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit)
        }
      })

    } catch (error) {
      logger.error('Failed to fetch audit log:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to fetch audit log',
        details: error.message
      })
    }
  }
)

export default router