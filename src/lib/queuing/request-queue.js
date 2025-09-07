// Request Queuing and Backpressure System for Sierra Sync
// Manages request queuing, rate limiting, and backpressure

const EventEmitter = require('events');
const Bull = require('bull');
const Redis = require('ioredis');

class RequestQueue extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        ...config.redis
      },
      queues: {
        default: {
          concurrency: 10,
          rateLimit: {
            max: 100,
            duration: 1000
          }
        },
        priority: {
          concurrency: 20,
          rateLimit: {
            max: 200,
            duration: 1000
          }
        },
        batch: {
          concurrency: 5,
          rateLimit: {
            max: 50,
            duration: 1000
          }
        },
        ...config.queues
      },
      backpressure: {
        enabled: true,
        maxQueueSize: 10000,
        maxMemoryUsage: 0.8, // 80% of available memory
        pauseThreshold: 0.9,
        resumeThreshold: 0.7,
        checkInterval: 1000,
        ...config.backpressure
      },
      circuitBreaker: {
        enabled: true,
        errorThreshold: 0.5,
        volumeThreshold: 10,
        timeout: 3000,
        resetTimeout: 30000,
        ...config.circuitBreaker
      },
      metrics: {
        enabled: true,
        interval: 5000,
        ...config.metrics
      }
    };
    
    this.queues = new Map();
    this.processors = new Map();
    this.metrics = {
      processed: 0,
      failed: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      avgProcessingTime: 0,
      backpressureEvents: 0,
      circuitBreakerTrips: 0
    };
    
    this.isPaused = false;
    this.circuitState = 'CLOSED';
    this.circuitErrors = [];
    this.lastCircuitCheck = Date.now();
    
    this.initialize();
  }
  
  // Initialize queue system
  async initialize() {
    // Create Redis clients
    this.redis = new Redis(this.config.redis);
    this.subscriber = new Redis(this.config.redis);
    
    // Initialize queues
    for (const [name, config] of Object.entries(this.config.queues)) {
      await this.createQueue(name, config);
    }
    
    // Start backpressure monitoring
    if (this.config.backpressure.enabled) {
      this.startBackpressureMonitoring();
    }
    
    // Start metrics collection
    if (this.config.metrics.enabled) {
      this.startMetricsCollection();
    }
    
    this.emit('initialized');
  }
  
  // Create a new queue
  async createQueue(name, config) {
    const queue = new Bull(name, {
      redis: this.config.redis,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        }
      }
    });
    
    // Configure rate limiting
    if (config.rateLimit) {
      queue.limiter = {
        max: config.rateLimit.max,
        duration: config.rateLimit.duration
      };
    }
    
    // Set concurrency
    queue.concurrency = config.concurrency || 10;
    
    // Store queue
    this.queues.set(name, queue);
    
    // Set up event handlers
    this.setupQueueEvents(name, queue);
    
    return queue;
  }
  
  // Setup queue event handlers
  setupQueueEvents(name, queue) {
    queue.on('completed', (job, result) => {
      this.metrics.completed++;
      this.emit('job:completed', { queue: name, jobId: job.id, result });
    });
    
    queue.on('failed', (job, err) => {
      this.metrics.failed++;
      this.recordCircuitError(err);
      this.emit('job:failed', { queue: name, jobId: job.id, error: err.message });
    });
    
    queue.on('active', (job) => {
      this.metrics.processing++;
      this.emit('job:active', { queue: name, jobId: job.id });
    });
    
    queue.on('stalled', (job) => {
      this.emit('job:stalled', { queue: name, jobId: job.id });
    });
    
    queue.on('progress', (job, progress) => {
      this.emit('job:progress', { queue: name, jobId: job.id, progress });
    });
  }
  
  // Add job to queue
  async enqueue(queueName, data, options = {}) {
    // Check circuit breaker
    if (this.config.circuitBreaker.enabled && this.circuitState === 'OPEN') {
      if (Date.now() - this.lastCircuitCheck > this.config.circuitBreaker.resetTimeout) {
        this.circuitState = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    
    // Check backpressure
    if (this.isPaused) {
      throw new Error('Queue is paused due to backpressure');
    }
    
    const queue = this.queues.get(queueName || 'default');
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    // Check queue size for backpressure
    const queueSize = await queue.count();
    if (queueSize >= this.config.backpressure.maxQueueSize) {
      this.metrics.backpressureEvents++;
      throw new Error('Queue size limit exceeded');
    }
    
    // Add job to queue
    const job = await queue.add(data, {
      priority: options.priority || 0,
      delay: options.delay || 0,
      attempts: options.attempts || 3,
      backoff: options.backoff || { type: 'exponential', delay: 2000 },
      timeout: options.timeout || this.config.circuitBreaker.timeout,
      ...options
    });
    
    this.metrics.queued++;
    this.emit('job:enqueued', { queue: queueName, jobId: job.id });
    
    return job;
  }
  
  // Process queue with handler
  async process(queueName, handler) {
    const queue = this.queues.get(queueName || 'default');
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    const processor = async (job) => {
      const startTime = Date.now();
      
      try {
        // Execute handler with timeout
        const result = await Promise.race([
          handler(job),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Job timeout')), 
            job.opts.timeout || this.config.circuitBreaker.timeout)
          )
        ]);
        
        // Update metrics
        const processingTime = Date.now() - startTime;
        this.updateProcessingTime(processingTime);
        this.metrics.processed++;
        
        // Reset circuit breaker on success
        if (this.circuitState === 'HALF_OPEN') {
          this.circuitState = 'CLOSED';
          this.circuitErrors = [];
        }
        
        return result;
        
      } catch (error) {
        // Record error for circuit breaker
        this.recordCircuitError(error);
        
        throw error;
      }
    };
    
    // Register processor
    queue.process(queue.concurrency, processor);
    this.processors.set(queueName, processor);
    
    this.emit('processor:registered', { queue: queueName });
  }
  
  // Batch processing
  async processBatch(queueName, batchSize, handler) {
    const queue = this.queues.get(queueName || 'batch');
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    const processor = async (job) => {
      const jobs = [];
      
      // Collect batch
      for (let i = 0; i < batchSize; i++) {
        const nextJob = await queue.getNextJob();
        if (nextJob) {
          jobs.push(nextJob);
        } else {
          break;
        }
      }
      
      if (jobs.length === 0) {
        return;
      }
      
      try {
        // Process batch
        const results = await handler(jobs);
        
        // Complete jobs
        for (let i = 0; i < jobs.length; i++) {
          await jobs[i].moveToCompleted(results[i]);
        }
        
        this.metrics.processed += jobs.length;
        
        return results;
        
      } catch (error) {
        // Fail jobs
        for (const job of jobs) {
          await job.moveToFailed(error);
        }
        
        throw error;
      }
    };
    
    queue.process(1, processor);
    this.processors.set(queueName, processor);
  }
  
  // Priority queue management
  async enqueuePriority(data, priority, options = {}) {
    return this.enqueue('priority', data, {
      ...options,
      priority: priority || 0
    });
  }
  
  // Dead letter queue handling
  async processDeadLetter(handler) {
    const dlq = await this.createQueue('dead-letter', {
      concurrency: 1,
      rateLimit: null
    });
    
    await this.process('dead-letter', handler);
  }
  
  // Retry failed jobs
  async retryFailed(queueName) {
    const queue = this.queues.get(queueName || 'default');
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    const failed = await queue.getFailed();
    const retried = [];
    
    for (const job of failed) {
      await job.retry();
      retried.push(job.id);
    }
    
    this.emit('jobs:retried', { queue: queueName, count: retried.length, jobs: retried });
    
    return retried;
  }
  
  // Backpressure monitoring
  startBackpressureMonitoring() {
    this.backpressureTimer = setInterval(async () => {
      await this.checkBackpressure();
    }, this.config.backpressure.checkInterval);
  }
  
  async checkBackpressure() {
    // Check memory usage
    const memUsage = process.memoryUsage();
    const totalMem = require('os').totalmem();
    const memoryRatio = memUsage.heapUsed / totalMem;
    
    // Check queue sizes
    let totalQueueSize = 0;
    for (const [name, queue] of this.queues) {
      const size = await queue.count();
      totalQueueSize += size;
    }
    
    // Calculate pressure
    const queuePressure = totalQueueSize / this.config.backpressure.maxQueueSize;
    const pressure = Math.max(memoryRatio / this.config.backpressure.maxMemoryUsage, queuePressure);
    
    // Apply backpressure
    if (pressure >= this.config.backpressure.pauseThreshold && !this.isPaused) {
      await this.pauseQueues();
    } else if (pressure <= this.config.backpressure.resumeThreshold && this.isPaused) {
      await this.resumeQueues();
    }
    
    this.emit('backpressure:checked', {
      pressure,
      memoryRatio,
      queuePressure,
      totalQueueSize,
      isPaused: this.isPaused
    });
  }
  
  // Pause all queues
  async pauseQueues() {
    this.isPaused = true;
    
    for (const [name, queue] of this.queues) {
      await queue.pause();
    }
    
    this.metrics.backpressureEvents++;
    this.emit('queues:paused');
  }
  
  // Resume all queues
  async resumeQueues() {
    this.isPaused = false;
    
    for (const [name, queue] of this.queues) {
      await queue.resume();
    }
    
    this.emit('queues:resumed');
  }
  
  // Circuit breaker logic
  recordCircuitError(error) {
    if (!this.config.circuitBreaker.enabled) return;
    
    this.circuitErrors.push({
      timestamp: Date.now(),
      error: error.message
    });
    
    // Remove old errors
    const cutoff = Date.now() - 60000; // 1 minute window
    this.circuitErrors = this.circuitErrors.filter(e => e.timestamp > cutoff);
    
    // Check if circuit should open
    if (this.circuitErrors.length >= this.config.circuitBreaker.volumeThreshold) {
      const errorRate = this.circuitErrors.length / this.config.circuitBreaker.volumeThreshold;
      
      if (errorRate >= this.config.circuitBreaker.errorThreshold) {
        this.openCircuit();
      }
    }
  }
  
  openCircuit() {
    if (this.circuitState === 'OPEN') return;
    
    this.circuitState = 'OPEN';
    this.lastCircuitCheck = Date.now();
    this.metrics.circuitBreakerTrips++;
    
    this.emit('circuit:opened');
  }
  
  // Update average processing time
  updateProcessingTime(time) {
    const count = this.metrics.processed || 1;
    this.metrics.avgProcessingTime = 
      (this.metrics.avgProcessingTime * (count - 1) + time) / count;
  }
  
  // Get queue status
  async getQueueStatus(queueName) {
    const queue = this.queues.get(queueName || 'default');
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    return {
      waiting: await queue.getWaitingCount(),
      active: await queue.getActiveCount(),
      completed: await queue.getCompletedCount(),
      failed: await queue.getFailedCount(),
      delayed: await queue.getDelayedCount(),
      paused: await queue.isPaused()
    };
  }
  
  // Get all queues status
  async getAllQueuesStatus() {
    const status = {};
    
    for (const [name, queue] of this.queues) {
      status[name] = await this.getQueueStatus(name);
    }
    
    return status;
  }
  
  // Metrics collection
  startMetricsCollection() {
    this.metricsTimer = setInterval(async () => {
      await this.collectMetrics();
    }, this.config.metrics.interval);
  }
  
  async collectMetrics() {
    const queuesStatus = await this.getAllQueuesStatus();
    
    const metrics = {
      ...this.metrics,
      queues: queuesStatus,
      circuitState: this.circuitState,
      isPaused: this.isPaused,
      timestamp: new Date()
    };
    
    this.emit('metrics:collected', metrics);
    
    return metrics;
  }
  
  // Clean completed jobs
  async cleanCompleted(queueName, grace = 3600000) {
    const queue = this.queues.get(queueName || 'default');
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    const completed = await queue.clean(grace, 'completed');
    
    this.emit('jobs:cleaned', { queue: queueName, type: 'completed', count: completed.length });
    
    return completed;
  }
  
  // Drain queue
  async drainQueue(queueName) {
    const queue = this.queues.get(queueName || 'default');
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    
    await queue.drain();
    
    this.emit('queue:drained', { queue: queueName });
  }
  
  // Express middleware
  middleware() {
    return async (req, res, next) => {
      // Check if queuing is needed
      if (this.isPaused || this.circuitState === 'OPEN') {
        // Queue the request
        try {
          const job = await this.enqueue('http-requests', {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: req.body,
            timestamp: Date.now()
          }, {
            priority: req.headers['x-priority'] || 0
          });
          
          // Wait for job completion
          const result = await job.finished();
          
          // Send response
          res.status(result.status || 200).json(result);
          
        } catch (error) {
          res.status(503).json({
            error: 'Service temporarily unavailable',
            message: error.message
          });
        }
      } else {
        // Process normally
        next();
      }
    };
  }
  
  // Graceful shutdown
  async shutdown() {
    // Stop timers
    if (this.backpressureTimer) {
      clearInterval(this.backpressureTimer);
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    
    // Close queues
    for (const [name, queue] of this.queues) {
      await queue.close();
    }
    
    // Close Redis connections
    await this.redis.quit();
    await this.subscriber.quit();
    
    this.emit('shutdown');
  }
}

// Rate limiter with sliding window
class RateLimiter {
  constructor(config = {}) {
    this.config = {
      windowMs: config.windowMs || 60000,
      max: config.max || 100,
      keyGenerator: config.keyGenerator || ((req) => req.ip),
      skipSuccessfulRequests: config.skipSuccessfulRequests || false,
      skipFailedRequests: config.skipFailedRequests || false,
      ...config
    };
    
    this.requests = new Map();
  }
  
  middleware() {
    return (req, res, next) => {
      const key = this.config.keyGenerator(req);
      const now = Date.now();
      
      // Get or create request log
      if (!this.requests.has(key)) {
        this.requests.set(key, []);
      }
      
      const requestLog = this.requests.get(key);
      
      // Remove old entries
      const cutoff = now - this.config.windowMs;
      const validRequests = requestLog.filter(time => time > cutoff);
      
      // Check limit
      if (validRequests.length >= this.config.max) {
        const retryAfter = Math.ceil((validRequests[0] + this.config.windowMs - now) / 1000);
        
        res.set('Retry-After', retryAfter);
        res.set('X-RateLimit-Limit', this.config.max);
        res.set('X-RateLimit-Remaining', 0);
        res.set('X-RateLimit-Reset', new Date(validRequests[0] + this.config.windowMs).toISOString());
        
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter
        });
      }
      
      // Add current request
      validRequests.push(now);
      this.requests.set(key, validRequests);
      
      // Set headers
      res.set('X-RateLimit-Limit', this.config.max);
      res.set('X-RateLimit-Remaining', this.config.max - validRequests.length);
      res.set('X-RateLimit-Reset', new Date(now + this.config.windowMs).toISOString());
      
      next();
    };
  }
}

module.exports = {
  RequestQueue,
  RateLimiter
};