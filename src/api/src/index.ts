import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { createClient } from '@supabase/supabase-js';

import { AnalyticsService } from './services/analytics';
import { DataExportService } from './services/dataExport';
import { GDPRService } from './services/gdpr';
import { WebhookRetryService } from './services/webhookRetry';
import redis from './utils/redis';
import { ExportWorkerManager } from './workers/exportWorker';

// Import routes
import healthRouter from './routes/health';
import authRouter from './routes/oauth2';
import adminRouter from './routes/admin';
import analyticsRouter from './routes/analytics';
import apiKeysRouter from './routes/apiKeys';
import exportRouter from './routes/export';
import gdprRouter from './routes/gdpr';

// Import middleware
import { authenticateToken } from './middleware/auth';

// Load environment variables
dotenv.config();

const app = express();

const supabaseUrl = process.env.SUPABASE_URL || 'http://localhost:54321';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_ANON_KEY
  || 'service-role-key';

const parseInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const s3Config = {
  bucket: process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'local-bucket',
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test-access-key',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test-secret-key'
};

const exportExpirationHours = parseInteger(process.env.EXPORT_EXPIRATION_HOURS, 24);
const exportMaxFileSize = parseInteger(process.env.EXPORT_MAX_FILE_SIZE, 50 * 1024 * 1024);

const analyticsAggregationIntervals = (process.env.ANALYTICS_AGGREGATION_INTERVALS || 'hour,day,week')
  .split(',')
  .map(interval => interval.trim())
  .filter(Boolean);

const analyticsService = new AnalyticsService({
  redis,
  supabaseUrl,
  supabaseKey,
  clickhouseUrl: process.env.CLICKHOUSE_URL,
  clickhouseToken: process.env.CLICKHOUSE_TOKEN,
  enableRealTime: process.env.ANALYTICS_ENABLE_REALTIME === 'true',
  retentionDays: parseInteger(process.env.ANALYTICS_RETENTION_DAYS, 90),
  aggregationIntervals: analyticsAggregationIntervals.length > 0
    ? analyticsAggregationIntervals
    : ['hour', 'day', 'week']
});

const dataExportService = new DataExportService({
  redis,
  supabaseUrl,
  supabaseKey,
  s3: s3Config,
  maxFileSize: exportMaxFileSize,
  expirationHours: exportExpirationHours
});

const gdprService = new GDPRService({
  redis,
  supabaseUrl,
  supabaseKey,
  s3: s3Config,
  defaultRetentionDays: parseInteger(process.env.GDPR_DEFAULT_RETENTION_DAYS, 365),
  anonymizationKey: process.env.GDPR_ANONYMIZATION_KEY || 'test-anonymization-key',
  dpoEmail: process.env.GDPR_DPO_EMAIL || 'dpo@example.com',
  companyName: process.env.COMPANY_NAME || 'Sierra Sync'
});

const webhookRetryDelays = (process.env.WEBHOOK_RETRY_DELAYS || '30,60,120,300')
  .split(',')
  .map(delay => parseInt(delay.trim(), 10))
  .filter(delay => !Number.isNaN(delay));

const webhookRetryService = new WebhookRetryService({
  redis,
  supabaseUrl,
  supabaseKey,
  defaultMaxAttempts: parseInteger(process.env.WEBHOOK_MAX_ATTEMPTS, 5),
  defaultRetryDelays: webhookRetryDelays.length > 0
    ? webhookRetryDelays
    : [30, 60, 120, 300],
  defaultTimeout: parseInteger(process.env.WEBHOOK_DEFAULT_TIMEOUT, 10000),
  maxPayloadSize: parseInteger(process.env.WEBHOOK_MAX_PAYLOAD_SIZE, 1024 * 1024),
  rateLimitWindow: parseInteger(process.env.WEBHOOK_RATE_LIMIT_WINDOW, 60),
  rateLimitMax: parseInteger(process.env.WEBHOOK_RATE_LIMIT_MAX, 100)
});

const exportWorkerConcurrency = Math.max(1, parseInteger(process.env.EXPORT_WORKER_CONCURRENCY, 2));

const exportWorkerManager = new ExportWorkerManager({
  redis,
  supabaseUrl,
  supabaseKey,
  s3Config,
  concurrency: exportWorkerConcurrency,
  maxFileSize: exportMaxFileSize,
  expirationHours: exportExpirationHours
});

app.locals.redis = redis;
app.locals.supabase = supabase;
app.locals.analyticsService = analyticsService;
app.locals.dataExportService = dataExportService;
app.locals.gdprService = gdprService;
app.locals.webhookRetryService = webhookRetryService;
app.locals.exportWorkerManager = exportWorkerManager;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Routes
app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/admin', authenticateToken, adminRouter);
app.use('/analytics', authenticateToken, analyticsRouter);
app.use('/api-keys', authenticateToken, apiKeysRouter);
app.use('/export', authenticateToken, exportRouter);
app.use('/gdpr', gdprRouter);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      message: err.message,
      details: err.details
    });
  }
  
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`
  });
});

// Get random port between 3000-9999
const getRandomPort = () => {
  return Math.floor(Math.random() * (9999 - 3000 + 1)) + 3000;
};

const PORT = process.env.PORT || getRandomPort();

const server = createServer(app);

server.listen(PORT, () => {
  console.log(`🚀 Sierra Sync API Server running on port ${PORT}`);
  console.log(`📍 Local URL: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed gracefully');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed gracefully');
    process.exit(0);
  });
});

export default app;