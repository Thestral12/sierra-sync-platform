import { createClient } from '@supabase/supabase-js'
import Redis from 'ioredis'
import dotenv from 'dotenv'

// Load test environment variables
dotenv.config({ path: '.env.test' })

// Global test configuration
global.testConfig = {
  supabase: {
    url: process.env.SUPABASE_URL || 'http://localhost:54321',
    key: process.env.SUPABASE_ANON_KEY || 'test-key'
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/test_db'
  },
  stripe: {
    secretKey: process.env.STRIPE_TEST_SECRET_KEY || 'sk_test_test',
    publishableKey: process.env.STRIPE_TEST_PUBLISHABLE_KEY || 'pk_test_test'
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'test-jwt-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'test-refresh-secret'
  },
  api: {
    baseUrl: process.env.API_BASE_URL || 'http://localhost:3001'
  },
  n8n: {
    url: process.env.N8N_URL || 'http://localhost:5678',
    apiKey: process.env.N8N_API_KEY || 'test-n8n-key'
  }
}

// Global test utilities
global.testUtils = {
  supabase: null,
  redis: null,
  
  // Initialize test database connection
  async initDB() {
    if (!this.supabase) {
      this.supabase = createClient(
        global.testConfig.supabase.url,
        global.testConfig.supabase.key
      )
    }
    return this.supabase
  },
  
  // Initialize Redis connection
  async initRedis() {
    if (!this.redis) {
      this.redis = new Redis(global.testConfig.redis.url)
    }
    return this.redis
  },
  
  // Clean up test data
  async cleanup() {
    if (this.supabase) {
      // Clean up test data from all tables
      const tables = [
        'organizations', 'users', 'leads', 'crm_integrations',
        'sync_logs', 'analytics_events', 'support_tickets',
        'webhook_attempts', 'export_requests', 'import_requests',
        'gdpr_requests', 'consent_records'
      ]
      
      for (const table of tables) {
        await this.supabase
          .from(table)
          .delete()
          .like('email', '%@test.example%')
          .or('name.like.*test*')
      }
    }
    
    if (this.redis) {
      // Clean up test data from Redis
      const keys = await this.redis.keys('test:*')
      if (keys.length > 0) {
        await this.redis.del(...keys)
      }
    }
  },
  
  // Create test user
  async createTestUser(overrides = {}) {
    const supabase = await this.initDB()
    
    const userData = {
      email: 'test@test.example',
      first_name: 'Test',
      last_name: 'User',
      role: 'user',
      is_active: true,
      organization_id: null,
      ...overrides
    }
    
    const { data, error } = await supabase
      .from('users')
      .insert(userData)
      .select()
      .single()
    
    if (error) throw error
    return data
  },
  
  // Create test organization
  async createTestOrganization(overrides = {}) {
    const supabase = await this.initDB()
    
    const orgData = {
      name: 'Test Organization',
      email: 'admin@test.example',
      status: 'active',
      plan: 'pro',
      ...overrides
    }
    
    const { data, error } = await supabase
      .from('organizations')
      .insert(orgData)
      .select()
      .single()
    
    if (error) throw error
    return data
  },
  
  // Create test JWT token
  createTestToken(userId, organizationId) {
    const jwt = require('jsonwebtoken')
    
    return jwt.sign(
      {
        userId,
        organizationId,
        role: 'user',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour
      },
      global.testConfig.jwt.secret
    )
  },
  
  // Wait for condition
  async waitFor(conditionFn, timeout = 5000) {
    const startTime = Date.now()
    
    while (Date.now() - startTime < timeout) {
      if (await conditionFn()) {
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    throw new Error(`Condition not met within ${timeout}ms`)
  },
  
  // Generate test data
  generateTestData: {
    email: (prefix = 'test') => `${prefix}-${Date.now()}@test.example`,
    uuid: () => require('crypto').randomUUID(),
    randomString: (length = 10) => Math.random().toString(36).substring(2, length + 2),
    
    lead: (overrides = {}) => ({
      first_name: 'John',
      last_name: 'Doe',
      email: global.testUtils.generateTestData.email('lead'),
      phone: '+1234567890',
      lead_score: 85,
      source: 'test',
      ...overrides
    }),
    
    syncLog: (overrides = {}) => ({
      crm_type: 'hubspot',
      operation: 'create',
      status: 'success',
      records_processed: 1,
      records_successful: 1,
      records_failed: 0,
      duration: 1500,
      ...overrides
    })
  }
}

// Setup global mocks
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    customers: {
      create: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
      list: jest.fn()
    },
    subscriptions: {
      create: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
      list: jest.fn()
    },
    checkout: {
      sessions: {
        create: jest.fn(),
        retrieve: jest.fn()
      }
    },
    webhooks: {
      constructEvent: jest.fn()
    }
  }))
}))

// Mock external services
jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    patch: jest.fn()
  })),
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  patch: jest.fn()
}))

// Setup test database before each test
beforeEach(async () => {
  await global.testUtils.initDB()
  await global.testUtils.initRedis()
})

// Cleanup after each test
afterEach(async () => {
  await global.testUtils.cleanup()
})

// Global error handler for unhandled promises
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

// Increase timeout for async operations
jest.setTimeout(30000)