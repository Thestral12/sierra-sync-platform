import express from 'express'
import { authMiddleware } from '../middleware/auth'
import { rateLimiter } from '../middleware/rateLimiter'
import { validateInput } from '../middleware/validation'
import { z } from 'zod'

const router = express.Router()

// Validation schemas
const eventTrackingSchema = z.object({
  eventType: z.string(),
  eventName: z.string(),
  properties: z.record(z.any()).optional(),
  sessionId: z.string().optional(),
  deviceInfo: z.object({
    userAgent: z.string().optional(),
    ip: z.string().optional(),
    country: z.string().optional()
  }).optional()
})

const timeSeriesSchema = z.object({
  metric: z.string(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  granularity: z.enum(['minute', 'hour', 'day', 'week', 'month']),
  filters: z.record(z.any()).optional()
})

const dashboardSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  widgets: z.array(z.object({
    type: z.enum(['line_chart', 'bar_chart', 'pie_chart', 'metric_card', 'table', 'heatmap']),
    title: z.string().min(1).max(100),
    position: z.object({
      x: z.number().min(0),
      y: z.number().min(0),
      width: z.number().min(1),
      height: z.number().min(1)
    }),
    config: z.object({
      metrics: z.array(z.string()).min(1),
      dimensions: z.array(z.string()).optional(),
      filters: z.record(z.any()).optional(),
      aggregation: z.enum(['sum', 'avg', 'count', 'min', 'max']).optional(),
      timeRange: z.object({
        type: z.enum(['relative', 'absolute']),
        value: z.string()
      }).optional(),
      visualization: z.object({
        colorScheme: z.string().optional(),
        showLegend: z.boolean().optional(),
        showGrid: z.boolean().optional(),
        yAxisLabel: z.string().optional(),
        xAxisLabel: z.string().optional()
      }).optional()
    }),
    dataSource: z.object({
      type: z.enum(['postgres', 'redis', 'api']),
      query: z.string(),
      parameters: z.record(z.any()).optional(),
      cacheTtl: z.number().optional()
    })
  })),
  filters: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['date_range', 'select', 'multiselect', 'text']),
    options: z.array(z.string()).optional(),
    defaultValue: z.any().optional()
  })),
  refreshInterval: z.number().min(30).max(3600).optional(),
  isPublic: z.boolean().optional()
})

const funnelSchema = z.object({
  name: z.string().min(1).max(100),
  steps: z.array(z.object({
    name: z.string().min(1).max(50),
    eventName: z.string(),
    filters: z.record(z.any()).optional()
  })).min(2),
  conversionWindow: z.number().min(1).max(168) // Max 1 week
})

/**
 * @swagger
 * /api/analytics/track:
 *   post:
 *     summary: Track analytics event
 *     tags: [Analytics]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - eventType
 *               - eventName
 *             properties:
 *               eventType:
 *                 type: string
 *                 description: Category of the event (e.g., 'user_action', 'system_event')
 *               eventName:
 *                 type: string
 *                 description: Specific name of the event (e.g., 'lead_created', 'sync_completed')
 *               properties:
 *                 type: object
 *                 description: Additional event properties
 *               sessionId:
 *                 type: string
 *                 description: User session identifier
 *               deviceInfo:
 *                 type: object
 *                 properties:
 *                   userAgent:
 *                     type: string
 *                   ip:
 *                     type: string
 *                   country:
 *                     type: string
 *     responses:
 *       200:
 *         description: Event tracked successfully
 */
router.post('/track',
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 1000 }), // 1000 per minute
  validateInput(eventTrackingSchema),
  async (req: any, res) => {
    try {
      const { eventType, eventName, properties, sessionId, deviceInfo } = req.body

      // Get organization ID from authenticated user or header
      const organizationId = req.user?.organizationId || req.headers['x-organization-id']
      const userId = req.user?.id

      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'Organization ID required'
        })
      }

      const event = {
        organizationId,
        userId,
        eventType,
        eventName,
        properties: properties || {},
        timestamp: new Date(),
        sessionId,
        deviceInfo: {
          ...deviceInfo,
          ip: deviceInfo?.ip || req.ip,
          userAgent: deviceInfo?.userAgent || req.get('User-Agent')
        }
      }

      await req.app.locals.analyticsService.trackEvent(event)

      res.json({
        success: true,
        message: 'Event tracked successfully',
        timestamp: event.timestamp
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to track event',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/timeseries:
 *   post:
 *     summary: Get time series data for a metric
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - metric
 *               - start
 *               - end
 *               - granularity
 *             properties:
 *               metric:
 *                 type: string
 *                 description: Metric name to retrieve
 *               start:
 *                 type: string
 *                 format: date-time
 *               end:
 *                 type: string
 *                 format: date-time
 *               granularity:
 *                 type: string
 *                 enum: [minute, hour, day, week, month]
 *               filters:
 *                 type: object
 *     responses:
 *       200:
 *         description: Time series data retrieved
 */
router.post('/timeseries',
  authMiddleware,
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 100 }),
  validateInput(timeSeriesSchema),
  async (req: any, res) => {
    try {
      const { metric, start, end, granularity, filters } = req.body

      const timeRange = {
        start: new Date(start),
        end: new Date(end),
        granularity
      }

      const timeSeriesData = await req.app.locals.analyticsService.getTimeSeriesData(
        req.user.organizationId,
        metric,
        timeRange,
        filters
      )

      res.json({
        success: true,
        data: timeSeriesData
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve time series data',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/business-metrics:
 *   get:
 *     summary: Get comprehensive business metrics
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: start
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: end
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Business metrics retrieved
 */
router.get('/business-metrics',
  authMiddleware,
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 10 }),
  async (req: any, res) => {
    try {
      const start = req.query.start ? new Date(req.query.start) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const end = req.query.end ? new Date(req.query.end) : new Date()

      const dateRange = { start, end }

      const businessMetrics = await req.app.locals.analyticsService.getBusinessMetrics(
        req.user.organizationId,
        dateRange
      )

      res.json({
        success: true,
        data: businessMetrics,
        dateRange
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve business metrics',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/funnel:
 *   post:
 *     summary: Calculate funnel conversion rates
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - steps
 *             properties:
 *               name:
 *                 type: string
 *               steps:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     eventName:
 *                       type: string
 *                     filters:
 *                       type: object
 *               conversionWindow:
 *                 type: number
 *                 description: Hours for conversion window
 *               start:
 *                 type: string
 *                 format: date-time
 *               end:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Funnel analysis completed
 */
router.post('/funnel',
  authMiddleware,
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 10 }),
  async (req: any, res) => {
    try {
      const { name, steps, conversionWindow, start, end } = req.body

      const funnel = {
        id: crypto.randomUUID(),
        name,
        steps,
        conversionWindow: conversionWindow || 24
      }

      const dateRange = {
        start: start ? new Date(start) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        end: end ? new Date(end) : new Date()
      }

      const funnelResults = await req.app.locals.analyticsService.calculateFunnel(
        req.user.organizationId,
        funnel,
        dateRange
      )

      res.json({
        success: true,
        data: {
          funnel,
          dateRange,
          results: funnelResults
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to calculate funnel',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/cohort-retention:
 *   get:
 *     summary: Get cohort retention analysis
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cohortType
 *         schema:
 *           type: string
 *           enum: [weekly, monthly]
 *           default: monthly
 *     responses:
 *       200:
 *         description: Cohort retention data
 */
router.get('/cohort-retention',
  authMiddleware,
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 5 }),
  async (req: any, res) => {
    try {
      const cohortType = req.query.cohortType || 'monthly'

      const cohortData = await req.app.locals.analyticsService.calculateCohortRetention(
        req.user.organizationId,
        cohortType
      )

      res.json({
        success: true,
        data: {
          cohortType,
          cohorts: cohortData
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to calculate cohort retention',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/dashboards:
 *   post:
 *     summary: Create analytics dashboard
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - widgets
 *               - filters
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               widgets:
 *                 type: array
 *                 items:
 *                   type: object
 *               filters:
 *                 type: array
 *                 items:
 *                   type: object
 *               refreshInterval:
 *                 type: number
 *               isPublic:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Dashboard created successfully
 */
router.post('/dashboards',
  authMiddleware,
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 10 }),
  validateInput(dashboardSchema),
  async (req: any, res) => {
    try {
      const dashboardData = req.body

      const dashboard = await req.app.locals.analyticsService.createDashboard(
        req.user.organizationId,
        req.user.id,
        dashboardData
      )

      res.status(201).json({
        success: true,
        dashboard,
        message: 'Dashboard created successfully'
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to create dashboard',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/dashboards:
 *   get:
 *     summary: Get user's dashboards
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: includePublic
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: Dashboards retrieved
 */
router.get('/dashboards',
  authMiddleware,
  async (req: any, res) => {
    try {
      const includePublic = req.query.includePublic === 'true'

      let query = req.app.locals.supabase
        .from('analytics_dashboards')
        .select('*')
        .eq('organization_id', req.user.organizationId)

      if (!includePublic) {
        query = query.or(`created_by.eq.${req.user.id},is_public.eq.true`)
      }

      const { data: dashboards, error } = await query.order('created_at', { ascending: false })

      if (error) throw error

      res.json({
        success: true,
        dashboards: dashboards.map(d => ({
          id: d.id,
          name: d.name,
          description: d.description,
          widgetCount: d.widgets?.length || 0,
          isPublic: d.is_public,
          refreshInterval: d.refresh_interval,
          createdAt: d.created_at,
          updatedAt: d.updated_at
        }))
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve dashboards',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/dashboards/{dashboardId}:
 *   get:
 *     summary: Get dashboard with widget data
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: dashboardId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: filters
 *         schema:
 *           type: string
 *           description: JSON string of filters to apply
 *     responses:
 *       200:
 *         description: Dashboard data retrieved
 */
router.get('/dashboards/:dashboardId',
  authMiddleware,
  async (req: any, res) => {
    try {
      const { dashboardId } = req.params
      const filters = req.query.filters ? JSON.parse(req.query.filters) : {}

      // Get dashboard
      const { data: dashboard, error } = await req.app.locals.supabase
        .from('analytics_dashboards')
        .select('*')
        .eq('id', dashboardId)
        .eq('organization_id', req.user.organizationId)
        .single()

      if (error || !dashboard) {
        return res.status(404).json({
          success: false,
          error: 'Dashboard not found'
        })
      }

      // Get data for each widget
      const widgetDataPromises = dashboard.widgets.map(async (widget: any) => {
        try {
          const widgetData = await req.app.locals.analyticsService.getWidgetData(
            req.user.organizationId,
            widget,
            filters
          )
          return {
            widgetId: widget.id,
            data: widgetData,
            error: null
          }
        } catch (error) {
          return {
            widgetId: widget.id,
            data: null,
            error: error.message
          }
        }
      })

      const widgetResults = await Promise.all(widgetDataPromises)

      res.json({
        success: true,
        dashboard: {
          id: dashboard.id,
          name: dashboard.name,
          description: dashboard.description,
          widgets: dashboard.widgets,
          filters: dashboard.filters,
          refreshInterval: dashboard.refresh_interval,
          isPublic: dashboard.is_public,
          updatedAt: dashboard.updated_at
        },
        widgetData: widgetResults,
        appliedFilters: filters
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve dashboard',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/widgets/{widgetId}/data:
 *   get:
 *     summary: Get data for a specific widget
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: widgetId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: filters
 *         schema:
 *           type: string
 *           description: JSON string of filters to apply
 *     responses:
 *       200:
 *         description: Widget data retrieved
 */
router.get('/widgets/:widgetId/data',
  authMiddleware,
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 100 }),
  async (req: any, res) => {
    try {
      const { widgetId } = req.params
      const filters = req.query.filters ? JSON.parse(req.query.filters) : {}

      // Get widget from dashboard
      const { data: dashboards, error } = await req.app.locals.supabase
        .from('analytics_dashboards')
        .select('widgets')
        .eq('organization_id', req.user.organizationId)
        .contains('widgets', [{ id: widgetId }])

      if (error || !dashboards?.length) {
        return res.status(404).json({
          success: false,
          error: 'Widget not found'
        })
      }

      const widget = dashboards[0].widgets.find((w: any) => w.id === widgetId)

      if (!widget) {
        return res.status(404).json({
          success: false,
          error: 'Widget not found'
        })
      }

      const widgetData = await req.app.locals.analyticsService.getWidgetData(
        req.user.organizationId,
        widget,
        filters
      )

      res.json({
        success: true,
        data: widgetData,
        widget: {
          id: widget.id,
          type: widget.type,
          title: widget.title
        },
        appliedFilters: filters
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve widget data',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/analytics/export:
 *   post:
 *     summary: Export analytics data
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - metrics
 *               - start
 *               - end
 *             properties:
 *               metrics:
 *                 type: array
 *                 items:
 *                   type: string
 *               start:
 *                 type: string
 *                 format: date-time
 *               end:
 *                 type: string
 *                 format: date-time
 *               format:
 *                 type: string
 *                 enum: [csv, json, xlsx]
 *                 default: csv
 *               filters:
 *                 type: object
 *     responses:
 *       200:
 *         description: Export data or download URL
 */
router.post('/export',
  authMiddleware,
  rateLimiter('analytics', { windowMs: 60 * 1000, max: 5 }),
  async (req: any, res) => {
    try {
      const { metrics, start, end, format = 'csv', filters = {} } = req.body

      const dateRange = {
        start: new Date(start),
        end: new Date(end)
      }

      // Get data for each metric
      const exportData = {}
      
      for (const metric of metrics) {
        const timeSeriesData = await req.app.locals.analyticsService.getTimeSeriesData(
          req.user.organizationId,
          metric,
          {
            ...dateRange,
            granularity: 'day'
          },
          filters
        )
        
        exportData[metric] = timeSeriesData.dataPoints.map(dp => ({
          date: dp.timestamp.toISOString().split('T')[0],
          value: dp.value,
          ...dp.metadata
        }))
      }

      // For now, return JSON data directly
      // In production, you might want to generate files and return download URLs
      if (format === 'json') {
        res.json({
          success: true,
          data: exportData,
          metadata: {
            dateRange,
            metrics,
            filters,
            exportedAt: new Date().toISOString()
          }
        })
      } else {
        // For CSV/XLSX, you would typically generate a file and return a download URL
        res.json({
          success: true,
          message: 'Export functionality not fully implemented for this format',
          data: exportData
        })
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to export analytics data',
        details: error.message
      })
    }
  }
)

export default router