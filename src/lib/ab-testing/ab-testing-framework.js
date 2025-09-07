// A/B Testing Framework for Sierra Sync
// Statistical experiment design and analysis

const EventEmitter = require('events');
const crypto = require('crypto');
const { jStat } = require('jstat');

class ABTestingFramework extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      minSampleSize: 100,
      confidenceLevel: 0.95,
      statisticalPower: 0.8,
      minimumDetectableEffect: 0.05,
      segmentationEnabled: true,
      multiVariateEnabled: true,
      bayesianEnabled: true,
      storage: {
        type: process.env.AB_STORAGE_TYPE || 'redis',
        redis: {
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT || 6379,
        },
      },
      ...config,
    };
    
    this.experiments = new Map();
    this.assignments = new Map();
    this.metrics = new Map();
    this.segments = new Map();
    
    this.initialize();
  }
  
  async initialize() {
    await this.loadExperiments();
    this.startMetricsCollection();
    this.emit('initialized');
  }
  
  // Create new A/B test experiment
  createExperiment(config) {
    const experiment = {
      id: config.id || this.generateExperimentId(),
      name: config.name,
      description: config.description,
      hypothesis: config.hypothesis,
      
      // Experiment design
      type: config.type || 'ab', // ab, multivariate, bandit
      variants: this.createVariants(config.variants),
      control: config.control || 'control',
      
      // Traffic allocation
      trafficAllocation: config.trafficAllocation || 1.0,
      trafficSplit: config.trafficSplit || this.calculateEvenSplit(config.variants),
      
      // Targeting
      targetingRules: config.targetingRules || [],
      segments: config.segments || [],
      excludeSegments: config.excludeSegments || [],
      
      // Metrics
      primaryMetric: config.primaryMetric,
      secondaryMetrics: config.secondaryMetrics || [],
      guardrailMetrics: config.guardrailMetrics || [],
      
      // Statistical configuration
      statisticalConfig: {
        minSampleSize: config.minSampleSize || this.config.minSampleSize,
        confidenceLevel: config.confidenceLevel || this.config.confidenceLevel,
        statisticalPower: config.statisticalPower || this.config.statisticalPower,
        mde: config.mde || this.config.minimumDetectableEffect,
        multipleTestingCorrection: config.multipleTestingCorrection || 'bonferroni',
      },
      
      // Lifecycle
      status: 'draft',
      startDate: config.startDate,
      endDate: config.endDate,
      createdAt: new Date(),
      updatedAt: new Date(),
      
      // Results
      results: {
        variants: {},
        conclusions: [],
        winner: null,
      },
    };
    
    // Calculate required sample size
    experiment.requiredSampleSize = this.calculateSampleSize(experiment.statisticalConfig);
    
    this.experiments.set(experiment.id, experiment);
    this.emit('experiment:created', experiment);
    
    return experiment;
  }
  
  createVariants(variantConfig) {
    if (Array.isArray(variantConfig)) {
      return variantConfig.map(name => ({
        id: name,
        name,
        changes: {},
      }));
    }
    
    return Object.entries(variantConfig).map(([id, config]) => ({
      id,
      name: config.name || id,
      changes: config.changes || {},
      description: config.description,
    }));
  }
  
  calculateEvenSplit(variants) {
    const numVariants = Array.isArray(variants) ? variants.length : Object.keys(variants).length;
    const split = 100 / numVariants;
    
    const result = {};
    const variantIds = Array.isArray(variants) ? variants : Object.keys(variants);
    
    variantIds.forEach((id, index) => {
      if (index === variantIds.length - 1) {
        // Last variant gets remainder to ensure 100%
        result[id] = 100 - (split * (numVariants - 1));
      } else {
        result[id] = split;
      }
    });
    
    return result;
  }
  
  // Calculate required sample size
  calculateSampleSize(config) {
    const { confidenceLevel, statisticalPower, mde } = config;
    
    // Z-scores for confidence level and power
    const zAlpha = jStat.normal.inv(1 - (1 - confidenceLevel) / 2, 0, 1);
    const zBeta = jStat.normal.inv(statisticalPower, 0, 1);
    
    // Baseline conversion rate (assumed 0.5 for maximum variance)
    const p = 0.5;
    
    // Sample size per variant
    const n = Math.ceil(
      2 * Math.pow(zAlpha + zBeta, 2) * p * (1 - p) / Math.pow(mde, 2)
    );
    
    return n;
  }
  
  // Start experiment
  async startExperiment(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment ${experimentId} not found`);
    }
    
    if (experiment.status === 'running') {
      throw new Error(`Experiment ${experimentId} is already running`);
    }
    
    experiment.status = 'running';
    experiment.startDate = new Date();
    experiment.updatedAt = new Date();
    
    await this.persistExperiment(experiment);
    this.emit('experiment:started', experiment);
    
    return experiment;
  }
  
  // Stop experiment
  async stopExperiment(experimentId, reason) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment ${experimentId} not found`);
    }
    
    experiment.status = 'stopped';
    experiment.endDate = new Date();
    experiment.stopReason = reason;
    experiment.updatedAt = new Date();
    
    // Analyze final results
    await this.analyzeExperiment(experimentId);
    
    await this.persistExperiment(experiment);
    this.emit('experiment:stopped', experiment);
    
    return experiment;
  }
  
  // Get variant assignment for user
  getVariant(experimentId, userId, context = {}) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment || experiment.status !== 'running') {
      return null;
    }
    
    // Check if user is already assigned
    const assignmentKey = `${experimentId}:${userId}`;
    if (this.assignments.has(assignmentKey)) {
      return this.assignments.get(assignmentKey);
    }
    
    // Check targeting rules
    if (!this.evaluateTargeting(experiment, context)) {
      return null;
    }
    
    // Check traffic allocation
    if (!this.isInTrafficAllocation(experimentId, userId, experiment.trafficAllocation)) {
      return null;
    }
    
    // Assign variant
    const variant = this.assignVariant(experiment, userId);
    
    // Store assignment
    this.assignments.set(assignmentKey, variant);
    this.trackAssignment(experimentId, variant, userId, context);
    
    return variant;
  }
  
  evaluateTargeting(experiment, context) {
    // Check exclude segments first
    for (const segment of experiment.excludeSegments) {
      if (this.isInSegment(segment, context)) {
        return false;
      }
    }
    
    // Check include segments
    if (experiment.segments.length > 0) {
      let included = false;
      for (const segment of experiment.segments) {
        if (this.isInSegment(segment, context)) {
          included = true;
          break;
        }
      }
      if (!included) return false;
    }
    
    // Check targeting rules
    for (const rule of experiment.targetingRules) {
      if (!this.evaluateRule(rule, context)) {
        return false;
      }
    }
    
    return true;
  }
  
  isInSegment(segmentId, context) {
    const segment = this.segments.get(segmentId);
    if (!segment) return false;
    
    return segment.evaluate(context);
  }
  
  evaluateRule(rule, context) {
    const value = context[rule.attribute];
    
    switch (rule.operator) {
      case 'equals':
        return value === rule.value;
      case 'not_equals':
        return value !== rule.value;
      case 'contains':
        return value?.includes(rule.value);
      case 'not_contains':
        return !value?.includes(rule.value);
      case 'greater_than':
        return value > rule.value;
      case 'less_than':
        return value < rule.value;
      case 'regex':
        return new RegExp(rule.value).test(value);
      case 'in':
        return rule.value.includes(value);
      case 'not_in':
        return !rule.value.includes(value);
      default:
        return false;
    }
  }
  
  isInTrafficAllocation(experimentId, userId, allocation) {
    if (allocation >= 1.0) return true;
    
    const hash = crypto
      .createHash('md5')
      .update(`${experimentId}:traffic:${userId}`)
      .digest('hex');
    
    const bucket = parseInt(hash.substring(0, 8), 16) / 0xffffffff;
    return bucket < allocation;
  }
  
  assignVariant(experiment, userId) {
    const hash = crypto
      .createHash('md5')
      .update(`${experiment.id}:${userId}`)
      .digest('hex');
    
    const bucket = (parseInt(hash.substring(0, 8), 16) / 0xffffffff) * 100;
    
    let cumulative = 0;
    for (const [variantId, weight] of Object.entries(experiment.trafficSplit)) {
      cumulative += weight;
      if (bucket < cumulative) {
        return variantId;
      }
    }
    
    // Fallback to first variant
    return Object.keys(experiment.trafficSplit)[0];
  }
  
  // Track assignment
  trackAssignment(experimentId, variant, userId, context) {
    const key = `assignment:${experimentId}:${variant}`;
    let data = this.metrics.get(key) || {
      count: 0,
      users: new Set(),
      firstSeen: new Date(),
      lastSeen: new Date(),
    };
    
    data.count++;
    data.users.add(userId);
    data.lastSeen = new Date();
    
    this.metrics.set(key, data);
    
    this.emit('experiment:assignment', {
      experimentId,
      variant,
      userId,
      context,
      timestamp: new Date(),
    });
  }
  
  // Track conversion
  async trackConversion(experimentId, userId, metricName, value = 1, metadata = {}) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return;
    
    const assignmentKey = `${experimentId}:${userId}`;
    const variant = this.assignments.get(assignmentKey);
    if (!variant) return;
    
    const key = `conversion:${experimentId}:${variant}:${metricName}`;
    let data = this.metrics.get(key) || {
      count: 0,
      sum: 0,
      sumSquares: 0,
      users: new Set(),
      values: [],
    };
    
    data.count++;
    data.sum += value;
    data.sumSquares += value * value;
    data.users.add(userId);
    data.values.push(value);
    
    this.metrics.set(key, data);
    
    // Store detailed conversion event
    await this.storeConversionEvent({
      experimentId,
      variant,
      userId,
      metricName,
      value,
      metadata,
      timestamp: new Date(),
    });
    
    this.emit('experiment:conversion', {
      experimentId,
      variant,
      userId,
      metricName,
      value,
    });
    
    // Check if experiment has reached statistical significance
    if (experiment.status === 'running') {
      await this.checkStatisticalSignificance(experimentId);
    }
  }
  
  // Analyze experiment results
  async analyzeExperiment(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) return null;
    
    const results = {
      summary: {},
      variants: {},
      primaryMetric: {},
      secondaryMetrics: {},
      guardrailMetrics: {},
      segmentAnalysis: {},
      statisticalTests: {},
      recommendations: [],
    };
    
    // Analyze each variant
    for (const variant of experiment.variants) {
      const variantResults = await this.analyzeVariant(experiment, variant.id);
      results.variants[variant.id] = variantResults;
    }
    
    // Primary metric analysis
    results.primaryMetric = await this.analyzeMetric(
      experiment,
      experiment.primaryMetric,
      experiment.variants
    );
    
    // Secondary metrics
    for (const metric of experiment.secondaryMetrics) {
      results.secondaryMetrics[metric] = await this.analyzeMetric(
        experiment,
        metric,
        experiment.variants
      );
    }
    
    // Guardrail metrics
    for (const metric of experiment.guardrailMetrics) {
      results.guardrailMetrics[metric] = await this.analyzeMetric(
        experiment,
        metric,
        experiment.variants
      );
    }
    
    // Statistical tests
    results.statisticalTests = this.runStatisticalTests(experiment, results);
    
    // Determine winner
    results.winner = this.determineWinner(experiment, results);
    
    // Generate recommendations
    results.recommendations = this.generateRecommendations(experiment, results);
    
    // Update experiment
    experiment.results = results;
    experiment.updatedAt = new Date();
    
    await this.persistExperiment(experiment);
    this.emit('experiment:analyzed', experiment);
    
    return results;
  }
  
  async analyzeVariant(experiment, variantId) {
    const assignmentKey = `assignment:${experiment.id}:${variantId}`;
    const assignmentData = this.metrics.get(assignmentKey) || { users: new Set() };
    
    const result = {
      sampleSize: assignmentData.users.size,
      metrics: {},
    };
    
    // Analyze each metric for this variant
    const metrics = [
      experiment.primaryMetric,
      ...experiment.secondaryMetrics,
      ...experiment.guardrailMetrics,
    ];
    
    for (const metric of metrics) {
      const conversionKey = `conversion:${experiment.id}:${variantId}:${metric}`;
      const conversionData = this.metrics.get(conversionKey) || {
        count: 0,
        sum: 0,
        sumSquares: 0,
        users: new Set(),
      };
      
      const conversionRate = conversionData.users.size / assignmentData.users.size;
      const mean = conversionData.count > 0 ? conversionData.sum / conversionData.count : 0;
      const variance = conversionData.count > 1
        ? (conversionData.sumSquares - conversionData.sum * conversionData.sum / conversionData.count) / (conversionData.count - 1)
        : 0;
      
      result.metrics[metric] = {
        conversions: conversionData.users.size,
        conversionRate,
        mean,
        variance,
        standardDeviation: Math.sqrt(variance),
        standardError: Math.sqrt(variance / conversionData.count),
        confidenceInterval: this.calculateConfidenceInterval(
          conversionRate,
          assignmentData.users.size,
          experiment.statisticalConfig.confidenceLevel
        ),
      };
    }
    
    return result;
  }
  
  async analyzeMetric(experiment, metricName, variants) {
    const analysis = {
      metric: metricName,
      variants: {},
      comparison: {},
      significant: false,
      practicallySignificant: false,
    };
    
    // Get control variant data
    const controlData = await this.getVariantMetricData(experiment.id, experiment.control, metricName);
    
    for (const variant of variants) {
      const variantData = await this.getVariantMetricData(experiment.id, variant.id, metricName);
      analysis.variants[variant.id] = variantData;
      
      if (variant.id !== experiment.control) {
        // Compare with control
        const comparison = this.compareVariants(controlData, variantData, experiment.statisticalConfig);
        analysis.comparison[variant.id] = comparison;
        
        if (comparison.significant) {
          analysis.significant = true;
        }
        
        if (Math.abs(comparison.lift) >= experiment.statisticalConfig.mde) {
          analysis.practicallySignificant = true;
        }
      }
    }
    
    return analysis;
  }
  
  async getVariantMetricData(experimentId, variantId, metricName) {
    const assignmentKey = `assignment:${experimentId}:${variantId}`;
    const conversionKey = `conversion:${experimentId}:${variantId}:${metricName}`;
    
    const assignments = this.metrics.get(assignmentKey) || { users: new Set() };
    const conversions = this.metrics.get(conversionKey) || {
      users: new Set(),
      sum: 0,
      count: 0,
    };
    
    return {
      sampleSize: assignments.users.size,
      conversions: conversions.users.size,
      conversionRate: conversions.users.size / assignments.users.size,
      totalValue: conversions.sum,
      averageValue: conversions.count > 0 ? conversions.sum / conversions.count : 0,
    };
  }
  
  compareVariants(control, treatment, config) {
    const n1 = control.sampleSize;
    const n2 = treatment.sampleSize;
    const p1 = control.conversionRate;
    const p2 = treatment.conversionRate;
    
    // Pooled proportion
    const p = (control.conversions + treatment.conversions) / (n1 + n2);
    
    // Standard error
    const se = Math.sqrt(p * (1 - p) * (1/n1 + 1/n2));
    
    // Z-score
    const z = (p2 - p1) / se;
    
    // P-value (two-tailed)
    const pValue = 2 * (1 - jStat.normal.cdf(Math.abs(z), 0, 1));
    
    // Confidence interval for difference
    const zAlpha = jStat.normal.inv(1 - (1 - config.confidenceLevel) / 2, 0, 1);
    const ciLower = (p2 - p1) - zAlpha * se;
    const ciUpper = (p2 - p1) + zAlpha * se;
    
    // Relative lift
    const lift = p1 > 0 ? (p2 - p1) / p1 : 0;
    
    return {
      difference: p2 - p1,
      lift,
      liftPercent: lift * 100,
      standardError: se,
      zScore: z,
      pValue,
      confidenceInterval: [ciLower, ciUpper],
      significant: pValue < (1 - config.confidenceLevel),
    };
  }
  
  calculateConfidenceInterval(proportion, sampleSize, confidenceLevel) {
    const z = jStat.normal.inv(1 - (1 - confidenceLevel) / 2, 0, 1);
    const se = Math.sqrt(proportion * (1 - proportion) / sampleSize);
    
    return [
      Math.max(0, proportion - z * se),
      Math.min(1, proportion + z * se),
    ];
  }
  
  runStatisticalTests(experiment, results) {
    const tests = {};
    
    // Chi-square test for independence
    tests.chiSquare = this.chiSquareTest(experiment, results);
    
    // ANOVA for multiple variants
    if (experiment.variants.length > 2) {
      tests.anova = this.anovaTest(experiment, results);
    }
    
    // Bayesian analysis
    if (this.config.bayesianEnabled) {
      tests.bayesian = this.bayesianAnalysis(experiment, results);
    }
    
    // Sequential testing
    tests.sequential = this.sequentialTest(experiment, results);
    
    return tests;
  }
  
  chiSquareTest(experiment, results) {
    // Implementation of chi-square test
    const observed = [];
    const expected = [];
    
    for (const variant of experiment.variants) {
      const data = results.variants[variant.id];
      observed.push([
        data.metrics[experiment.primaryMetric].conversions,
        data.sampleSize - data.metrics[experiment.primaryMetric].conversions,
      ]);
    }
    
    // Calculate expected frequencies
    const totalSample = observed.reduce((sum, row) => sum + row[0] + row[1], 0);
    const totalConversions = observed.reduce((sum, row) => sum + row[0], 0);
    const overallRate = totalConversions / totalSample;
    
    for (const row of observed) {
      const rowTotal = row[0] + row[1];
      expected.push([
        rowTotal * overallRate,
        rowTotal * (1 - overallRate),
      ]);
    }
    
    // Calculate chi-square statistic
    let chiSquare = 0;
    for (let i = 0; i < observed.length; i++) {
      for (let j = 0; j < observed[i].length; j++) {
        chiSquare += Math.pow(observed[i][j] - expected[i][j], 2) / expected[i][j];
      }
    }
    
    // Degrees of freedom
    const df = (observed.length - 1) * (observed[0].length - 1);
    
    // P-value
    const pValue = 1 - jStat.chisquare.cdf(chiSquare, df);
    
    return {
      chiSquare,
      degreesOfFreedom: df,
      pValue,
      significant: pValue < (1 - experiment.statisticalConfig.confidenceLevel),
    };
  }
  
  anovaTest(experiment, results) {
    // Implementation of ANOVA test
    // This is a simplified version - full implementation would be more complex
    return {
      fStatistic: 0,
      pValue: 1,
      significant: false,
    };
  }
  
  bayesianAnalysis(experiment, results) {
    // Bayesian probability calculations
    const analysis = {
      variants: {},
      probabilities: {},
    };
    
    // Use Beta distributions for conversion rates
    for (const variant of experiment.variants) {
      const data = results.variants[variant.id];
      const conversions = data.metrics[experiment.primaryMetric].conversions;
      const failures = data.sampleSize - conversions;
      
      analysis.variants[variant.id] = {
        alpha: conversions + 1,
        beta: failures + 1,
        mean: (conversions + 1) / (data.sampleSize + 2),
      };
    }
    
    // Calculate probability of each variant being best
    const samples = 10000;
    const wins = {};
    
    for (const variant of experiment.variants) {
      wins[variant.id] = 0;
    }
    
    for (let i = 0; i < samples; i++) {
      const draws = {};
      let maxDraw = -Infinity;
      let winner = null;
      
      for (const variant of experiment.variants) {
        const params = analysis.variants[variant.id];
        draws[variant.id] = jStat.beta.sample(params.alpha, params.beta);
        
        if (draws[variant.id] > maxDraw) {
          maxDraw = draws[variant.id];
          winner = variant.id;
        }
      }
      
      wins[winner]++;
    }
    
    for (const variant of experiment.variants) {
      analysis.probabilities[variant.id] = wins[variant.id] / samples;
    }
    
    return analysis;
  }
  
  sequentialTest(experiment, results) {
    // Sequential probability ratio test (SPRT)
    // This allows for early stopping when significance is reached
    return {
      canStop: false,
      reason: null,
    };
  }
  
  determineWinner(experiment, results) {
    const primaryMetricAnalysis = results.primaryMetric;
    
    // Check if any variant significantly outperforms control
    let winner = null;
    let maxLift = 0;
    
    for (const [variantId, comparison] of Object.entries(primaryMetricAnalysis.comparison)) {
      if (comparison.significant && comparison.lift > maxLift) {
        winner = variantId;
        maxLift = comparison.lift;
      }
    }
    
    // Check guardrail metrics
    if (winner) {
      for (const metric of experiment.guardrailMetrics) {
        const guardrailAnalysis = results.guardrailMetrics[metric];
        if (guardrailAnalysis.comparison[winner]?.significant &&
            guardrailAnalysis.comparison[winner]?.lift < 0) {
          // Winner violates guardrail metric
          winner = null;
          break;
        }
      }
    }
    
    return winner;
  }
  
  generateRecommendations(experiment, results) {
    const recommendations = [];
    
    // Check sample size
    for (const variant of experiment.variants) {
      if (results.variants[variant.id].sampleSize < experiment.requiredSampleSize) {
        recommendations.push({
          type: 'warning',
          message: `Variant ${variant.id} has not reached minimum sample size (${results.variants[variant.id].sampleSize}/${experiment.requiredSampleSize})`,
        });
      }
    }
    
    // Check for winner
    if (results.winner) {
      recommendations.push({
        type: 'success',
        message: `Variant ${results.winner} is the winner with ${results.primaryMetric.comparison[results.winner].liftPercent.toFixed(2)}% lift`,
      });
    } else if (results.primaryMetric.significant) {
      recommendations.push({
        type: 'info',
        message: 'Statistical significance reached but no clear winner due to guardrail metrics',
      });
    } else {
      recommendations.push({
        type: 'info',
        message: 'No statistical significance reached yet. Continue running the experiment.',
      });
    }
    
    // Check for practical significance
    for (const [variantId, comparison] of Object.entries(results.primaryMetric.comparison)) {
      if (comparison.significant && Math.abs(comparison.lift) < experiment.statisticalConfig.mde) {
        recommendations.push({
          type: 'warning',
          message: `Variant ${variantId} is statistically significant but not practically significant (lift: ${comparison.liftPercent.toFixed(2)}%)`,
        });
      }
    }
    
    return recommendations;
  }
  
  // Check for statistical significance
  async checkStatisticalSignificance(experimentId) {
    const results = await this.analyzeExperiment(experimentId);
    const experiment = this.experiments.get(experimentId);
    
    if (results.winner && experiment.status === 'running') {
      // Auto-stop if winner found and sufficient sample size
      let canStop = true;
      for (const variant of experiment.variants) {
        if (results.variants[variant.id].sampleSize < experiment.requiredSampleSize) {
          canStop = false;
          break;
        }
      }
      
      if (canStop) {
        await this.stopExperiment(experimentId, 'Statistical significance reached');
      }
    }
  }
  
  // Persistence
  async persistExperiment(experiment) {
    if (this.config.storage.type === 'redis') {
      const redis = require('redis').createClient(this.config.storage.redis);
      await redis.connect();
      await redis.set(`experiment:${experiment.id}`, JSON.stringify(experiment));
      await redis.quit();
    }
  }
  
  async loadExperiments() {
    if (this.config.storage.type === 'redis') {
      const redis = require('redis').createClient(this.config.storage.redis);
      await redis.connect();
      
      const keys = await redis.keys('experiment:*');
      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          const experiment = JSON.parse(data);
          this.experiments.set(experiment.id, experiment);
        }
      }
      
      await redis.quit();
    }
  }
  
  async storeConversionEvent(event) {
    if (this.config.storage.type === 'redis') {
      const redis = require('redis').createClient(this.config.storage.redis);
      await redis.connect();
      
      const key = `conversion:${event.experimentId}:${event.userId}:${event.timestamp.getTime()}`;
      await redis.set(key, JSON.stringify(event), { EX: 86400 * 30 }); // 30 days TTL
      
      await redis.quit();
    }
  }
  
  // Start metrics collection
  startMetricsCollection() {
    setInterval(() => {
      this.emit('metrics:snapshot', this.getMetricsSnapshot());
    }, 60000); // Every minute
  }
  
  getMetricsSnapshot() {
    const snapshot = {
      experiments: {},
      timestamp: new Date(),
    };
    
    for (const [id, experiment] of this.experiments) {
      if (experiment.status === 'running') {
        snapshot.experiments[id] = {
          assignments: {},
          conversions: {},
        };
        
        for (const variant of experiment.variants) {
          const assignmentKey = `assignment:${id}:${variant.id}`;
          const assignmentData = this.metrics.get(assignmentKey);
          
          snapshot.experiments[id].assignments[variant.id] = assignmentData?.users.size || 0;
          
          const conversionKey = `conversion:${id}:${variant.id}:${experiment.primaryMetric}`;
          const conversionData = this.metrics.get(conversionKey);
          
          snapshot.experiments[id].conversions[variant.id] = conversionData?.users.size || 0;
        }
      }
    }
    
    return snapshot;
  }
  
  // Helper methods
  generateExperimentId() {
    return `exp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
  
  // Express middleware
  middleware() {
    return (req, res, next) => {
      req.abTesting = {
        getVariant: (experimentId) => {
          const userId = req.user?.id || req.sessionID || req.ip;
          const context = {
            userId,
            email: req.user?.email,
            organizationId: req.organization?.id,
            userAgent: req.get('user-agent'),
            ip: req.ip,
            ...req.abTestingContext,
          };
          
          return this.getVariant(experimentId, userId, context);
        },
        trackConversion: (experimentId, metricName, value = 1) => {
          const userId = req.user?.id || req.sessionID || req.ip;
          return this.trackConversion(experimentId, userId, metricName, value);
        },
      };
      
      next();
    };
  }
  
  // Get experiment results
  getExperimentResults(experimentId) {
    const experiment = this.experiments.get(experimentId);
    return experiment?.results || null;
  }
  
  // Get all active experiments
  getActiveExperiments() {
    return Array.from(this.experiments.values()).filter(e => e.status === 'running');
  }
  
  // Cleanup
  cleanup() {
    // Clean up any resources
    this.experiments.clear();
    this.assignments.clear();
    this.metrics.clear();
  }
}

module.exports = ABTestingFramework;