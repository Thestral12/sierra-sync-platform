import express from 'express'
import multer from 'multer'
import { DataExportService } from '../services/dataExport'
import { authMiddleware } from '../middleware/auth'
import { validateInput } from '../middleware/validation'
import { rateLimiter } from '../middleware/rateLimiter'
import { z } from 'zod'

const router = express.Router()

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/json']
    const allowedExtensions = ['.csv', '.xlsx', '.json']
    
    const hasValidType = allowedTypes.includes(file.mimetype)
    const hasValidExtension = allowedExtensions.some(ext => file.originalname.toLowerCase().endsWith(ext))
    
    if (hasValidType || hasValidExtension) {
      cb(null, true)
    } else {
      cb(new Error('Invalid file type. Only CSV, XLSX, and JSON files are allowed.'))
    }
  }
})

// Validation schemas
const exportRequestSchema = z.object({
  dataTypes: z.array(z.enum(['leads', 'contacts', 'sync_logs', 'integrations'])),
  format: z.enum(['csv', 'xlsx', 'json']),
  dateRange: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }).optional(),
  filters: z.record(z.any()).optional()
})

const importRequestSchema = z.object({
  dataType: z.enum(['leads', 'contacts'])
})

/**
 * @swagger
 * /api/export/request:
 *   post:
 *     summary: Request data export
 *     tags: [Export/Import]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - dataTypes
 *               - format
 *             properties:
 *               dataTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [leads, contacts, sync_logs, integrations]
 *                 example: ["leads", "contacts"]
 *               format:
 *                 type: string
 *                 enum: [csv, xlsx, json]
 *                 example: "xlsx"
 *               dateRange:
 *                 type: object
 *                 properties:
 *                   start:
 *                     type: string
 *                     format: date-time
 *                   end:
 *                     type: string
 *                     format: date-time
 *               filters:
 *                 type: object
 *                 additionalProperties: true
 *     responses:
 *       202:
 *         description: Export request accepted
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
  rateLimiter('export', { windowMs: 15 * 60 * 1000, max: 5 }), // 5 exports per 15 minutes
  validateInput(exportRequestSchema),
  async (req: any, res) => {
    try {
      const { dataTypes, format, dateRange, filters } = req.body
      
      const exportRequest = await req.app.locals.dataExportService.requestExport(
        req.user.organizationId,
        req.user.id,
        dataTypes,
        format,
        {
          dateRange: dateRange ? {
            start: new Date(dateRange.start),
            end: new Date(dateRange.end)
          } : undefined,
          filters
        }
      )

      res.status(202).json({
        success: true,
        requestId: exportRequest.id,
        message: 'Export request accepted. You will be notified when ready.',
        estimatedTime: '5-15 minutes'
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to process export request',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/export/status/{requestId}:
 *   get:
 *     summary: Get export status
 *     tags: [Export/Import]
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
 *         description: Export status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                   enum: [pending, processing, completed, failed]
 *                 progress:
 *                   type: number
 *                   minimum: 0
 *                   maximum: 100
 *                 downloadUrl:
 *                   type: string
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 */
router.get('/status/:requestId',
  authMiddleware,
  async (req: any, res) => {
    try {
      const { requestId } = req.params
      
      const exportRequest = await req.app.locals.dataExportService.getExportStatus(requestId)
      
      if (!exportRequest) {
        return res.status(404).json({
          success: false,
          error: 'Export request not found'
        })
      }

      // Verify user owns this request
      if (exportRequest.organizationId !== req.user.organizationId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      res.json({
        success: true,
        status: exportRequest.status,
        progress: exportRequest.progress,
        downloadUrl: exportRequest.downloadUrl,
        expiresAt: exportRequest.expiresAt,
        createdAt: exportRequest.createdAt,
        dataTypes: exportRequest.dataTypes,
        format: exportRequest.format
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get export status',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/export/history:
 *   get:
 *     summary: Get export history
 *     tags: [Export/Import]
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
 *           default: 10
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Export history retrieved
 */
router.get('/history',
  authMiddleware,
  async (req: any, res) => {
    try {
      const page = parseInt(req.query.page) || 1
      const limit = Math.min(parseInt(req.query.limit) || 10, 100)
      const offset = (page - 1) * limit

      const { data: exports, error, count } = await req.app.locals.supabase
        .from('export_requests')
        .select('*', { count: 'exact' })
        .eq('organization_id', req.user.organizationId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw error

      res.json({
        success: true,
        exports: exports.map(exp => ({
          id: exp.id,
          dataTypes: exp.data_types,
          format: exp.format,
          status: exp.status,
          progress: exp.progress,
          createdAt: exp.created_at,
          expiresAt: exp.expires_at,
          downloadUrl: exp.download_url
        })),
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit)
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get export history',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/import/upload:
 *   post:
 *     summary: Upload file for import
 *     tags: [Export/Import]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - dataType
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               dataType:
 *                 type: string
 *                 enum: [leads, contacts]
 *     responses:
 *       202:
 *         description: Import request accepted
 */
router.post('/upload',
  authMiddleware,
  rateLimiter('import', { windowMs: 15 * 60 * 1000, max: 3 }), // 3 imports per 15 minutes
  upload.single('file'),
  validateInput(importRequestSchema),
  async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        })
      }

      const { dataType } = req.body

      const importRequest = await req.app.locals.dataExportService.requestImport(
        req.user.organizationId,
        req.user.id,
        dataType,
        req.file.buffer,
        req.file.originalname
      )

      res.status(202).json({
        success: true,
        requestId: importRequest.id,
        message: 'Import request accepted. Processing will begin shortly.',
        fileName: req.file.originalname,
        fileSize: req.file.size
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to process import request',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/import/status/{requestId}:
 *   get:
 *     summary: Get import status
 *     tags: [Export/Import]
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
 *         description: Import status retrieved
 */
router.get('/status/:requestId',
  authMiddleware,
  async (req: any, res) => {
    try {
      const { requestId } = req.params
      
      const importRequest = await req.app.locals.dataExportService.getImportStatus(requestId)
      
      if (!importRequest) {
        return res.status(404).json({
          success: false,
          error: 'Import request not found'
        })
      }

      // Verify user owns this request
      if (importRequest.organizationId !== req.user.organizationId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      res.json({
        success: true,
        status: importRequest.status,
        progress: importRequest.progress,
        totalRows: importRequest.totalRows,
        processedRows: importRequest.processedRows,
        errorRows: importRequest.errorRows,
        errors: importRequest.errors,
        createdAt: importRequest.createdAt,
        fileName: importRequest.fileName,
        dataType: importRequest.dataType
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get import status',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/import/history:
 *   get:
 *     summary: Get import history
 *     tags: [Export/Import]
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
 *           default: 10
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Import history retrieved
 */
router.get('/history',
  authMiddleware,
  async (req: any, res) => {
    try {
      const page = parseInt(req.query.page) || 1
      const limit = Math.min(parseInt(req.query.limit) || 10, 100)
      const offset = (page - 1) * limit

      const { data: imports, error, count } = await req.app.locals.supabase
        .from('import_requests')
        .select('*', { count: 'exact' })
        .eq('organization_id', req.user.organizationId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw error

      res.json({
        success: true,
        imports: imports.map(imp => ({
          id: imp.id,
          dataType: imp.data_type,
          fileName: imp.file_name,
          fileSize: imp.file_size,
          status: imp.status,
          progress: imp.progress,
          totalRows: imp.total_rows,
          processedRows: imp.processed_rows,
          errorRows: imp.error_rows,
          createdAt: imp.created_at
        })),
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit)
        }
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to get import history',
        details: error.message
      })
    }
  }
)

/**
 * @swagger
 * /api/import/template/{dataType}:
 *   get:
 *     summary: Download import template
 *     tags: [Export/Import]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: dataType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [leads, contacts]
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [csv, xlsx]
 *           default: csv
 *     responses:
 *       200:
 *         description: Template file
 */
router.get('/template/:dataType',
  authMiddleware,
  async (req: any, res) => {
    try {
      const { dataType } = req.params
      const format = req.query.format || 'csv'

      // Define templates
      const templates = {
        leads: [
          {
            firstName: 'John',
            lastName: 'Doe',
            email: 'john.doe@example.com',
            phone: '+1234567890',
            leadScore: 85,
            source: 'Website'
          }
        ],
        contacts: [
          {
            firstName: 'Jane',
            lastName: 'Smith',
            email: 'jane.smith@example.com',
            phone: '+1234567890',
            company: 'Acme Corp'
          }
        ]
      }

      const templateData = templates[dataType]
      if (!templateData) {
        return res.status(404).json({
          success: false,
          error: 'Template not found'
        })
      }

      if (format === 'csv') {
        const { Parser } = require('json2csv')
        const parser = new Parser()
        const csv = parser.parse(templateData)
        
        res.setHeader('Content-Type', 'text/csv')
        res.setHeader('Content-Disposition', `attachment; filename="${dataType}_template.csv"`)
        res.send(csv)
      } else if (format === 'xlsx') {
        const xlsx = require('xlsx')
        const workbook = xlsx.utils.book_new()
        const worksheet = xlsx.utils.json_to_sheet(templateData)
        xlsx.utils.book_append_sheet(workbook, worksheet, dataType)
        
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' })
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', `attachment; filename="${dataType}_template.xlsx"`)
        res.send(buffer)
      } else {
        return res.status(400).json({
          success: false,
          error: 'Unsupported format'
        })
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to generate template',
        details: error.message
      })
    }
  }
)

export default router