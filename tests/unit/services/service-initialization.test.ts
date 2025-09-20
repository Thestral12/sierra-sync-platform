jest.mock('ioredis', () => {
  const mockMulti = {
    setex: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([])
  }

  const RedisMock = jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    setex: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    quit: jest.fn().mockResolvedValue('OK'),
    multi: jest.fn().mockReturnValue(mockMulti)
  }))

  return RedisMock
})

jest.mock('@supabase/supabase-js', () => {
  const createQueryBuilder = () => {
    const builder: any = {}
    const chainableMethods = [
      'select',
      'insert',
      'update',
      'delete',
      'eq',
      'neq',
      'in',
      'like',
      'ilike',
      'or',
      'lt',
      'lte',
      'gt',
      'gte',
      'order',
      'limit',
      'range',
      'filter',
      'match',
      'contains',
      'overlaps'
    ] as const

    chainableMethods.forEach(method => {
      builder[method] = jest.fn().mockReturnValue(builder)
    })

    builder.single = jest.fn().mockResolvedValue({ data: null, error: null })
    builder.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
    builder.throwOnError = jest.fn().mockReturnValue(builder)

    return builder
  }

  return {
    createClient: jest.fn(() => ({
      from: jest.fn(() => createQueryBuilder()),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      channel: jest.fn(() => ({
        on: jest.fn().mockReturnThis(),
        subscribe: jest.fn()
      }))
    }))
  }
})

describe('Service module initialization', () => {
  const originalSupabaseUrl = process.env.SUPABASE_URL
  const originalSupabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

  beforeAll(() => {
    jest.useFakeTimers()
  })

  afterAll(() => {
    jest.useRealTimers()

    if (originalSupabaseUrl === undefined) {
      delete process.env.SUPABASE_URL
    } else {
      process.env.SUPABASE_URL = originalSupabaseUrl
    }

    if (originalSupabaseServiceKey === undefined) {
      delete process.env.SUPABASE_SERVICE_KEY
    } else {
      process.env.SUPABASE_SERVICE_KEY = originalSupabaseServiceKey
    }
  })

  beforeEach(() => {
    jest.resetModules()
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'test-service-role-key'
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.clearAllTimers()
  })

  it('initializes OAuth2PKCEService without module resolution errors', async () => {
    const module = await import('../../../src/api/src/services/oauth2Pkce')

    expect(() => new module.OAuth2PKCEService()).not.toThrow()
    expect(module.oauth2PKCEService).toBeInstanceOf(module.OAuth2PKCEService)
  })

  it('initializes ApiKeyRotationService without module resolution errors', async () => {
    const module = await import('../../../src/api/src/services/apiKeyRotation')

    expect(() => new module.ApiKeyRotationService()).not.toThrow()
    expect(module.apiKeyRotationService).toBeInstanceOf(module.ApiKeyRotationService)
  })
})
