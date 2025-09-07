import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';

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