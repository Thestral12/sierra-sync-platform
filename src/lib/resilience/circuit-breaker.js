// Circuit Breaker Pattern Implementation for Sierra Sync
// Prevents cascading failures and provides fault tolerance

const EventEmitter = require('events');

class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.name = options.name || 'default';
    this.timeout = options.timeout || 3000; // 3 seconds
    this.errorThreshold = options.errorThreshold || 50; // 50% error rate
    this.volumeThreshold = options.volumeThreshold || 10; // minimum requests
    this.sleepWindow = options.sleepWindow || 60000; // 60 seconds
    this.bucketSize = options.bucketSize || 10000; // 10 seconds
    this.bucketNum = options.bucketNum || 6; // 1 minute of history
    
    // State management
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
    
    // Metrics
    this.buckets = [];
    this.currentBucket = this.createBucket();
    
    // Fallback function
    this.fallbackFn = options.fallback || (() => {
      throw new Error('Circuit breaker is OPEN');
    });
    
    // Start metrics rotation
    this.startMetricsRotation();
  }
  
  // Execute function with circuit breaker protection
  async execute(fn, ...args) {
    // Check if circuit is open
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        this.emit('rejected', { state: this.state });
        return this.fallbackFn(...args);
      }
      
      // Try half-open state
      this.state = 'HALF_OPEN';
      this.emit('state-change', { from: 'OPEN', to: 'HALF_OPEN' });
    }
    
    const startTime = Date.now();
    
    try {
      // Set timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Circuit breaker timeout')), this.timeout);
      });
      
      // Execute function with timeout
      const result = await Promise.race([
        fn(...args),
        timeoutPromise
      ]);
      
      // Record success
      this.recordSuccess(Date.now() - startTime);
      
      // If half-open, close the circuit
      if (this.state === 'HALF_OPEN') {
        this.close();
      }
      
      return result;
      
    } catch (error) {
      // Record failure
      this.recordFailure(Date.now() - startTime, error);
      
      // If half-open, re-open the circuit
      if (this.state === 'HALF_OPEN') {
        this.open();
      }
      
      // Check if we should open the circuit
      if (this.state === 'CLOSED') {
        this.checkThreshold();
      }
      
      // Use fallback or rethrow
      if (this.state === 'OPEN') {
        return this.fallbackFn(...args);
      }
      
      throw error;
    }
  }
  
  // Record successful execution
  recordSuccess(duration) {
    this.currentBucket.successes++;
    this.currentBucket.totalDuration += duration;
    this.currentBucket.lastSuccess = Date.now();
    
    this.emit('success', {
      duration,
      state: this.state,
      metrics: this.getMetrics()
    });
  }
  
  // Record failed execution
  recordFailure(duration, error) {
    this.currentBucket.failures++;
    this.currentBucket.totalDuration += duration;
    this.currentBucket.lastFailure = Date.now();
    this.currentBucket.errors.push({
      message: error.message,
      timestamp: Date.now()
    });
    
    this.emit('failure', {
      duration,
      error: error.message,
      state: this.state,
      metrics: this.getMetrics()
    });
  }
  
  // Check if threshold is exceeded
  checkThreshold() {
    const metrics = this.getMetrics();
    
    if (metrics.totalRequests < this.volumeThreshold) {
      return; // Not enough requests to make decision
    }
    
    if (metrics.errorRate >= this.errorThreshold) {
      this.open();
    }
  }
  
  // Open the circuit
  open() {
    if (this.state === 'OPEN') return;
    
    const previousState = this.state;
    this.state = 'OPEN';
    this.nextAttempt = Date.now() + this.sleepWindow;
    
    this.emit('state-change', {
      from: previousState,
      to: 'OPEN',
      nextAttempt: this.nextAttempt
    });
    
    this.emit('open', {
      metrics: this.getMetrics(),
      nextAttempt: this.nextAttempt
    });
  }
  
  // Close the circuit
  close() {
    if (this.state === 'CLOSED') return;
    
    const previousState = this.state;
    this.state = 'CLOSED';
    this.nextAttempt = Date.now();
    
    // Reset buckets for fresh start
    this.buckets = [];
    this.currentBucket = this.createBucket();
    
    this.emit('state-change', {
      from: previousState,
      to: 'CLOSED'
    });
    
    this.emit('close', {
      metrics: this.getMetrics()
    });
  }
  
  // Force circuit to half-open state
  halfOpen() {
    if (this.state === 'HALF_OPEN') return;
    
    const previousState = this.state;
    this.state = 'HALF_OPEN';
    
    this.emit('state-change', {
      from: previousState,
      to: 'HALF_OPEN'
    });
  }
  
  // Create new metrics bucket
  createBucket() {
    return {
      startTime: Date.now(),
      successes: 0,
      failures: 0,
      totalDuration: 0,
      errors: [],
      lastSuccess: null,
      lastFailure: null
    };
  }
  
  // Start metrics rotation timer
  startMetricsRotation() {
    setInterval(() => {
      this.rotateBuckets();
    }, this.bucketSize);
  }
  
  // Rotate metrics buckets
  rotateBuckets() {
    this.buckets.push(this.currentBucket);
    
    // Keep only the specified number of buckets
    if (this.buckets.length > this.bucketNum) {
      this.buckets.shift();
    }
    
    this.currentBucket = this.createBucket();
  }
  
  // Get current metrics
  getMetrics() {
    const allBuckets = [...this.buckets, this.currentBucket];
    
    const totals = allBuckets.reduce((acc, bucket) => {
      acc.successes += bucket.successes;
      acc.failures += bucket.failures;
      acc.totalDuration += bucket.totalDuration;
      return acc;
    }, { successes: 0, failures: 0, totalDuration: 0 });
    
    const totalRequests = totals.successes + totals.failures;
    
    return {
      state: this.state,
      totalRequests,
      successCount: totals.successes,
      failureCount: totals.failures,
      errorRate: totalRequests > 0 ? (totals.failures / totalRequests) * 100 : 0,
      avgDuration: totalRequests > 0 ? totals.totalDuration / totalRequests : 0,
      buckets: allBuckets.length,
      lastSuccess: allBuckets.reduce((latest, bucket) => 
        Math.max(latest, bucket.lastSuccess || 0), 0),
      lastFailure: allBuckets.reduce((latest, bucket) => 
        Math.max(latest, bucket.lastFailure || 0), 0)
    };
  }
  
  // Reset circuit breaker
  reset() {
    this.state = 'CLOSED';
    this.nextAttempt = Date.now();
    this.buckets = [];
    this.currentBucket = this.createBucket();
    
    this.emit('reset', { state: this.state });
  }
  
  // Get current state
  getState() {
    return {
      name: this.name,
      state: this.state,
      nextAttempt: this.nextAttempt,
      config: {
        timeout: this.timeout,
        errorThreshold: this.errorThreshold,
        volumeThreshold: this.volumeThreshold,
        sleepWindow: this.sleepWindow
      },
      metrics: this.getMetrics()
    };
  }
}

// Circuit Breaker Factory for managing multiple breakers
class CircuitBreakerFactory {
  constructor() {
    this.breakers = new Map();
    this.defaultConfig = {
      timeout: 3000,
      errorThreshold: 50,
      volumeThreshold: 10,
      sleepWindow: 60000
    };
  }
  
  // Get or create circuit breaker
  get(name, config = {}) {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker({
        name,
        ...this.defaultConfig,
        ...config
      });
      
      this.breakers.set(name, breaker);
    }
    
    return this.breakers.get(name);
  }
  
  // Create new circuit breaker
  create(name, config = {}) {
    if (this.breakers.has(name)) {
      throw new Error(`Circuit breaker ${name} already exists`);
    }
    
    const breaker = new CircuitBreaker({
      name,
      ...this.defaultConfig,
      ...config
    });
    
    this.breakers.set(name, breaker);
    return breaker;
  }
  
  // Remove circuit breaker
  remove(name) {
    return this.breakers.delete(name);
  }
  
  // Get all circuit breakers
  getAll() {
    return Array.from(this.breakers.values());
  }
  
  // Get metrics for all breakers
  getAllMetrics() {
    const metrics = {};
    
    for (const [name, breaker] of this.breakers) {
      metrics[name] = breaker.getMetrics();
    }
    
    return metrics;
  }
  
  // Reset all circuit breakers
  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
  
  // Set default configuration
  setDefaultConfig(config) {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }
}

// HTTP Client with Circuit Breaker
class ResilientHttpClient {
  constructor(options = {}) {
    this.axios = require('axios');
    this.factory = new CircuitBreakerFactory();
    
    // Default circuit breaker config for HTTP calls
    this.defaultBreakerConfig = {
      timeout: options.timeout || 5000,
      errorThreshold: options.errorThreshold || 50,
      volumeThreshold: options.volumeThreshold || 5,
      sleepWindow: options.sleepWindow || 30000,
      ...options.circuitBreaker
    };
    
    // Retry configuration
    this.retryConfig = {
      retries: options.retries || 3,
      retryDelay: options.retryDelay || 1000,
      retryCondition: options.retryCondition || this.defaultRetryCondition,
      ...options.retry
    };
  }
  
  // Make HTTP request with circuit breaker
  async request(config) {
    const { url, method = 'GET', ...restConfig } = config;
    
    // Get circuit breaker for this endpoint
    const breakerName = this.getBreakerName(url, method);
    const breaker = this.factory.get(breakerName, this.defaultBreakerConfig);
    
    // Create request function with retry logic
    const requestFn = async () => {
      let lastError;
      
      for (let attempt = 0; attempt <= this.retryConfig.retries; attempt++) {
        try {
          if (attempt > 0) {
            // Wait before retry
            await this.delay(this.retryConfig.retryDelay * Math.pow(2, attempt - 1));
          }
          
          const response = await this.axios({
            url,
            method,
            timeout: breaker.timeout,
            ...restConfig
          });
          
          return response;
          
        } catch (error) {
          lastError = error;
          
          // Check if we should retry
          if (attempt < this.retryConfig.retries && 
              this.retryConfig.retryCondition(error)) {
            continue;
          }
          
          throw error;
        }
      }
      
      throw lastError;
    };
    
    // Set fallback function
    breaker.fallbackFn = config.fallback || (() => {
      throw new Error(`Circuit breaker OPEN for ${breakerName}`);
    });
    
    // Execute with circuit breaker
    return breaker.execute(requestFn);
  }
  
  // Convenience methods
  async get(url, config = {}) {
    return this.request({ ...config, url, method: 'GET' });
  }
  
  async post(url, data, config = {}) {
    return this.request({ ...config, url, method: 'POST', data });
  }
  
  async put(url, data, config = {}) {
    return this.request({ ...config, url, method: 'PUT', data });
  }
  
  async delete(url, config = {}) {
    return this.request({ ...config, url, method: 'DELETE' });
  }
  
  // Get breaker name for endpoint
  getBreakerName(url, method) {
    const urlObj = new URL(url);
    return `${method}:${urlObj.hostname}${urlObj.pathname}`;
  }
  
  // Default retry condition
  defaultRetryCondition(error) {
    // Retry on network errors or 5xx status codes
    return !error.response || error.response.status >= 500;
  }
  
  // Delay helper
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // Get circuit breaker metrics
  getMetrics() {
    return this.factory.getAllMetrics();
  }
  
  // Reset all circuit breakers
  resetAll() {
    this.factory.resetAll();
  }
}

// Express middleware for circuit breaker
function circuitBreakerMiddleware(options = {}) {
  const factory = new CircuitBreakerFactory();
  factory.setDefaultConfig(options);
  
  return (req, res, next) => {
    // Attach circuit breaker factory to request
    req.circuitBreaker = {
      create: (name, config) => factory.create(name, config),
      get: (name, config) => factory.get(name, config),
      execute: async (name, fn, ...args) => {
        const breaker = factory.get(name);
        return breaker.execute(fn, ...args);
      },
      metrics: () => factory.getAllMetrics(),
      reset: (name) => {
        const breaker = factory.get(name);
        if (breaker) breaker.reset();
      }
    };
    
    // Monitor response times and errors
    const startTime = Date.now();
    const originalSend = res.send;
    
    res.send = function(data) {
      const duration = Date.now() - startTime;
      
      // Track endpoint metrics
      const breakerName = `${req.method}:${req.route?.path || req.path}`;
      const breaker = factory.get(breakerName, {
        errorThreshold: 30,
        volumeThreshold: 10,
        sleepWindow: 30000
      });
      
      if (res.statusCode >= 500) {
        breaker.recordFailure(duration, new Error(`HTTP ${res.statusCode}`));
      } else {
        breaker.recordSuccess(duration);
      }
      
      return originalSend.call(this, data);
    };
    
    next();
  };
}

// Database connection with circuit breaker
class ResilientDatabase {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.breaker = new CircuitBreaker({
      name: 'database',
      timeout: options.timeout || 5000,
      errorThreshold: options.errorThreshold || 30,
      volumeThreshold: options.volumeThreshold || 5,
      sleepWindow: options.sleepWindow || 60000,
      fallback: options.fallback
    });
  }
  
  async query(text, params) {
    return this.breaker.execute(async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query(text, params);
        return result;
      } finally {
        client.release();
      }
    });
  }
  
  async transaction(callback) {
    return this.breaker.execute(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }
  
  getMetrics() {
    return this.breaker.getMetrics();
  }
  
  getState() {
    return this.breaker.getState();
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerFactory,
  ResilientHttpClient,
  ResilientDatabase,
  circuitBreakerMiddleware
};