import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple health check route
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
    service: 'Sierra Sync API'
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Sierra Sync Platform API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      docs: '/api/docs',
      version: '/api/version'
    }
  });
});

// API version endpoint
app.get('/api/version', (req, res) => {
  res.json({
    version: '1.0.0',
    build: Date.now(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Basic API info
app.get('/api', (req, res) => {
  res.json({
    name: 'Sierra Sync API',
    version: '1.0.0',
    description: 'SaaS platform for real-time lead syncing between Sierra Interactive and CRMs',
    features: [
      'Real-time lead synchronization',
      'Multi-CRM support',
      'Advanced analytics',
      'Enterprise security',
      'Scalable architecture'
    ],
    status: 'operational'
  });
});

// Error handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: ['/', '/health', '/api', '/api/version']
  });
});

// Get random port between 3000-9999
const getRandomPort = () => {
  return Math.floor(Math.random() * (9999 - 3000 + 1)) + 3000;
};

const PORT = process.env.PORT || getRandomPort();

const server = createServer(app);

server.listen(PORT, () => {
  console.log('🚀 Sierra Sync API Server Started!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📍 Server running on: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 API info: http://localhost:${PORT}/api`);
  console.log(`🔢 Version: http://localhost:${PORT}/api/version`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Started at: ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Server ready to accept connections');
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