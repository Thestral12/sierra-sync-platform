import express from 'express';
import request from 'supertest';

type NextFunction = (err?: any) => void;

type Middleware = (req: any, res: any, next: NextFunction) => void;

jest.mock('../middleware/auth', () => {
  const attachUser: Middleware = (req, _res, next) => {
    req.user = {
      id: 'test-user',
      organizationId: 'org-123',
      role: 'admin',
      email: 'admin@test.local'
    };
    next();
  };

  return {
    AuthService: class {
      async generateTokens() {
        return { accessToken: 'token', refreshToken: 'refresh', expiresIn: 900 };
      }

      async validateAccessToken() {
        return {
          userId: 'test-user',
          organizationId: 'org-123',
          role: 'admin',
          email: 'admin@test.local',
          sessionId: 'session'
        };
      }
    },
    authenticateToken: attachUser,
    authMiddleware: attachUser,
    requireRole: () => attachUser,
    requireOrganization: attachUser
  };
});

jest.mock('../middleware/rateLimiter', () => ({
  rateLimiter: () => ((req: any, _res: any, next: NextFunction) => next())
}));

jest.mock('../middleware/validation', () => ({
  validateInput: () => ((req: any, _res: any, next: NextFunction) => next())
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    })
  }
}));

import adminRouter from '../routes/admin';

describe('Admin stats smoke test', () => {
  const buildSupabaseStub = () => {
    const dataByTable: Record<string, any[]> = {
      organizations: [
        { id: 'org-123', status: 'active', plan: 'pro', created_at: new Date().toISOString() },
        { id: 'org-456', status: 'active', plan: 'starter', created_at: new Date().toISOString() }
      ],
      users: [
        { id: 'user-1', role: 'admin', created_at: new Date().toISOString() },
        { id: 'user-2', role: 'user', created_at: new Date().toISOString() },
        { id: 'user-3', role: 'user', created_at: new Date().toISOString() }
      ],
      crm_integrations: [
        { id: 'int-1', is_active: true },
        { id: 'int-2', is_active: false }
      ],
      sync_logs: [
        { id: 'log-1', status: 'success' },
        { id: 'log-2', status: 'failed' }
      ],
      export_requests: [
        { status: 'pending' },
        { status: 'processing' },
        { status: 'completed' }
      ]
    };

    const createBuilder = (table: string) => {
      const rows = dataByTable[table] || [];
      const result = { data: rows, error: null };

      const builder: any = {
        select: jest.fn(() => builder),
        gte: jest.fn(() => builder),
        order: jest.fn(() => builder),
        limit: jest.fn(() => builder),
        eq: jest.fn(() => builder),
        single: jest.fn(() => Promise.resolve({ data: rows[0] || null, error: null })),
        then: (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject)
      };

      return builder;
    };

    return {
      from: jest.fn((table: string) => createBuilder(table))
    };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns stats when locals are configured', async () => {
    const app = express();
    const supabaseMock = buildSupabaseStub();
    const webhookMetrics = { summary: { total: 3, success: 2, failed: 1 } };

    app.locals.supabase = supabaseMock;
    app.locals.analyticsService = { trackEvent: jest.fn() };
    app.locals.dataExportService = {};
    app.locals.gdprService = {};
    app.locals.webhookRetryService = {
      getWebhookMetrics: jest.fn().mockResolvedValue(webhookMetrics)
    };
    app.locals.exportWorkerManager = null;
    app.locals.redis = { ping: jest.fn().mockResolvedValue('PONG') };

    app.use('/admin', adminRouter);

    const response = await request(app).get('/admin/stats');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalOrganizations: 2,
      totalUsers: 3,
      activeIntegrations: 1,
      syncEvents24h: 2,
      exports: {
        pending: 1,
        processing: 1,
        completed: 1
      }
    });
    expect(app.locals.webhookRetryService.getWebhookMetrics).toHaveBeenCalledWith('system', 1);
    expect(supabaseMock.from).toHaveBeenCalledWith('organizations');
  });
});
