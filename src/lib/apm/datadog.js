// DataDog APM Integration for Sierra Sync
// Provides distributed tracing, profiling, and custom metrics

const tracer = require('dd-trace');
const StatsD = require('hot-shots');

// Initialize DataDog APM tracer
const initializeAPM = () => {
  // Initialize tracer with configuration
  tracer.init({
    // Service configuration
    service: process.env.DD_SERVICE || 'sierra-sync-api',
    env: process.env.DD_ENV || process.env.NODE_ENV || 'development',
    version: process.env.DD_VERSION || process.env.npm_package_version || '1.0.0',
    
    // APM configuration
    hostname: process.env.DD_AGENT_HOST || 'localhost',
    port: process.env.DD_TRACE_AGENT_PORT || 8126,
    
    // Logging
    logInjection: true,
    debug: process.env.DD_TRACE_DEBUG === 'true',
    
    // Sampling
    sampleRate: parseFloat(process.env.DD_TRACE_SAMPLE_RATE || '1.0'),
    
    // Runtime metrics
    runtimeMetrics: true,
    
    // Profiling
    profiling: process.env.DD_PROFILING_ENABLED === 'true',
    
    // Tags
    tags: {
      'service.name': process.env.DD_SERVICE || 'sierra-sync-api',
      'deployment.environment': process.env.DD_ENV || process.env.NODE_ENV,
      'git.commit.sha': process.env.GIT_COMMIT_SHA,
      'git.repository_url': process.env.GIT_REPOSITORY_URL,
      'runtime': 'nodejs',
      'runtime.version': process.version,
    },
    
    // Automatic instrumentation
    plugins: true,
    
    // Database configuration
    dbmPropagationMode: 'full',
    
    // Security
    appsec: process.env.DD_APPSEC_ENABLED === 'true',
  });
  
  // Configure automatic instrumentation for common libraries
  tracer.use('express', {
    hooks: {
      request: (span, req, res) => {
        // Add custom tags to request spans
        span.setTag('http.url', req.url);
        span.setTag('user.id', req.user?.id);
        span.setTag('organization.id', req.organization?.id);
      },
    },
  });
  
  tracer.use('pg', {
    service: 'sierra-sync-postgres',
    hooks: {
      query: (span, params) => {
        // Add query metadata
        span.setTag('db.type', 'postgresql');
        span.setTag('db.instance', process.env.DB_NAME);
      },
    },
  });
  
  tracer.use('redis', {
    service: 'sierra-sync-redis',
    hooks: {
      command: (span, args) => {
        // Add Redis command metadata
        span.setTag('redis.command', args[0]);
      },
    },
  });
  
  tracer.use('http', {
    hooks: {
      request: (span, options) => {
        // Add HTTP client metadata
        span.setTag('http.host', options.hostname || options.host);
        span.setTag('http.path', options.path);
      },
    },
  });
  
  return tracer;
};

// Initialize StatsD client for custom metrics
const initializeStatsD = () => {
  const dogstatsd = new StatsD({
    host: process.env.DD_DOGSTATSD_HOST || 'localhost',
    port: process.env.DD_DOGSTATSD_PORT || 8125,
    prefix: 'sierra_sync.',
    globalTags: [
      `env:${process.env.DD_ENV || process.env.NODE_ENV}`,
      `service:${process.env.DD_SERVICE || 'sierra-sync-api'}`,
      `version:${process.env.DD_VERSION || '1.0.0'}`,
    ],
    errorHandler: (error) => {
      console.error('StatsD error:', error);
    },
  });
  
  return dogstatsd;
};

// Custom span creation helper
const createSpan = (name, options = {}) => {
  const span = tracer.startSpan(name, {
    childOf: tracer.scope().active(),
    ...options,
  });
  
  return {
    span,
    finish: (error = null) => {
      if (error) {
        span.setTag('error', true);
        span.setTag('error.type', error.name);
        span.setTag('error.message', error.message);
        span.setTag('error.stack', error.stack);
      }
      span.finish();
    },
  };
};

// Async function wrapper with tracing
const traceAsync = (name, fn) => {
  return async (...args) => {
    const { span, finish } = createSpan(name);
    
    try {
      const result = await fn(...args);
      finish();
      return result;
    } catch (error) {
      finish(error);
      throw error;
    }
  };
};

// Express middleware for custom tracing
const tracingMiddleware = () => {
  return (req, res, next) => {
    const span = tracer.scope().active();
    
    if (span) {
      // Add request metadata
      span.setTag('http.method', req.method);
      span.setTag('http.url', req.url);
      span.setTag('http.remote_addr', req.ip);
      span.setTag('http.user_agent', req.get('user-agent'));
      
      // Add user context
      if (req.user) {
        span.setTag('user.id', req.user.id);
        span.setTag('user.email', req.user.email);
        span.setTag('user.role', req.user.role);
      }
      
      // Add organization context
      if (req.organization) {
        span.setTag('organization.id', req.organization.id);
        span.setTag('organization.name', req.organization.name);
        span.setTag('organization.plan', req.organization.plan);
      }
      
      // Track response
      const originalSend = res.send;
      res.send = function(data) {
        span.setTag('http.status_code', res.statusCode);
        
        if (res.statusCode >= 400) {
          span.setTag('error', true);
          if (res.statusCode >= 500) {
            span.setTag('error.type', 'server_error');
          } else {
            span.setTag('error.type', 'client_error');
          }
        }
        
        return originalSend.call(this, data);
      };
    }
    
    next();
  };
};

// Error tracking middleware
const errorTrackingMiddleware = () => {
  return (err, req, res, next) => {
    const span = tracer.scope().active();
    
    if (span) {
      span.setTag('error', true);
      span.setTag('error.type', err.name || 'Error');
      span.setTag('error.message', err.message);
      span.setTag('error.stack', err.stack);
      span.setTag('error.code', err.code);
    }
    
    // Log to DataDog
    console.error('Application error:', {
      error: err.message,
      stack: err.stack,
      request: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
      },
      user: req.user?.id,
      organization: req.organization?.id,
    });
    
    next(err);
  };
};

// Custom metrics helper
class Metrics {
  constructor(statsd) {
    this.statsd = statsd;
  }
  
  // Track API request
  trackRequest(endpoint, method, statusCode, duration) {
    const tags = [
      `endpoint:${endpoint}`,
      `method:${method}`,
      `status:${statusCode}`,
      `status_class:${Math.floor(statusCode / 100)}xx`,
    ];
    
    this.statsd.increment('api.requests', 1, tags);
    this.statsd.histogram('api.request.duration', duration, tags);
    
    if (statusCode >= 400) {
      this.statsd.increment('api.errors', 1, tags);
    }
  }
  
  // Track database query
  trackQuery(operation, table, duration, error = null) {
    const tags = [
      `operation:${operation}`,
      `table:${table}`,
      `success:${!error}`,
    ];
    
    this.statsd.increment('db.queries', 1, tags);
    this.statsd.histogram('db.query.duration', duration, tags);
    
    if (error) {
      this.statsd.increment('db.errors', 1, tags);
    }
  }
  
  // Track cache operation
  trackCache(operation, hit, duration) {
    const tags = [
      `operation:${operation}`,
      `hit:${hit}`,
    ];
    
    this.statsd.increment('cache.operations', 1, tags);
    this.statsd.histogram('cache.operation.duration', duration, tags);
    
    if (hit) {
      this.statsd.increment('cache.hits', 1, tags);
    } else {
      this.statsd.increment('cache.misses', 1, tags);
    }
  }
  
  // Track business metrics
  trackBusinessMetric(metric, value, tags = []) {
    this.statsd.gauge(`business.${metric}`, value, tags);
  }
  
  // Track custom event
  trackEvent(event, tags = []) {
    this.statsd.increment(`events.${event}`, 1, tags);
  }
  
  // Track latency percentiles
  trackLatency(metric, value, tags = []) {
    this.statsd.histogram(`latency.${metric}`, value, tags);
  }
  
  // Track rate
  trackRate(metric, value, tags = []) {
    this.statsd.increment(`rate.${metric}`, value, tags);
  }
}

// Database query wrapper with APM
const traceQuery = (queryName) => {
  return (target, propertyKey, descriptor) => {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      const { span, finish } = createSpan(`db.query.${queryName}`, {
        tags: {
          'resource.name': queryName,
          'span.type': 'sql',
          'db.type': 'postgresql',
        },
      });
      
      const startTime = Date.now();
      
      try {
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - startTime;
        
        span.setTag('db.rows', result.rowCount || 0);
        metrics.trackQuery(queryName, '', duration);
        
        finish();
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.trackQuery(queryName, '', duration, error);
        
        finish(error);
        throw error;
      }
    };
    
    return descriptor;
  };
};

// Cache operation wrapper with APM
const traceCache = (operation) => {
  return (target, propertyKey, descriptor) => {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      const { span, finish } = createSpan(`cache.${operation}`, {
        tags: {
          'resource.name': operation,
          'span.type': 'cache',
          'cache.backend': 'redis',
        },
      });
      
      const startTime = Date.now();
      
      try {
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - startTime;
        const hit = result !== null && result !== undefined;
        
        span.setTag('cache.hit', hit);
        metrics.trackCache(operation, hit, duration);
        
        finish();
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.trackCache(operation, false, duration);
        
        finish(error);
        throw error;
      }
    };
    
    return descriptor;
  };
};

// Initialize APM and metrics
const apmTracer = initializeAPM();
const statsd = initializeStatsD();
const metrics = new Metrics(statsd);

// Export APM utilities
module.exports = {
  tracer: apmTracer,
  statsd,
  metrics,
  createSpan,
  traceAsync,
  tracingMiddleware,
  errorTrackingMiddleware,
  traceQuery,
  traceCache,
  
  // Re-export DataDog tracer methods
  trace: apmTracer.trace.bind(apmTracer),
  wrap: apmTracer.wrap.bind(apmTracer),
  scope: apmTracer.scope.bind(apmTracer),
};