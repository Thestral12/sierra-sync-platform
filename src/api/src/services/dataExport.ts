import { createClient } from '@supabase/supabase-js'
import { Parser } from 'json2csv'
import xlsx from 'xlsx'
import JSZip from 'jszip'
import { logger } from '../utils/logger'
import { Redis } from 'ioredis'
import { v4 as uuidv4 } from 'uuid'
import AWS from 'aws-sdk'
import { EventEmitter } from 'events'

interface ExportRequest {
  id: string
  organizationId: string
  userId: string
  dataTypes: string[]
  format: 'csv' | 'xlsx' | 'json'
  dateRange?: {
    start: Date
    end: Date
  }
  filters?: Record<string, any>
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  downloadUrl?: string
  expiresAt?: Date
  createdAt: Date
  updatedAt: Date
}

interface ImportRequest {
  id: string
  organizationId: string
  userId: string
  dataType: string
  fileName: string
  fileSize: number
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'validating'
  progress: number
  totalRows: number
  processedRows: number
  errorRows: number
  errors: ImportError[]
  createdAt: Date
  updatedAt: Date
}

interface ImportError {
  row: number
  field: string
  error: string
  value?: any
}

interface DataExportConfig {
  redis: Redis
  supabaseUrl: string
  supabaseKey: string
  s3: {
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
  }
  maxFileSize: number
  expirationHours: number
}

export class DataExportService extends EventEmitter {
  private redis: Redis
  private supabase: any
  private s3: AWS.S3
  private config: DataExportConfig

  constructor(config: DataExportConfig) {
    super()
    
    this.config = config
    this.redis = config.redis
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)
    
    // Configure AWS S3
    this.s3 = new AWS.S3({
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey
    })
  }

  /**
   * Request data export
   */
  async requestExport(
    organizationId: string,
    userId: string,
    dataTypes: string[],
    format: 'csv' | 'xlsx' | 'json',
    options?: {
      dateRange?: { start: Date; end: Date }
      filters?: Record<string, any>
    }
  ): Promise<ExportRequest> {
    const exportRequest: ExportRequest = {
      id: uuidv4(),
      organizationId,
      userId,
      dataTypes,
      format,
      dateRange: options?.dateRange,
      filters: options?.filters,
      status: 'pending',
      progress: 0,
      expiresAt: new Date(Date.now() + this.config.expirationHours * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // Store export request
    const { error } = await this.supabase
      .from('export_requests')
      .insert({
        id: exportRequest.id,
        organization_id: organizationId,
        user_id: userId,
        data_types: dataTypes,
        format,
        date_range: options?.dateRange,
        filters: options?.filters,
        status: 'pending',
        progress: 0,
        expires_at: exportRequest.expiresAt?.toISOString(),
        created_at: exportRequest.createdAt.toISOString(),
        updated_at: exportRequest.updatedAt.toISOString()
      })

    if (error) throw error

    // Queue export job
    await this.redis.lpush('export_queue', JSON.stringify({
      requestId: exportRequest.id,
      organizationId,
      userId,
      dataTypes,
      format,
      options
    }))

    this.emit('export_requested', exportRequest)
    
    logger.info('Export request created', {
      requestId: exportRequest.id,
      organizationId,
      userId,
      dataTypes,
      format
    })

    return exportRequest
  }

  /**
   * Process export request
   */
  async processExport(requestId: string): Promise<void> {
    try {
      // Get export request
      const { data: request, error } = await this.supabase
        .from('export_requests')
        .select('*')
        .eq('id', requestId)
        .single()

      if (error || !request) {
        throw new Error(`Export request not found: ${requestId}`)
      }

      // Update status to processing
      await this.updateExportStatus(requestId, 'processing', 10)

      const exportData: Record<string, any[]> = {}
      
      // Export each data type
      for (const dataType of request.data_types) {
        exportData[dataType] = await this.exportDataType(
          dataType,
          request.organization_id,
          {
            dateRange: request.date_range,
            filters: request.filters
          }
        )
        
        // Update progress
        const progress = 10 + ((Object.keys(exportData).length / request.data_types.length) * 60)
        await this.updateExportStatus(requestId, 'processing', progress)
      }

      // Generate file based on format
      let fileContent: Buffer
      let fileName: string
      let contentType: string

      switch (request.format) {
        case 'csv':
          if (request.data_types.length === 1) {
            const parser = new Parser()
            fileContent = Buffer.from(parser.parse(exportData[request.data_types[0]]))
            fileName = `${request.data_types[0]}_export_${Date.now()}.csv`
            contentType = 'text/csv'
          } else {
            // Multiple CSV files in ZIP
            const zip = new JSZip()
            for (const [dataType, data] of Object.entries(exportData)) {
              const parser = new Parser()
              const csv = parser.parse(data)
              zip.file(`${dataType}.csv`, csv)
            }
            fileContent = await zip.generateAsync({ type: 'nodebuffer' })
            fileName = `export_${Date.now()}.zip`
            contentType = 'application/zip'
          }
          break

        case 'xlsx':
          const workbook = xlsx.utils.book_new()
          for (const [dataType, data] of Object.entries(exportData)) {
            const worksheet = xlsx.utils.json_to_sheet(data)
            xlsx.utils.book_append_sheet(workbook, worksheet, dataType.substring(0, 31))
          }
          fileContent = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' })
          fileName = `export_${Date.now()}.xlsx`
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          break

        case 'json':
          fileContent = Buffer.from(JSON.stringify(exportData, null, 2))
          fileName = `export_${Date.now()}.json`
          contentType = 'application/json'
          break

        default:
          throw new Error(`Unsupported format: ${request.format}`)
      }

      // Upload to S3
      await this.updateExportStatus(requestId, 'processing', 80)
      
      const s3Key = `exports/${request.organization_id}/${fileName}`
      
      await this.s3.upload({
        Bucket: this.config.s3.bucket,
        Key: s3Key,
        Body: fileContent,
        ContentType: contentType,
        Expires: request.expires_at ? new Date(request.expires_at) : undefined,
        Metadata: {
          organizationId: request.organization_id,
          userId: request.user_id,
          requestId: requestId
        }
      }).promise()

      // Generate signed URL
      const downloadUrl = await this.s3.getSignedUrlPromise('getObject', {
        Bucket: this.config.s3.bucket,
        Key: s3Key,
        Expires: this.config.expirationHours * 3600
      })

      // Update export request with download URL
      await this.updateExportStatus(requestId, 'completed', 100, downloadUrl)

      this.emit('export_completed', {
        requestId,
        organizationId: request.organization_id,
        userId: request.user_id,
        downloadUrl,
        fileName
      })

      logger.info('Export completed successfully', {
        requestId,
        fileName,
        size: fileContent.length
      })

    } catch (error) {
      await this.updateExportStatus(requestId, 'failed', 0)
      
      this.emit('export_failed', {
        requestId,
        error: error.message
      })

      logger.error('Export failed', {
        requestId,
        error: error.message,
        stack: error.stack
      })
      
      throw error
    }
  }

  /**
   * Export specific data type
   */
  private async exportDataType(
    dataType: string,
    organizationId: string,
    options?: {
      dateRange?: { start: Date; end: Date }
      filters?: Record<string, any>
    }
  ): Promise<any[]> {
    let query = this.supabase
      .from(dataType)
      .select('*')
      .eq('organization_id', organizationId)

    // Apply date range filter
    if (options?.dateRange) {
      query = query
        .gte('created_at', options.dateRange.start.toISOString())
        .lte('created_at', options.dateRange.end.toISOString())
    }

    // Apply additional filters
    if (options?.filters) {
      Object.entries(options.filters).forEach(([field, value]) => {
        if (Array.isArray(value)) {
          query = query.in(field, value)
        } else {
          query = query.eq(field, value)
        }
      })
    }

    const { data, error } = await query

    if (error) throw error

    // Transform data for export (remove internal fields, format dates)
    return data.map(row => {
      const cleaned = { ...row }
      delete cleaned.organization_id
      delete cleaned.id
      
      // Format dates
      Object.keys(cleaned).forEach(key => {
        if (key.includes('_at') && cleaned[key]) {
          cleaned[key] = new Date(cleaned[key]).toISOString()
        }
      })
      
      return cleaned
    })
  }

  /**
   * Update export status
   */
  private async updateExportStatus(
    requestId: string,
    status: ExportRequest['status'],
    progress: number,
    downloadUrl?: string
  ): Promise<void> {
    const updates: any = {
      status,
      progress,
      updated_at: new Date().toISOString()
    }

    if (downloadUrl) {
      updates.download_url = downloadUrl
    }

    const { error } = await this.supabase
      .from('export_requests')
      .update(updates)
      .eq('id', requestId)

    if (error) throw error
  }

  /**
   * Request data import
   */
  async requestImport(
    organizationId: string,
    userId: string,
    dataType: string,
    file: Buffer,
    fileName: string
  ): Promise<ImportRequest> {
    const importRequest: ImportRequest = {
      id: uuidv4(),
      organizationId,
      userId,
      dataType,
      fileName,
      fileSize: file.length,
      status: 'pending',
      progress: 0,
      totalRows: 0,
      processedRows: 0,
      errorRows: 0,
      errors: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // Upload file to S3 first
    const s3Key = `imports/${organizationId}/${importRequest.id}/${fileName}`
    
    await this.s3.upload({
      Bucket: this.config.s3.bucket,
      Key: s3Key,
      Body: file,
      Metadata: {
        organizationId,
        userId,
        requestId: importRequest.id,
        dataType
      }
    }).promise()

    // Store import request
    const { error } = await this.supabase
      .from('import_requests')
      .insert({
        id: importRequest.id,
        organization_id: organizationId,
        user_id: userId,
        data_type: dataType,
        file_name: fileName,
        file_size: file.length,
        s3_key: s3Key,
        status: 'pending',
        progress: 0,
        total_rows: 0,
        processed_rows: 0,
        error_rows: 0,
        errors: [],
        created_at: importRequest.createdAt.toISOString(),
        updated_at: importRequest.updatedAt.toISOString()
      })

    if (error) throw error

    // Queue import job
    await this.redis.lpush('import_queue', JSON.stringify({
      requestId: importRequest.id,
      organizationId,
      userId,
      dataType,
      s3Key
    }))

    this.emit('import_requested', importRequest)

    logger.info('Import request created', {
      requestId: importRequest.id,
      organizationId,
      userId,
      dataType,
      fileName,
      fileSize: file.length
    })

    return importRequest
  }

  /**
   * Process import request
   */
  async processImport(requestId: string): Promise<void> {
    try {
      // Get import request
      const { data: request, error } = await this.supabase
        .from('import_requests')
        .select('*')
        .eq('id', requestId)
        .single()

      if (error || !request) {
        throw new Error(`Import request not found: ${requestId}`)
      }

      // Update status to processing
      await this.updateImportStatus(requestId, 'validating', 10)

      // Download file from S3
      const s3Object = await this.s3.getObject({
        Bucket: this.config.s3.bucket,
        Key: request.s3_key
      }).promise()

      const fileContent = s3Object.Body as Buffer

      // Parse file based on extension
      let data: any[]
      const fileExt = request.file_name.split('.').pop()?.toLowerCase()

      switch (fileExt) {
        case 'csv':
          data = await this.parseCsv(fileContent)
          break
        case 'xlsx':
          data = await this.parseXlsx(fileContent)
          break
        case 'json':
          data = JSON.parse(fileContent.toString())
          if (!Array.isArray(data)) {
            throw new Error('JSON file must contain an array of objects')
          }
          break
        default:
          throw new Error(`Unsupported file format: ${fileExt}`)
      }

      await this.updateImportStatus(requestId, 'processing', 30, data.length)

      // Validate and import data
      const errors: ImportError[] = []
      let processedRows = 0

      for (let i = 0; i < data.length; i++) {
        const row = data[i]
        const rowNumber = i + 1

        try {
          // Validate row
          const validationErrors = await this.validateRow(row, request.data_type)
          if (validationErrors.length > 0) {
            errors.push(...validationErrors.map(error => ({
              row: rowNumber,
              field: error.field,
              error: error.message,
              value: error.value
            })))
            continue
          }

          // Import row
          await this.importRow(row, request.data_type, request.organization_id)
          processedRows++

          // Update progress every 100 rows
          if (i % 100 === 0) {
            const progress = 30 + ((i / data.length) * 60)
            await this.updateImportStatus(requestId, 'processing', progress, data.length, processedRows, errors.length, errors)
          }

        } catch (error) {
          errors.push({
            row: rowNumber,
            field: 'general',
            error: error.message
          })
        }
      }

      // Final update
      const status = errors.length === data.length ? 'failed' : 'completed'
      await this.updateImportStatus(requestId, status, 100, data.length, processedRows, errors.length, errors)

      this.emit('import_completed', {
        requestId,
        organizationId: request.organization_id,
        userId: request.user_id,
        totalRows: data.length,
        processedRows,
        errorRows: errors.length,
        status
      })

      logger.info('Import completed', {
        requestId,
        totalRows: data.length,
        processedRows,
        errorRows: errors.length,
        status
      })

    } catch (error) {
      await this.updateImportStatus(requestId, 'failed', 0)

      this.emit('import_failed', {
        requestId,
        error: error.message
      })

      logger.error('Import failed', {
        requestId,
        error: error.message,
        stack: error.stack
      })

      throw error
    }
  }

  /**
   * Parse CSV file
   */
  private async parseCsv(content: Buffer): Promise<any[]> {
    const csvParser = require('csv-parser')
    const { Readable } = require('stream')
    
    return new Promise((resolve, reject) => {
      const results: any[] = []
      const stream = new Readable()
      stream.push(content)
      stream.push(null)

      stream
        .pipe(csvParser())
        .on('data', (data: any) => results.push(data))
        .on('end', () => resolve(results))
        .on('error', (error: any) => reject(error))
    })
  }

  /**
   * Parse XLSX file
   */
  private async parseXlsx(content: Buffer): Promise<any[]> {
    const workbook = xlsx.read(content)
    const sheetName = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[sheetName]
    return xlsx.utils.sheet_to_json(worksheet)
  }

  /**
   * Validate row data
   */
  private async validateRow(row: any, dataType: string): Promise<Array<{ field: string; message: string; value?: any }>> {
    const errors: Array<{ field: string; message: string; value?: any }> = []

    // Get validation schema for data type
    const schema = this.getValidationSchema(dataType)

    Object.entries(schema).forEach(([field, rules]) => {
      const value = row[field]

      // Check required fields
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push({
          field,
          message: 'Field is required'
        })
      }

      // Check data types
      if (value !== undefined && value !== null && value !== '') {
        if (rules.type === 'email' && !this.isValidEmail(value)) {
          errors.push({
            field,
            message: 'Invalid email format',
            value
          })
        }

        if (rules.type === 'phone' && !this.isValidPhone(value)) {
          errors.push({
            field,
            message: 'Invalid phone format',
            value
          })
        }

        if (rules.type === 'number' && isNaN(Number(value))) {
          errors.push({
            field,
            message: 'Must be a valid number',
            value
          })
        }

        if (rules.type === 'date' && !this.isValidDate(value)) {
          errors.push({
            field,
            message: 'Invalid date format',
            value
          })
        }

        // Check max length
        if (rules.maxLength && String(value).length > rules.maxLength) {
          errors.push({
            field,
            message: `Exceeds maximum length of ${rules.maxLength}`,
            value
          })
        }
      }
    })

    return errors
  }

  /**
   * Get validation schema for data type
   */
  private getValidationSchema(dataType: string): Record<string, any> {
    const schemas: Record<string, any> = {
      leads: {
        firstName: { required: true, type: 'string', maxLength: 100 },
        lastName: { required: true, type: 'string', maxLength: 100 },
        email: { required: true, type: 'email' },
        phone: { required: false, type: 'phone' },
        leadScore: { required: false, type: 'number' },
        source: { required: false, type: 'string', maxLength: 50 }
      },
      contacts: {
        firstName: { required: true, type: 'string', maxLength: 100 },
        lastName: { required: true, type: 'string', maxLength: 100 },
        email: { required: true, type: 'email' },
        phone: { required: false, type: 'phone' },
        company: { required: false, type: 'string', maxLength: 200 }
      }
    }

    return schemas[dataType] || {}
  }

  /**
   * Import a single row
   */
  private async importRow(row: any, dataType: string, organizationId: string): Promise<void> {
    // Add organization_id and timestamps
    const importData = {
      ...row,
      organization_id: organizationId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { error } = await this.supabase
      .from(dataType)
      .insert(importData)

    if (error) throw error
  }

  /**
   * Update import status
   */
  private async updateImportStatus(
    requestId: string,
    status: ImportRequest['status'],
    progress: number,
    totalRows?: number,
    processedRows?: number,
    errorRows?: number,
    errors?: ImportError[]
  ): Promise<void> {
    const updates: any = {
      status,
      progress,
      updated_at: new Date().toISOString()
    }

    if (totalRows !== undefined) updates.total_rows = totalRows
    if (processedRows !== undefined) updates.processed_rows = processedRows
    if (errorRows !== undefined) updates.error_rows = errorRows
    if (errors !== undefined) updates.errors = errors

    const { error } = await this.supabase
      .from('import_requests')
      .update(updates)
      .eq('id', requestId)

    if (error) throw error
  }

  /**
   * Get export request status
   */
  async getExportStatus(requestId: string): Promise<ExportRequest | null> {
    const { data, error } = await this.supabase
      .from('export_requests')
      .select('*')
      .eq('id', requestId)
      .single()

    if (error) return null

    return {
      id: data.id,
      organizationId: data.organization_id,
      userId: data.user_id,
      dataTypes: data.data_types,
      format: data.format,
      dateRange: data.date_range,
      filters: data.filters,
      status: data.status,
      progress: data.progress,
      downloadUrl: data.download_url,
      expiresAt: data.expires_at ? new Date(data.expires_at) : undefined,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    }
  }

  /**
   * Get import request status
   */
  async getImportStatus(requestId: string): Promise<ImportRequest | null> {
    const { data, error } = await this.supabase
      .from('import_requests')
      .select('*')
      .eq('id', requestId)
      .single()

    if (error) return null

    return {
      id: data.id,
      organizationId: data.organization_id,
      userId: data.user_id,
      dataType: data.data_type,
      fileName: data.file_name,
      fileSize: data.file_size,
      status: data.status,
      progress: data.progress,
      totalRows: data.total_rows,
      processedRows: data.processed_rows,
      errorRows: data.error_rows,
      errors: data.errors,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    }
  }

  /**
   * Cleanup expired exports
   */
  async cleanupExpiredExports(): Promise<void> {
    try {
      // Get expired exports
      const { data: expiredExports, error } = await this.supabase
        .from('export_requests')
        .select('*')
        .eq('status', 'completed')
        .lt('expires_at', new Date().toISOString())

      if (error) throw error

      for (const exportReq of expiredExports) {
        if (exportReq.download_url) {
          // Delete from S3
          const s3Key = exportReq.download_url.split('/').pop()
          if (s3Key) {
            await this.s3.deleteObject({
              Bucket: this.config.s3.bucket,
              Key: `exports/${exportReq.organization_id}/${s3Key}`
            }).promise()
          }
        }

        // Update status to expired
        await this.supabase
          .from('export_requests')
          .update({ status: 'expired', download_url: null })
          .eq('id', exportReq.id)
      }

      logger.info(`Cleaned up ${expiredExports.length} expired exports`)
    } catch (error) {
      logger.error('Failed to cleanup expired exports:', error)
    }
  }

  // Validation helpers
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  private isValidPhone(phone: string): boolean {
    const phoneRegex = /^\+?[\d\s\-\(\)]{10,}$/
    return phoneRegex.test(phone)
  }

  private isValidDate(date: string): boolean {
    const parsedDate = new Date(date)
    return !isNaN(parsedDate.getTime())
  }
}