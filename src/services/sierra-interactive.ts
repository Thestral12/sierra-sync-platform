import axios, { AxiosInstance, AxiosError } from 'axios'
import PQueue from 'p-queue'
import { z } from 'zod'
import { Lead, Contact, Transaction } from '../types/sierra'
import { logger } from '../utils/logger'
import { encrypt, decrypt } from '../utils/crypto'

// Rate limiting queue - Sierra Interactive allows 5 requests per second
const queue = new PQueue({ 
  concurrency: 5, 
  interval: 1000, 
  intervalCap: 5 
})

// Sierra API response schemas
const SierraLeadSchema = z.object({
  id: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  lead_source: z.string().optional(),
  lead_score: z.number().optional(),
  status: z.string().optional(),
  assigned_to: z.string().optional(),
  property_interests: z.array(z.any()).optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.any()).optional(),
  created_at: z.string(),
  updated_at: z.string()
})

const SierraWebhookSchema = z.object({
  id: z.string(),
  event: z.string(),
  url: z.string().url(),
  secret: z.string(),
  active: z.boolean()
})

export interface SierraConfig {
  apiKey: string
  baseUrl: string
  tenantId: string
  webhookSecret?: string
}

export class SierraInteractiveAPI {
  private client: AxiosInstance
  private config: SierraConfig
  private accessToken?: string
  public tokenExpiry?: number

  constructor(config: SierraConfig) {
    this.config = config
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': config.tenantId
      }
    })

    // Add request interceptor for auth
    this.client.interceptors.request.use(
      async (config) => {
        if (this.tokenExpiry && Date.now() >= this.tokenExpiry) {
          await this.refreshToken()
        }
        if (this.accessToken) {
          config.headers.Authorization = `Bearer ${this.accessToken}`
        }
        return config
      },
      (error) => Promise.reject(error)
    )

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        if (error.response?.status === 429) {
          return this.handleRateLimit(error)
        }
        if (error.response?.status === 401) {
          await this.refreshToken()
          return this.client.request(error.config!)
        }
        return Promise.reject(error)
      }
    )
  }

  async authenticate(): Promise<boolean> {
    try {
      const response = await this.client.post('/auth/token', {
        api_key: this.config.apiKey,
        tenant_id: this.config.tenantId
      })

      this.accessToken = response.data.access_token
      this.tokenExpiry = Date.now() + (response.data.expires_in * 1000)
      
      logger.info('Successfully authenticated with Sierra Interactive')
      return true
    } catch (error) {
      logger.error('Sierra authentication failed:', error)
      throw new Error('Authentication failed')
    }
  }

  async refreshToken(): Promise<void> {
    await this.authenticate()
  }

  async makeAuthenticatedRequest(endpoint: string, options: any = {}): Promise<any> {
    if (!this.accessToken || (this.tokenExpiry && Date.now() >= this.tokenExpiry)) {
      await this.authenticate()
    }
    
    return queue.add(() => this.client.request({
      ...options,
      url: endpoint
    }))
  }

  async handleRateLimit(error: AxiosError): Promise<any> {
    const retryAfter = error.response?.headers['retry-after'] || '5'
    const delay = parseInt(retryAfter) * 1000
    
    logger.warn(`Rate limited by Sierra. Retrying after ${retryAfter} seconds`)
    
    await new Promise(resolve => setTimeout(resolve, delay))
    return this.client.request(error.config!)
  }

  async retryWithBackoff(fn: () => Promise<any>, maxRetries = 3): Promise<any> {
    let lastError
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        const delay = Math.min(1000 * Math.pow(2, i), 10000)
        logger.warn(`Retry ${i + 1}/${maxRetries} after ${delay}ms`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    
    throw lastError
  }

  // Lead Management Methods
  async getLeads(params: { 
    page?: number, 
    limit?: number, 
    filters?: any 
  } = {}): Promise<{
    data: Lead[],
    total: number,
    page: number
  }> {
    const response = await this.makeAuthenticatedRequest('/leads', {
      method: 'GET',
      params: {
        page: params.page || 1,
        limit: params.limit || 50,
        ...params.filters
      }
    })

    const validatedLeads = response.data.data.map((lead: any) => 
      SierraLeadSchema.parse(lead)
    )

    return {
      data: validatedLeads,
      total: response.data.total,
      page: response.data.page
    }
  }

  async getLeadById(leadId: string): Promise<Lead> {
    const response = await this.makeAuthenticatedRequest(`/leads/${leadId}`, {
      method: 'GET'
    })
    
    return SierraLeadSchema.parse(response.data)
  }

  async createLead(leadData: Partial<Lead>): Promise<Lead> {
    const response = await this.makeAuthenticatedRequest('/leads', {
      method: 'POST',
      data: leadData
    })
    
    return SierraLeadSchema.parse(response.data)
  }

  async updateLead(leadId: string, updates: Partial<Lead>): Promise<Lead> {
    const response = await this.makeAuthenticatedRequest(`/leads/${leadId}`, {
      method: 'PATCH',
      data: updates
    })
    
    return SierraLeadSchema.parse(response.data)
  }

  async deleteLead(leadId: string): Promise<boolean> {
    await this.makeAuthenticatedRequest(`/leads/${leadId}`, {
      method: 'DELETE'
    })
    
    return true
  }

  // Contact Management
  async createContact(contact: Partial<Contact>): Promise<any> {
    const response = await this.makeAuthenticatedRequest('/contacts', {
      method: 'POST',
      data: contact
    })
    
    return response.data
  }

  async batchSyncContacts(contacts: Contact[]): Promise<{
    successful: number,
    failed: number,
    errors: any[]
  }> {
    const chunks = this.chunkArray(contacts, 100)
    let successful = 0
    let failed = 0
    const errors: any[] = []

    for (const chunk of chunks) {
      try {
        const response = await this.makeAuthenticatedRequest('/contacts/batch', {
          method: 'POST',
          data: { contacts: chunk }
        })
        
        successful += response.data.successful
        failed += response.data.failed
        errors.push(...(response.data.errors || []))
      } catch (error) {
        failed += chunk.length
        errors.push(error)
      }
    }

    return { successful, failed, errors }
  }

  // Transaction Management
  async getTransactions(params: {
    startDate: string,
    endDate: string
  }): Promise<Transaction[]> {
    const response = await this.makeAuthenticatedRequest('/transactions', {
      method: 'GET',
      params
    })
    
    return response.data.data
  }

  async updateTransactionStatus(transactionId: string, status: string): Promise<Transaction> {
    const response = await this.makeAuthenticatedRequest(`/transactions/${transactionId}`, {
      method: 'PATCH',
      data: { status, closedAt: status === 'closed' ? new Date().toISOString() : undefined }
    })
    
    return response.data
  }

  // Webhook Management
  async registerWebhook(webhook: {
    event: string,
    url: string,
    secret: string
  }): Promise<any> {
    const response = await this.makeAuthenticatedRequest('/webhooks', {
      method: 'POST',
      data: webhook
    })
    
    return SierraWebhookSchema.parse(response.data)
  }

  async verifyWebhookSignature(payload: any, signature: string): boolean {
    if (!this.config.webhookSecret) return false
    
    const crypto = require('crypto')
    const expectedSignature = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex')
    
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )
  }

  async listWebhooks(): Promise<any[]> {
    const response = await this.makeAuthenticatedRequest('/webhooks', {
      method: 'GET'
    })
    
    return response.data.data.map((webhook: any) => 
      SierraWebhookSchema.parse(webhook)
    )
  }

  async deleteWebhook(webhookId: string): Promise<boolean> {
    await this.makeAuthenticatedRequest(`/webhooks/${webhookId}`, {
      method: 'DELETE'
    })
    
    return true
  }

  // Utility Methods
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.authenticate()
      await this.getLeads({ limit: 1 })
      return true
    } catch (error) {
      logger.error('Sierra connection test failed:', error)
      return false
    }
  }
}