// Feature Flags System for Sierra Sync
// Dynamic feature toggling and gradual rollouts

const EventEmitter = require('events');
const crypto = require('crypto');

class FeatureFlags extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      provider: process.env.FEATURE_FLAGS_PROVIDER || 'internal',
      launchDarkly: {
        sdkKey: process.env.LAUNCHDARKLY_SDK_KEY,
        ...config.launchDarkly,
      },
      split: {
        apiKey: process.env.SPLIT_API_KEY,
        ...config.split,
      },
      unleash: {
        url: process.env.UNLEASH_URL,
        apiKey: process.env.UNLEASH_API_KEY,
        appName: 'sierra-sync',
        ...config.unleash,
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        ...config.redis,
      },
      refreshInterval: 30000, // 30 seconds
      ...config,
    };
    
    this.flags = new Map();
    this.overrides = new Map();
    this.experiments = new Map();
    this.metrics = {
      evaluations: new Map(),
      experiments: new Map(),
    };
    
    this.initializeProvider();
    this.startRefreshTimer();
  }
  
  // Initialize feature flag provider
  async initializeProvider() {
    switch (this.config.provider) {
      case 'launchdarkly':
        await this.initializeLaunchDarkly();
        break;
      case 'split':
        await this.initializeSplit();
        break;
      case 'unleash':
        await this.initializeUnleash();
        break;
      case 'internal':
      default:
        await this.initializeInternal();
        break;
    }
    
    this.emit('initialized');
  }
  
  async initializeLaunchDarkly() {
    const LaunchDarkly = require('launchdarkly-node-server-sdk');
    this.ldClient = LaunchDarkly.init(this.config.launchDarkly.sdkKey);
    
    await this.ldClient.waitForInitialization();
    
    // Set up change listener
    this.ldClient.on('update', (key) => {
      this.emit('flag:updated', key);
    });
  }
  
  async initializeSplit() {
    const SplitFactory = require('@splitsoftware/splitio').SplitFactory;
    
    this.splitClient = SplitFactory({
      core: {
        authorizationKey: this.config.split.apiKey,
      },
    }).client();
    
    await this.splitClient.ready();
  }
  
  async initializeUnleash() {
    const { Unleash } = require('unleash-client');
    
    this.unleashClient = new Unleash({
      url: this.config.unleash.url,
      appName: this.config.unleash.appName,
      customHeaders: {
        Authorization: this.config.unleash.apiKey,
      },
    });
    
    this.unleashClient.on('synchronized', () => {
      this.emit('flags:synchronized');
    });
  }
  
  async initializeInternal() {
    // Load flags from configuration
    this.loadInternalFlags();
  }
  
  loadInternalFlags() {
    // Default feature flags
    const defaultFlags = {
      // Core Features
      'new-dashboard': {
        enabled: true,
        rolloutPercentage: 100,
        targeting: [],
      },
      'advanced-analytics': {
        enabled: true,
        rolloutPercentage: 50,
        targeting: ['beta-users'],
      },
      'real-time-sync': {
        enabled: true,
        rolloutPercentage: 100,
        targeting: [],
      },
      'ai-recommendations': {
        enabled: false,
        rolloutPercentage: 0,
        targeting: ['internal-users'],
      },
      
      // Performance Features
      'lazy-loading': {
        enabled: true,
        rolloutPercentage: 100,
        targeting: [],
      },
      'websocket-transport': {
        enabled: true,
        rolloutPercentage: 75,
        targeting: [],
      },
      'graphql-api': {
        enabled: false,
        rolloutPercentage: 10,
        targeting: ['api-beta'],
      },
      
      // Security Features
      'two-factor-auth': {
        enabled: true,
        rolloutPercentage: 100,
        targeting: [],
      },
      'biometric-login': {
        enabled: false,
        rolloutPercentage: 0,
        targeting: ['mobile-users'],
      },
      'passwordless-auth': {
        enabled: true,
        rolloutPercentage: 25,
        targeting: ['trusted-users'],
      },
      
      // Experimental Features
      'dark-mode': {
        enabled: true,
        rolloutPercentage: 100,
        targeting: [],
      },
      'voice-commands': {
        enabled: false,
        rolloutPercentage: 5,
        targeting: ['power-users'],
      },
      'blockchain-integration': {
        enabled: false,
        rolloutPercentage: 0,
        targeting: ['enterprise-users'],
      },
      
      // Maintenance Flags
      'maintenance-mode': {
        enabled: false,
        rolloutPercentage: 0,
        targeting: [],
      },
      'read-only-mode': {
        enabled: false,
        rolloutPercentage: 0,
        targeting: [],
      },
      'rate-limiting-strict': {
        enabled: false,
        rolloutPercentage: 0,
        targeting: [],
      },
    };
    
    Object.entries(defaultFlags).forEach(([key, value]) => {
      this.flags.set(key, value);
    });
  }
  
  // Check if feature is enabled
  async isEnabled(flagKey, context = {}) {
    // Check for overrides first
    if (this.overrides.has(flagKey)) {
      return this.overrides.get(flagKey);
    }
    
    // Track evaluation
    this.trackEvaluation(flagKey, context);
    
    // Check based on provider
    switch (this.config.provider) {
      case 'launchdarkly':
        return await this.evaluateLaunchDarkly(flagKey, context);
      case 'split':
        return await this.evaluateSplit(flagKey, context);
      case 'unleash':
        return this.evaluateUnleash(flagKey, context);
      case 'internal':
      default:
        return this.evaluateInternal(flagKey, context);
    }
  }
  
  async evaluateLaunchDarkly(flagKey, context) {
    if (!this.ldClient) return false;
    
    const user = {
      key: context.userId || 'anonymous',
      email: context.email,
      custom: context,
    };
    
    return await this.ldClient.variation(flagKey, user, false);
  }
  
  async evaluateSplit(flagKey, context) {
    if (!this.splitClient) return false;
    
    const treatment = this.splitClient.getTreatment(
      context.userId || 'anonymous',
      flagKey,
      context
    );
    
    return treatment === 'on';
  }
  
  evaluateUnleash(flagKey, context) {
    if (!this.unleashClient) return false;
    
    return this.unleashClient.isEnabled(flagKey, {
      userId: context.userId,
      sessionId: context.sessionId,
      remoteAddress: context.ip,
      properties: context,
    });
  }
  
  evaluateInternal(flagKey, context) {
    const flag = this.flags.get(flagKey);
    if (!flag) return false;
    
    // Check if globally disabled
    if (!flag.enabled) return false;
    
    // Check targeting rules
    if (flag.targeting && flag.targeting.length > 0) {
      const matched = this.evaluateTargeting(flag.targeting, context);
      if (matched) return true;
    }
    
    // Check rollout percentage
    if (flag.rolloutPercentage < 100) {
      return this.evaluateRollout(flagKey, flag.rolloutPercentage, context);
    }
    
    return true;
  }
  
  evaluateTargeting(rules, context) {
    for (const rule of rules) {
      if (typeof rule === 'string') {
        // Simple group targeting
        if (context.groups && context.groups.includes(rule)) {
          return true;
        }
      } else if (typeof rule === 'object') {
        // Complex rule evaluation
        if (this.evaluateRule(rule, context)) {
          return true;
        }
      }
    }
    return false;
  }
  
  evaluateRule(rule, context) {
    switch (rule.operator) {
      case 'equals':
        return context[rule.attribute] === rule.value;
      case 'contains':
        return context[rule.attribute]?.includes(rule.value);
      case 'greater_than':
        return context[rule.attribute] > rule.value;
      case 'less_than':
        return context[rule.attribute] < rule.value;
      case 'regex':
        return new RegExp(rule.value).test(context[rule.attribute]);
      default:
        return false;
    }
  }
  
  evaluateRollout(flagKey, percentage, context) {
    const userId = context.userId || 'anonymous';
    const hash = crypto
      .createHash('md5')
      .update(`${flagKey}-${userId}`)
      .digest('hex');
    
    const bucket = parseInt(hash.substring(0, 8), 16) % 100;
    return bucket < percentage;
  }
  
  // Get feature value (for non-boolean flags)
  async getValue(flagKey, defaultValue, context = {}) {
    this.trackEvaluation(flagKey, context);
    
    switch (this.config.provider) {
      case 'launchdarkly':
        if (!this.ldClient) return defaultValue;
        const user = {
          key: context.userId || 'anonymous',
          custom: context,
        };
        return await this.ldClient.variation(flagKey, user, defaultValue);
        
      case 'split':
        if (!this.splitClient) return defaultValue;
        const treatment = this.splitClient.getTreatmentWithConfig(
          context.userId || 'anonymous',
          flagKey,
          context
        );
        return treatment.config ? JSON.parse(treatment.config) : defaultValue;
        
      default:
        const flag = this.flags.get(flagKey);
        return flag?.value || defaultValue;
    }
  }
  
  // Get all flags for a context
  async getAllFlags(context = {}) {
    const result = {};
    
    for (const [key] of this.flags) {
      result[key] = await this.isEnabled(key, context);
    }
    
    return result;
  }
  
  // Set flag override (for testing)
  setOverride(flagKey, value) {
    this.overrides.set(flagKey, value);
    this.emit('flag:overridden', flagKey, value);
  }
  
  // Clear flag override
  clearOverride(flagKey) {
    this.overrides.delete(flagKey);
    this.emit('flag:override:cleared', flagKey);
  }
  
  // Clear all overrides
  clearAllOverrides() {
    this.overrides.clear();
    this.emit('overrides:cleared');
  }
  
  // Update flag configuration
  async updateFlag(flagKey, config) {
    const existing = this.flags.get(flagKey) || {};
    const updated = { ...existing, ...config };
    
    this.flags.set(flagKey, updated);
    
    // Persist to storage
    await this.persistFlag(flagKey, updated);
    
    this.emit('flag:updated', flagKey, updated);
  }
  
  // Persist flag to storage
  async persistFlag(flagKey, config) {
    // Implement persistence logic (Redis, database, etc.)
    if (this.config.redis) {
      const redis = require('redis').createClient(this.config.redis);
      await redis.connect();
      await redis.set(`feature_flag:${flagKey}`, JSON.stringify(config));
      await redis.quit();
    }
  }
  
  // Create A/B test experiment
  createExperiment(experimentId, config) {
    const experiment = {
      id: experimentId,
      name: config.name,
      description: config.description,
      flagKey: config.flagKey,
      variants: config.variants || ['control', 'treatment'],
      weights: config.weights || [50, 50],
      startDate: config.startDate || new Date(),
      endDate: config.endDate,
      targetingRules: config.targetingRules || [],
      metrics: config.metrics || [],
      status: 'active',
    };
    
    this.experiments.set(experimentId, experiment);
    this.emit('experiment:created', experiment);
    
    return experiment;
  }
  
  // Get experiment variant for user
  getExperimentVariant(experimentId, context) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment || experiment.status !== 'active') {
      return 'control';
    }
    
    // Check if experiment has ended
    if (experiment.endDate && new Date() > experiment.endDate) {
      experiment.status = 'completed';
      return 'control';
    }
    
    // Check targeting rules
    if (experiment.targetingRules.length > 0) {
      const matched = this.evaluateTargeting(experiment.targetingRules, context);
      if (!matched) return 'control';
    }
    
    // Assign variant based on weights
    const userId = context.userId || 'anonymous';
    const hash = crypto
      .createHash('md5')
      .update(`${experimentId}-${userId}`)
      .digest('hex');
    
    const bucket = parseInt(hash.substring(0, 8), 16) % 100;
    
    let cumulative = 0;
    for (let i = 0; i < experiment.variants.length; i++) {
      cumulative += experiment.weights[i];
      if (bucket < cumulative) {
        const variant = experiment.variants[i];
        this.trackExperimentExposure(experimentId, variant, context);
        return variant;
      }
    }
    
    return experiment.variants[0];
  }
  
  // Track feature flag evaluation
  trackEvaluation(flagKey, context) {
    const evaluations = this.metrics.evaluations.get(flagKey) || {
      total: 0,
      enabled: 0,
      disabled: 0,
      contexts: new Set(),
    };
    
    evaluations.total++;
    evaluations.contexts.add(context.userId || 'anonymous');
    
    this.metrics.evaluations.set(flagKey, evaluations);
  }
  
  // Track experiment exposure
  trackExperimentExposure(experimentId, variant, context) {
    const exposures = this.metrics.experiments.get(experimentId) || {
      total: 0,
      variants: {},
      users: new Set(),
    };
    
    exposures.total++;
    exposures.variants[variant] = (exposures.variants[variant] || 0) + 1;
    exposures.users.add(context.userId || 'anonymous');
    
    this.metrics.experiments.set(experimentId, exposures);
    
    this.emit('experiment:exposure', {
      experimentId,
      variant,
      userId: context.userId,
      timestamp: new Date(),
    });
  }
  
  // Get metrics
  getMetrics() {
    const flagMetrics = {};
    for (const [key, value] of this.metrics.evaluations) {
      flagMetrics[key] = {
        ...value,
        uniqueUsers: value.contexts.size,
      };
    }
    
    const experimentMetrics = {};
    for (const [key, value] of this.metrics.experiments) {
      experimentMetrics[key] = {
        ...value,
        uniqueUsers: value.users.size,
      };
    }
    
    return {
      flags: flagMetrics,
      experiments: experimentMetrics,
    };
  }
  
  // Refresh flags periodically
  startRefreshTimer() {
    setInterval(() => {
      this.refreshFlags();
    }, this.config.refreshInterval);
  }
  
  async refreshFlags() {
    if (this.config.provider === 'internal') {
      // Reload from storage
      await this.loadFlagsFromStorage();
    }
    
    this.emit('flags:refreshed');
  }
  
  async loadFlagsFromStorage() {
    if (this.config.redis) {
      const redis = require('redis').createClient(this.config.redis);
      await redis.connect();
      
      const keys = await redis.keys('feature_flag:*');
      for (const key of keys) {
        const flagKey = key.replace('feature_flag:', '');
        const value = await redis.get(key);
        if (value) {
          this.flags.set(flagKey, JSON.parse(value));
        }
      }
      
      await redis.quit();
    }
  }
  
  // Express middleware
  middleware() {
    return (req, res, next) => {
      req.featureFlags = {
        isEnabled: (flagKey) => {
          const context = {
            userId: req.user?.id,
            email: req.user?.email,
            organizationId: req.organization?.id,
            groups: req.user?.groups || [],
            ip: req.ip,
            userAgent: req.get('user-agent'),
            ...req.featureFlagContext,
          };
          
          return this.isEnabled(flagKey, context);
        },
        getValue: (flagKey, defaultValue) => {
          const context = {
            userId: req.user?.id,
            email: req.user?.email,
            organizationId: req.organization?.id,
            groups: req.user?.groups || [],
            ...req.featureFlagContext,
          };
          
          return this.getValue(flagKey, defaultValue, context);
        },
        getVariant: (experimentId) => {
          const context = {
            userId: req.user?.id,
            email: req.user?.email,
            organizationId: req.organization?.id,
            ...req.featureFlagContext,
          };
          
          return this.getExperimentVariant(experimentId, context);
        },
      };
      
      next();
    };
  }
  
  // Cleanup
  async cleanup() {
    if (this.ldClient) {
      await this.ldClient.close();
    }
    if (this.splitClient) {
      await this.splitClient.destroy();
    }
    if (this.unleashClient) {
      this.unleashClient.destroy();
    }
  }
}

module.exports = FeatureFlags;