// OpenTelemetry Distributed Tracing for Sierra Sync
// Vendor-agnostic observability framework

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { PeriodicExportingMetricReader, ConsoleMetricExporter } = require('@opentelemetry/sdk-metrics');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { ZipkinExporter } = require('@opentelemetry/exporter-zipkin');
const opentelemetry = require('@opentelemetry/api');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { B3Propagator, B3InjectEncoding } = require('@opentelemetry/propagator-b3');
const { CompositePropagator } = require('@opentelemetry/core');

// Configuration from environment
const config = {
  serviceName: process.env.OTEL_SERVICE_NAME || 'sierra-sync-api',
  serviceVersion: process.env.OTEL_SERVICE_VERSION || process.env.npm_package_version || '1.0.0',
  deploymentEnvironment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT || process.env.NODE_ENV || 'development',
  
  // OTLP endpoints
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
  otlpTracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  otlpMetricsEndpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  otlpLogsEndpoint: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  
  // Jaeger configuration
  jaegerEnabled: process.env.OTEL_EXPORTER_JAEGER_ENABLED === 'true',
  jaegerEndpoint: process.env.OTEL_EXPORTER_JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
  
  // Zipkin configuration
  zipkinEnabled: process.env.OTEL_EXPORTER_ZIPKIN_ENABLED === 'true',
  zipkinEndpoint: process.env.OTEL_EXPORTER_ZIPKIN_ENDPOINT || 'http://localhost:9411/api/v2/spans',
  
  // Prometheus configuration
  prometheusEnabled: process.env.OTEL_EXPORTER_PROMETHEUS_ENABLED === 'true',
  prometheusPort: parseInt(process.env.OTEL_EXPORTER_PROMETHEUS_PORT || '9090'),
  
  // Sampling
  samplingRate: parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG || '1.0'),
  
  // Headers for authentication
  otlpHeaders: process.env.OTEL_EXPORTER_OTLP_HEADERS || '',
};

// Create resource with service information
const resource = Resource.default().merge(
  new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: config.deploymentEnvironment,
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: 'sierra-sync',
    [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: process.env.HOSTNAME || 'unknown',
    
    // Additional attributes
    'service.language': 'javascript',
    'service.framework': 'express',
    'cloud.provider': process.env.CLOUD_PROVIDER || 'aws',
    'cloud.region': process.env.CLOUD_REGION || 'us-east-1',
    'k8s.cluster.name': process.env.K8S_CLUSTER_NAME || 'sierra-sync-production',
    'k8s.namespace.name': process.env.K8S_NAMESPACE || 'sierra-sync',
    'k8s.pod.name': process.env.K8S_POD_NAME || process.env.HOSTNAME,
    'k8s.node.name': process.env.K8S_NODE_NAME,
  }),
);

// Initialize trace exporters
const traceExporters = [];

// OTLP trace exporter
const otlpTraceExporter = new OTLPTraceExporter({
  url: config.otlpTracesEndpoint || `${config.otlpEndpoint}/v1/traces`,
  headers: config.otlpHeaders ? JSON.parse(config.otlpHeaders) : {},
});
traceExporters.push(otlpTraceExporter);

// Jaeger exporter
if (config.jaegerEnabled) {
  const jaegerExporter = new JaegerExporter({
    endpoint: config.jaegerEndpoint,
    tags: [
      { key: 'service.name', value: config.serviceName },
      { key: 'service.version', value: config.serviceVersion },
    ],
  });
  traceExporters.push(jaegerExporter);
}

// Zipkin exporter
if (config.zipkinEnabled) {
  const zipkinExporter = new ZipkinExporter({
    url: config.zipkinEndpoint,
    serviceName: config.serviceName,
  });
  traceExporters.push(zipkinExporter);
}

// Initialize metric exporters
const metricExporters = [];

// OTLP metric exporter
const otlpMetricExporter = new OTLPMetricExporter({
  url: config.otlpMetricsEndpoint || `${config.otlpEndpoint}/v1/metrics`,
  headers: config.otlpHeaders ? JSON.parse(config.otlpHeaders) : {},
});
metricExporters.push(otlpMetricExporter);

// Prometheus exporter
if (config.prometheusEnabled) {
  const prometheusExporter = new PrometheusExporter({
    port: config.prometheusPort,
    endpoint: '/metrics',
  }, () => {
    console.log(`Prometheus metrics server started on port ${config.prometheusPort}`);
  });
  metricExporters.push(prometheusExporter);
}

// Initialize log exporter
const otlpLogExporter = new OTLPLogExporter({
  url: config.otlpLogsEndpoint || `${config.otlpEndpoint}/v1/logs`,
  headers: config.otlpHeaders ? JSON.parse(config.otlpHeaders) : {},
});

// Create propagators for context propagation
const propagator = new CompositePropagator({
  propagators: [
    new W3CTraceContextPropagator(),
    new B3Propagator({
      injectEncoding: B3InjectEncoding.MULTI_HEADER,
    }),
  ],
});

// Initialize OpenTelemetry SDK
const sdk = new NodeSDK({
  resource,
  
  // Span processors
  spanProcessor: traceExporters.map(exporter => 
    new BatchSpanProcessor(exporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: 30000,
    })
  ),
  
  // Metric readers
  metricReader: metricExporters.map(exporter => 
    new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 10000,
    })
  ),
  
  // Log record processor
  logRecordProcessor: new BatchLogRecordProcessor(otlpLogExporter),
  
  // Text map propagator
  textMapPropagator: propagator,
  
  // Instrumentations
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': {
        enabled: false, // Disable fs instrumentation to reduce noise
      },
      '@opentelemetry/instrumentation-http': {
        requestHook: (span, request) => {
          span.setAttributes({
            'http.request.body.size': request.headers['content-length'],
            'http.user_agent': request.headers['user-agent'],
            'http.client_ip': request.socket.remoteAddress,
          });
        },
        responseHook: (span, response) => {
          span.setAttributes({
            'http.response.body.size': response.headers['content-length'],
          });
        },
      },
      '@opentelemetry/instrumentation-express': {
        requestHook: (span, req) => {
          span.setAttributes({
            'express.route': req.route?.path,
            'user.id': req.user?.id,
            'organization.id': req.organization?.id,
          });
        },
      },
      '@opentelemetry/instrumentation-pg': {
        enhancedDatabaseReporting: true,
        responseHook: (span, responseInfo) => {
          span.setAttributes({
            'db.rows_affected': responseInfo?.rowCount,
          });
        },
      },
      '@opentelemetry/instrumentation-redis': {
        dbStatementSerializer: (cmdName, cmdArgs) => {
          return `${cmdName} ${cmdArgs.slice(0, 2).join(' ')}`;
        },
      },
    }),
  ],
});

// Initialize the SDK
sdk.start()
  .then(() => {
    console.log('OpenTelemetry SDK initialized successfully');
  })
  .catch((error) => {
    console.error('Error initializing OpenTelemetry SDK:', error);
  });

// Get tracer, meter, and logger instances
const tracer = opentelemetry.trace.getTracer(
  config.serviceName,
  config.serviceVersion,
);

const meter = opentelemetry.metrics.getMeter(
  config.serviceName,
  config.serviceVersion,
);

const logger = opentelemetry.logs.getLogger(
  config.serviceName,
  config.serviceVersion,
);

// Custom span creation helper
function createSpan(name, options = {}) {
  const currentSpan = opentelemetry.trace.getActiveSpan();
  const ctx = currentSpan ? opentelemetry.trace.setSpan(opentelemetry.context.active(), currentSpan) : undefined;
  
  const span = tracer.startSpan(name, {
    kind: options.kind || opentelemetry.SpanKind.INTERNAL,
    attributes: options.attributes || {},
  }, ctx);
  
  return span;
}

// Async function wrapper with tracing
function traceAsync(name, fn, options = {}) {
  return async (...args) => {
    const span = createSpan(name, options);
    const ctx = opentelemetry.trace.setSpan(opentelemetry.context.active(), span);
    
    try {
      const result = await opentelemetry.context.with(ctx, async () => {
        return await fn(...args);
      });
      
      span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: opentelemetry.SpanStatusCode.ERROR,
        message: error.message,
      });
      throw error;
    } finally {
      span.end();
    }
  };
}

// Express middleware for tracing
function tracingMiddleware() {
  return (req, res, next) => {
    const span = opentelemetry.trace.getActiveSpan();
    
    if (span) {
      // Add request attributes
      span.setAttributes({
        'http.method': req.method,
        'http.url': req.url,
        'http.target': req.path,
        'http.host': req.hostname,
        'http.scheme': req.protocol,
        'http.user_agent': req.get('user-agent'),
        'http.client_ip': req.ip,
        'user.id': req.user?.id,
        'user.email': req.user?.email,
        'organization.id': req.organization?.id,
      });
      
      // Add baggage for distributed context
      const baggage = opentelemetry.propagation.getBaggage(opentelemetry.context.active());
      if (baggage) {
        baggage.setEntry('user.id', { value: req.user?.id?.toString() || 'anonymous' });
        baggage.setEntry('session.id', { value: req.session?.id || 'no-session' });
      }
    }
    
    next();
  };
}

// Create custom metrics
const metrics = {
  // Counters
  requestCounter: meter.createCounter('http_requests_total', {
    description: 'Total number of HTTP requests',
  }),
  
  errorCounter: meter.createCounter('http_errors_total', {
    description: 'Total number of HTTP errors',
  }),
  
  dbQueryCounter: meter.createCounter('db_queries_total', {
    description: 'Total number of database queries',
  }),
  
  cacheHitCounter: meter.createCounter('cache_hits_total', {
    description: 'Total number of cache hits',
  }),
  
  cacheMissCounter: meter.createCounter('cache_misses_total', {
    description: 'Total number of cache misses',
  }),
  
  // Histograms
  requestDuration: meter.createHistogram('http_request_duration_ms', {
    description: 'HTTP request duration in milliseconds',
  }),
  
  dbQueryDuration: meter.createHistogram('db_query_duration_ms', {
    description: 'Database query duration in milliseconds',
  }),
  
  cacheOperationDuration: meter.createHistogram('cache_operation_duration_ms', {
    description: 'Cache operation duration in milliseconds',
  }),
  
  // Gauges
  activeConnections: meter.createObservableGauge('active_connections', {
    description: 'Number of active connections',
  }),
  
  memoryUsage: meter.createObservableGauge('memory_usage_bytes', {
    description: 'Memory usage in bytes',
  }),
  
  cpuUsage: meter.createObservableGauge('cpu_usage_percent', {
    description: 'CPU usage percentage',
  }),
};

// Register observable gauge callbacks
meter.addBatchObservableCallback((observableResult) => {
  // Memory usage
  const memUsage = process.memoryUsage();
  observableResult.observe(metrics.memoryUsage, memUsage.heapUsed, {
    type: 'heap_used',
  });
  observableResult.observe(metrics.memoryUsage, memUsage.heapTotal, {
    type: 'heap_total',
  });
  observableResult.observe(metrics.memoryUsage, memUsage.rss, {
    type: 'rss',
  });
  
  // CPU usage
  const cpuUsage = process.cpuUsage();
  const totalCpu = cpuUsage.user + cpuUsage.system;
  observableResult.observe(metrics.cpuUsage, totalCpu / 1000000, {
    type: 'total',
  });
}, [metrics.memoryUsage, metrics.cpuUsage]);

// Helper functions for metrics
function recordHttpRequest(method, path, statusCode, duration) {
  const attributes = {
    method,
    path,
    status_code: statusCode.toString(),
    status_class: `${Math.floor(statusCode / 100)}xx`,
  };
  
  metrics.requestCounter.add(1, attributes);
  metrics.requestDuration.record(duration, attributes);
  
  if (statusCode >= 400) {
    metrics.errorCounter.add(1, attributes);
  }
}

function recordDbQuery(operation, table, duration, error = null) {
  const attributes = {
    operation,
    table,
    success: !error,
  };
  
  metrics.dbQueryCounter.add(1, attributes);
  metrics.dbQueryDuration.record(duration, attributes);
}

function recordCacheOperation(operation, hit, duration) {
  const attributes = {
    operation,
    hit: hit.toString(),
  };
  
  if (hit) {
    metrics.cacheHitCounter.add(1, attributes);
  } else {
    metrics.cacheMissCounter.add(1, attributes);
  }
  
  metrics.cacheOperationDuration.record(duration, attributes);
}

// Structured logging with OpenTelemetry
function log(level, message, attributes = {}) {
  const span = opentelemetry.trace.getActiveSpan();
  const spanContext = span?.spanContext();
  
  logger.emit({
    severityNumber: getSeverityNumber(level),
    severityText: level,
    body: message,
    attributes: {
      ...attributes,
      'trace.id': spanContext?.traceId,
      'span.id': spanContext?.spanId,
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
    },
    timestamp: Date.now(),
  });
}

function getSeverityNumber(level) {
  const severityMap = {
    trace: 1,
    debug: 5,
    info: 9,
    warn: 13,
    error: 17,
    fatal: 21,
  };
  return severityMap[level.toLowerCase()] || 9;
}

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OpenTelemetry SDK terminated successfully'))
    .catch((error) => console.error('Error terminating OpenTelemetry SDK', error))
    .finally(() => process.exit(0));
});

// Export OpenTelemetry utilities
module.exports = {
  tracer,
  meter,
  logger,
  metrics,
  createSpan,
  traceAsync,
  tracingMiddleware,
  recordHttpRequest,
  recordDbQuery,
  recordCacheOperation,
  log,
  
  // Re-export OpenTelemetry API
  api: opentelemetry,
  SpanKind: opentelemetry.SpanKind,
  SpanStatusCode: opentelemetry.SpanStatusCode,
  context: opentelemetry.context,
  propagation: opentelemetry.propagation,
};