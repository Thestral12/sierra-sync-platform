// Distributed Caching System with Cache Invalidation for Sierra Sync
// Implements multi-layer caching with Redis Cluster and invalidation strategies

const Redis = require('ioredis');
const EventEmitter = require('events');
const crypto = require('crypto');
const msgpack = require('msgpack-lite');

class DistributedCache extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      redis: {
        cluster: process.env.REDIS_CLUSTER === 'true',
        nodes: process.env.REDIS_NODES ? JSON.parse(process.env.REDIS_NODES) : [
          { host: 'localhost', port: 6379 }
        ],
        options: {
          password: process.env.REDIS_PASSWORD,
          enableReadyCheck: true,
          maxRetriesPerRequest: 3,
          retryDelayOnFailover: 100,
          retryDelayOnClusterDown: 300,
          slotsRefreshTimeout: 2000,
          clusterRetryStrategy: (times) => Math.min(100 * times, 2000),
          ...config.redis?.options
        }
      },
      layers: {
        l1: {
          enabled: true,
          maxSize: 1000,
          ttl: 60000, // 1 minute
          algorithm: 'LRU' // LRU, LFU, ARC
        },
        l2: {
          enabled: true,
          maxSize: 10000,
          ttl: 300000, // 5 minutes
          algorithm: 'LRU'
        },
        ...config.layers
      },
      invalidation: {
        strategy: 'broadcast', // broadcast, targeted, lazy
        channels: ['cache-invalidation'],
        debounceMs: 100,
        batchSize: 100,
        ...config.invalidation
      },
      serialization: {
        type: 'msgpack', // msgpack, json, buffer
        compress: true,
        compressionThreshold: 1024, // bytes
        ...config.serialization
      },
      consistency: {
        readThrough: true,
        writeThrough: true,
        writeBehind: false,
        writeBehindDelay: 1000,
        ...config.consistency
      },
      monitoring: {
        enabled: true,
        metricsInterval: 5000,
        ...config.monitoring
      }
    };
    
    this.layers = new Map();
    this.redis = null;
    this.subscriber = null;
    this.publisher = null;
    this.invalidationQueue = [];
    this.invalidationTimer = null;
    
    this.metrics = {
      hits: { l1: 0, l2: 0, redis: 0 },
      misses: { l1: 0, l2: 0, redis: 0 },
      sets: 0,
      deletes: 0,
      invalidations: 0,
      errors: 0,
      latency: { get: [], set: [], delete: [] }
    };
    
    this.initialize();
  }
  
  // Initialize cache system
  async initialize() {
    // Create Redis connections
    if (this.config.redis.cluster) {
      this.redis = new Redis.Cluster(this.config.redis.nodes, this.config.redis.options);
      this.subscriber = new Redis.Cluster(this.config.redis.nodes, this.config.redis.options);
      this.publisher = new Redis.Cluster(this.config.redis.nodes, this.config.redis.options);
    } else {
      this.redis = new Redis(this.config.redis.nodes[0]);
      this.subscriber = new Redis(this.config.redis.nodes[0]);
      this.publisher = new Redis(this.config.redis.nodes[0]);
    }
    
    // Initialize cache layers
    if (this.config.layers.l1.enabled) {
      this.layers.set('l1', this.createCacheLayer(this.config.layers.l1));
    }
    if (this.config.layers.l2.enabled) {
      this.layers.set('l2', this.createCacheLayer(this.config.layers.l2));
    }
    
    // Setup invalidation listeners
    await this.setupInvalidation();
    
    // Start monitoring
    if (this.config.monitoring.enabled) {
      this.startMonitoring();
    }
    
    this.emit('initialized');
  }
  
  // Create cache layer
  createCacheLayer(config) {
    switch (config.algorithm) {
      case 'LFU':
        return new LFUCache(config.maxSize);
      case 'ARC':
        return new ARCCache(config.maxSize);
      case 'LRU':
      default:
        return new LRUCache(config.maxSize);
    }
  }
  
  // Get value from cache
  async get(key, options = {}) {
    const startTime = Date.now();
    
    try {
      // Check L1 cache
      if (this.layers.has('l1')) {
        const l1Value = this.layers.get('l1').get(key);
        if (l1Value && !this.isExpired(l1Value)) {
          this.metrics.hits.l1++;
          this.recordLatency('get', Date.now() - startTime);
          return this.deserialize(l1Value.data);
        }
        this.metrics.misses.l1++;
      }
      
      // Check L2 cache
      if (this.layers.has('l2')) {
        const l2Value = this.layers.get('l2').get(key);
        if (l2Value && !this.isExpired(l2Value)) {
          this.metrics.hits.l2++;
          
          // Promote to L1
          if (this.layers.has('l1')) {
            this.layers.get('l1').set(key, l2Value);
          }
          
          this.recordLatency('get', Date.now() - startTime);
          return this.deserialize(l2Value.data);
        }
        this.metrics.misses.l2++;
      }
      
      // Check Redis
      const redisValue = await this.redis.get(this.formatKey(key));
      if (redisValue) {
        this.metrics.hits.redis++;
        
        const value = this.deserialize(redisValue);
        
        // Populate upper layers
        await this.populateLayers(key, value, options.ttl);
        
        this.recordLatency('get', Date.now() - startTime);
        return value;
      }
      
      this.metrics.misses.redis++;
      
      // Read-through if enabled
      if (this.config.consistency.readThrough && options.loader) {
        const value = await options.loader(key);
        if (value !== undefined) {
          await this.set(key, value, options.ttl);
        }
        return value;
      }
      
      this.recordLatency('get', Date.now() - startTime);
      return null;
      
    } catch (error) {
      this.metrics.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  // Set value in cache
  async set(key, value, ttl) {
    const startTime = Date.now();
    
    try {
      const serialized = this.serialize(value);
      const cacheEntry = {
        data: serialized,
        timestamp: Date.now(),
        ttl: ttl || this.config.layers.l2.ttl
      };
      
      // Set in all layers
      if (this.layers.has('l1')) {
        this.layers.get('l1').set(key, {
          ...cacheEntry,
          ttl: Math.min(ttl || this.config.layers.l1.ttl, this.config.layers.l1.ttl)
        });
      }
      
      if (this.layers.has('l2')) {
        this.layers.get('l2').set(key, cacheEntry);
      }
      
      // Set in Redis
      const redisKey = this.formatKey(key);
      if (ttl) {
        await this.redis.set(redisKey, serialized, 'PX', ttl);
      } else {
        await this.redis.set(redisKey, serialized);
      }
      
      this.metrics.sets++;
      this.recordLatency('set', Date.now() - startTime);
      
      // Write-behind if enabled
      if (this.config.consistency.writeBehind && options?.writer) {
        setTimeout(() => {
          options.writer(key, value).catch(err => this.emit('error', err));
        }, this.config.consistency.writeBehindDelay);
      }
      
      return true;
      
    } catch (error) {
      this.metrics.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  // Delete from cache
  async delete(key, options = {}) {
    const startTime = Date.now();
    
    try {
      // Delete from all layers
      if (this.layers.has('l1')) {
        this.layers.get('l1').delete(key);
      }
      
      if (this.layers.has('l2')) {
        this.layers.get('l2').delete(key);
      }
      
      // Delete from Redis
      await this.redis.del(this.formatKey(key));
      
      // Broadcast invalidation
      if (options.broadcast !== false) {
        await this.broadcastInvalidation([key]);
      }
      
      this.metrics.deletes++;
      this.recordLatency('delete', Date.now() - startTime);
      
      return true;
      
    } catch (error) {
      this.metrics.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  // Invalidate cache entries
  async invalidate(pattern, options = {}) {
    try {
      const keys = await this.findKeys(pattern);
      
      if (keys.length === 0) return 0;
      
      // Batch invalidation
      const batches = this.chunk(keys, this.config.invalidation.batchSize);
      
      for (const batch of batches) {
        await Promise.all(batch.map(key => this.delete(key, { broadcast: false })));
      }
      
      // Broadcast invalidation
      await this.broadcastInvalidation(keys);
      
      this.metrics.invalidations += keys.length;
      
      return keys.length;
      
    } catch (error) {
      this.metrics.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  // Setup cache invalidation
  async setupInvalidation() {
    // Subscribe to invalidation channels
    for (const channel of this.config.invalidation.channels) {
      await this.subscriber.subscribe(channel);
    }
    
    // Handle invalidation messages
    this.subscriber.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);
        this.handleInvalidation(data);
      } catch (error) {
        this.emit('error', error);
      }
    });
  }
  
  // Handle invalidation message
  handleInvalidation(data) {
    const { keys, pattern, source } = data;
    
    // Skip if from same instance
    if (source === this.instanceId) return;
    
    if (keys) {
      // Invalidate specific keys
      for (const key of keys) {
        if (this.layers.has('l1')) {
          this.layers.get('l1').delete(key);
        }
        if (this.layers.has('l2')) {
          this.layers.get('l2').delete(key);
        }
      }
    }
    
    if (pattern) {
      // Invalidate by pattern
      this.invalidatePattern(pattern);
    }
    
    this.emit('invalidation:received', data);
  }
  
  // Broadcast invalidation
  async broadcastInvalidation(keys) {
    const message = {
      keys,
      source: this.instanceId,
      timestamp: Date.now()
    };
    
    // Debounce invalidations
    this.invalidationQueue.push(message);
    
    if (!this.invalidationTimer) {
      this.invalidationTimer = setTimeout(() => {
        this.flushInvalidationQueue();
      }, this.config.invalidation.debounceMs);
    }
  }
  
  // Flush invalidation queue
  async flushInvalidationQueue() {
    if (this.invalidationQueue.length === 0) return;
    
    const messages = [...this.invalidationQueue];
    this.invalidationQueue = [];
    this.invalidationTimer = null;
    
    // Merge messages
    const merged = {
      keys: [],
      source: this.instanceId,
      timestamp: Date.now()
    };
    
    for (const msg of messages) {
      merged.keys.push(...msg.keys);
    }
    
    // Remove duplicates
    merged.keys = [...new Set(merged.keys)];
    
    // Publish to channels
    for (const channel of this.config.invalidation.channels) {
      await this.publisher.publish(channel, JSON.stringify(merged));
    }
    
    this.emit('invalidation:broadcast', merged);
  }
  
  // Tag-based cache invalidation
  async tag(key, tags) {
    if (!Array.isArray(tags)) tags = [tags];
    
    for (const tag of tags) {
      await this.redis.sadd(`tag:${tag}`, this.formatKey(key));
    }
  }
  
  async invalidateTag(tag) {
    const keys = await this.redis.smembers(`tag:${tag}`);
    
    if (keys.length > 0) {
      await Promise.all(keys.map(key => this.delete(key.replace(this.keyPrefix, ''))));
      await this.redis.del(`tag:${tag}`);
    }
    
    return keys.length;
  }
  
  // Find keys by pattern
  async findKeys(pattern) {
    const formattedPattern = this.formatKey(pattern);
    const keys = [];
    
    if (this.config.redis.cluster) {
      // Scan all nodes in cluster
      const nodes = this.redis.nodes('master');
      
      for (const node of nodes) {
        const nodeKeys = await this.scanKeys(node, formattedPattern);
        keys.push(...nodeKeys);
      }
    } else {
      // Scan single instance
      const scannedKeys = await this.scanKeys(this.redis, formattedPattern);
      keys.push(...scannedKeys);
    }
    
    return keys.map(key => key.replace(this.keyPrefix, ''));
  }
  
  // Scan keys from Redis
  async scanKeys(redis, pattern) {
    const keys = [];
    let cursor = '0';
    
    do {
      const [nextCursor, batch] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      );
      
      keys.push(...batch);
      cursor = nextCursor;
    } while (cursor !== '0');
    
    return keys;
  }
  
  // Warm up cache
  async warmup(keys, loader) {
    const results = await Promise.allSettled(
      keys.map(async key => {
        const value = await loader(key);
        if (value !== undefined) {
          await this.set(key, value);
        }
      })
    );
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    this.emit('warmup:completed', { successful, failed });
    
    return { successful, failed };
  }
  
  // Populate cache layers
  async populateLayers(key, value, ttl) {
    const serialized = this.serialize(value);
    const cacheEntry = {
      data: serialized,
      timestamp: Date.now(),
      ttl: ttl || this.config.layers.l2.ttl
    };
    
    if (this.layers.has('l2')) {
      this.layers.get('l2').set(key, cacheEntry);
    }
    
    if (this.layers.has('l1')) {
      this.layers.get('l1').set(key, {
        ...cacheEntry,
        ttl: Math.min(ttl || this.config.layers.l1.ttl, this.config.layers.l1.ttl)
      });
    }
  }
  
  // Check if cache entry is expired
  isExpired(entry) {
    if (!entry.ttl) return false;
    return Date.now() - entry.timestamp > entry.ttl;
  }
  
  // Serialize value
  serialize(value) {
    let data;
    
    switch (this.config.serialization.type) {
      case 'msgpack':
        data = msgpack.encode(value);
        break;
      case 'buffer':
        data = Buffer.from(JSON.stringify(value));
        break;
      case 'json':
      default:
        data = JSON.stringify(value);
        break;
    }
    
    // Compress if needed
    if (this.config.serialization.compress && 
        data.length > this.config.serialization.compressionThreshold) {
      const zlib = require('zlib');
      data = zlib.gzipSync(data);
    }
    
    return data;
  }
  
  // Deserialize value
  deserialize(data) {
    // Decompress if needed
    if (this.config.serialization.compress && Buffer.isBuffer(data)) {
      const zlib = require('zlib');
      try {
        data = zlib.gunzipSync(data);
      } catch (e) {
        // Not compressed
      }
    }
    
    switch (this.config.serialization.type) {
      case 'msgpack':
        return msgpack.decode(data);
      case 'buffer':
        return JSON.parse(data.toString());
      case 'json':
      default:
        return typeof data === 'string' ? JSON.parse(data) : data;
    }
  }
  
  // Format cache key
  formatKey(key) {
    return `${this.keyPrefix}${key}`;
  }
  
  get keyPrefix() {
    return 'cache:';
  }
  
  get instanceId() {
    if (!this._instanceId) {
      this._instanceId = crypto.randomBytes(8).toString('hex');
    }
    return this._instanceId;
  }
  
  // Record latency metrics
  recordLatency(operation, latency) {
    this.metrics.latency[operation].push(latency);
    
    // Keep only last 100 samples
    if (this.metrics.latency[operation].length > 100) {
      this.metrics.latency[operation].shift();
    }
  }
  
  // Chunk array
  chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
  
  // Start monitoring
  startMonitoring() {
    this.monitoringTimer = setInterval(() => {
      this.collectMetrics();
    }, this.config.monitoring.metricsInterval);
  }
  
  // Collect metrics
  collectMetrics() {
    const metrics = {
      ...this.metrics,
      hitRate: {
        l1: this.calculateHitRate('l1'),
        l2: this.calculateHitRate('l2'),
        redis: this.calculateHitRate('redis')
      },
      avgLatency: {
        get: this.calculateAvgLatency('get'),
        set: this.calculateAvgLatency('set'),
        delete: this.calculateAvgLatency('delete')
      },
      memory: {
        l1: this.layers.has('l1') ? this.layers.get('l1').size : 0,
        l2: this.layers.has('l2') ? this.layers.get('l2').size : 0
      },
      timestamp: new Date()
    };
    
    this.emit('metrics:collected', metrics);
    
    return metrics;
  }
  
  // Calculate hit rate
  calculateHitRate(layer) {
    const hits = this.metrics.hits[layer];
    const misses = this.metrics.misses[layer];
    const total = hits + misses;
    
    return total > 0 ? (hits / total) * 100 : 0;
  }
  
  // Calculate average latency
  calculateAvgLatency(operation) {
    const samples = this.metrics.latency[operation];
    if (samples.length === 0) return 0;
    
    const sum = samples.reduce((a, b) => a + b, 0);
    return sum / samples.length;
  }
  
  // Express middleware
  middleware(options = {}) {
    return async (req, res, next) => {
      // Create cache key
      const key = options.keyGenerator ? 
        options.keyGenerator(req) : 
        `${req.method}:${req.originalUrl}`;
      
      // Skip caching for certain requests
      if (options.skip && options.skip(req)) {
        return next();
      }
      
      // Try to get from cache
      const cached = await this.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(cached);
      }
      
      // Cache miss - capture response
      res.set('X-Cache', 'MISS');
      
      const originalJson = res.json;
      res.json = (body) => {
        // Cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.set(key, body, options.ttl || 60000).catch(err => 
            console.error('Cache set error:', err)
          );
        }
        
        return originalJson.call(res, body);
      };
      
      next();
    };
  }
  
  // Cleanup
  async cleanup() {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
    }
    
    if (this.invalidationTimer) {
      clearTimeout(this.invalidationTimer);
    }
    
    await this.flushInvalidationQueue();
    
    await this.redis.quit();
    await this.subscriber.quit();
    await this.publisher.quit();
    
    this.emit('cleanup');
  }
}

// LRU Cache implementation
class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  
  get(key) {
    if (!this.cache.has(key)) return null;
    
    // Move to end (most recent)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    
    return value;
  }
  
  set(key, value) {
    // Remove if exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // Add to end
    this.cache.set(key, value);
    
    // Evict if needed
    if (this.cache.size > this.maxSize) {
      // Remove first (least recent)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }
  
  delete(key) {
    return this.cache.delete(key);
  }
  
  get size() {
    return this.cache.size;
  }
}

// LFU Cache implementation
class LFUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.frequencies = new Map();
    this.minFreq = 0;
  }
  
  get(key) {
    if (!this.cache.has(key)) return null;
    
    const entry = this.cache.get(key);
    this.updateFrequency(key);
    
    return entry.value;
  }
  
  set(key, value) {
    if (this.maxSize === 0) return;
    
    if (this.cache.has(key)) {
      // Update existing
      const entry = this.cache.get(key);
      entry.value = value;
      this.updateFrequency(key);
    } else {
      // Add new
      if (this.cache.size >= this.maxSize) {
        this.evict();
      }
      
      this.cache.set(key, { value, freq: 1 });
      this.addToFrequencyList(key, 1);
      this.minFreq = 1;
    }
  }
  
  updateFrequency(key) {
    const entry = this.cache.get(key);
    const freq = entry.freq;
    
    // Remove from current frequency list
    this.removeFromFrequencyList(key, freq);
    
    // Update frequency
    entry.freq = freq + 1;
    
    // Add to new frequency list
    this.addToFrequencyList(key, freq + 1);
  }
  
  addToFrequencyList(key, freq) {
    if (!this.frequencies.has(freq)) {
      this.frequencies.set(freq, new Set());
    }
    this.frequencies.get(freq).add(key);
  }
  
  removeFromFrequencyList(key, freq) {
    const keys = this.frequencies.get(freq);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        this.frequencies.delete(freq);
        if (this.minFreq === freq) {
          this.minFreq++;
        }
      }
    }
  }
  
  evict() {
    const keys = this.frequencies.get(this.minFreq);
    const keyToEvict = keys.values().next().value;
    
    keys.delete(keyToEvict);
    if (keys.size === 0) {
      this.frequencies.delete(this.minFreq);
    }
    
    this.cache.delete(keyToEvict);
  }
  
  delete(key) {
    if (!this.cache.has(key)) return false;
    
    const entry = this.cache.get(key);
    this.removeFromFrequencyList(key, entry.freq);
    
    return this.cache.delete(key);
  }
  
  get size() {
    return this.cache.size;
  }
}

// ARC Cache implementation
class ARCCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.p = 0; // Target size for T1
    
    this.t1 = new Map(); // Recent cache entries
    this.t2 = new Map(); // Frequent cache entries
    this.b1 = new Map(); // Ghost entries for T1
    this.b2 = new Map(); // Ghost entries for T2
  }
  
  get(key) {
    if (this.t1.has(key)) {
      // Move from T1 to T2
      const value = this.t1.get(key);
      this.t1.delete(key);
      this.t2.set(key, value);
      return value;
    }
    
    if (this.t2.has(key)) {
      // Move to end of T2
      const value = this.t2.get(key);
      this.t2.delete(key);
      this.t2.set(key, value);
      return value;
    }
    
    return null;
  }
  
  set(key, value) {
    if (this.t1.has(key) || this.t2.has(key)) {
      // Update existing
      if (this.t1.has(key)) {
        this.t1.set(key, value);
      } else {
        this.t2.set(key, value);
      }
      return;
    }
    
    if (this.b1.has(key)) {
      // Adapt p
      const delta = this.b1.size >= this.b2.size ? 1 : this.b2.size / this.b1.size;
      this.p = Math.min(this.p + delta, this.maxSize);
      
      this.replace(key, this.p);
      this.b1.delete(key);
      this.t2.set(key, value);
      return;
    }
    
    if (this.b2.has(key)) {
      // Adapt p
      const delta = this.b2.size >= this.b1.size ? 1 : this.b1.size / this.b2.size;
      this.p = Math.max(this.p - delta, 0);
      
      this.replace(key, this.p);
      this.b2.delete(key);
      this.t2.set(key, value);
      return;
    }
    
    // New entry
    if (this.t1.size + this.b1.size === this.maxSize) {
      if (this.t1.size < this.maxSize) {
        // Remove from B1
        const oldestB1 = this.b1.keys().next().value;
        this.b1.delete(oldestB1);
        this.replace(key, this.p);
      } else {
        // Remove from T1
        const oldestT1 = this.t1.keys().next().value;
        this.t1.delete(oldestT1);
      }
    } else {
      const total = this.t1.size + this.b1.size + this.t2.size + this.b2.size;
      if (total >= this.maxSize) {
        if (total === 2 * this.maxSize) {
          // Remove from B2
          const oldestB2 = this.b2.keys().next().value;
          this.b2.delete(oldestB2);
        }
        this.replace(key, this.p);
      }
    }
    
    this.t1.set(key, value);
  }
  
  replace(key, p) {
    if (this.t1.size >= 1 && 
        (this.t1.size > p || (this.b2.has(key) && this.t1.size === p))) {
      // Move from T1 to B1
      const oldestT1 = this.t1.keys().next().value;
      this.t1.delete(oldestT1);
      this.b1.set(oldestT1, true);
    } else {
      // Move from T2 to B2
      const oldestT2 = this.t2.keys().next().value;
      this.t2.delete(oldestT2);
      this.b2.set(oldestT2, true);
    }
  }
  
  delete(key) {
    return this.t1.delete(key) || this.t2.delete(key) || 
           this.b1.delete(key) || this.b2.delete(key);
  }
  
  get size() {
    return this.t1.size + this.t2.size;
  }
}

module.exports = DistributedCache;