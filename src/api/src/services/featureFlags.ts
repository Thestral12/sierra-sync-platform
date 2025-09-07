import { Redis } from 'ioredis'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'
import { EventEmitter } from 'events'
import crypto from 'crypto'

interface FeatureFlag {
  id: string
  name: string
  description?: string
  enabled: boolean
  rolloutPercentage?: number
  targetingRules?: TargetingRule[]
  variants?: Variant[]
  metadata?: Record<string, any>
  createdAt: Date
  updatedAt: Date
}

interface TargetingRule {
  attribute: string
  operator: 'equals' | 'contains' | 'in' | 'greater_than' | 'less_than' | 'regex'
  value: any
  enabled: boolean
}

interface Variant {
  key: string
  name: string
  weight: number
  payload?: any
}

interface EvaluationContext {
  userId?: string
  organizationId?: string
  email?: string
  role?: string
  plan?: string
  country?: string
  attributes?: Record<string, any>
}

interface EvaluationResult {
  enabled: boolean
  variant?: string
  reason: string
  metadata?: any
}

export class FeatureFlagsService extends EventEmitter {
  private redis: Redis
  private supabase: any
  private cache: Map<string, FeatureFlag> = new Map()
  private cacheExpiry: number = 60000 // 1 minute
  private lastSync: number = 0
  private syncInterval: NodeJS.Timeout | null = null
  
  constructor(
    private config: {
      redis: Redis
      supabaseUrl: string
      supabaseKey: string
      syncIntervalMs?: number
      enableAnalytics?: boolean
    }
  ) {
    super()
    
    this.redis = config.redis
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)
    
    // Start sync interval
    if (config.syncIntervalMs) {
      this.startSync(config.syncIntervalMs)
    }
    
    // Load flags on initialization
    this.loadFlags().catch(err => {
      logger.error('Failed to load feature flags:', err)
    })
  }
  
  /**
   * Start periodic sync with database
   */
  private startSync(intervalMs: number): void {
    this.syncInterval = setInterval(async () => {
      try {
        await this.loadFlags()
      } catch (error) {
        logger.error('Feature flag sync failed:', error)
      }
    }, intervalMs)
  }
  
  /**
   * Stop periodic sync
   */
  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
    }
  }
  
  /**
   * Load flags from database
   */
  async loadFlags(): Promise<void> {
    try {
      const { data: flags, error } = await this.supabase
        .from('feature_flags')
        .select('*')
        .eq('active', true)
      
      if (error) throw error
      
      // Update cache
      this.cache.clear()
      for (const flag of flags) {
        this.cache.set(flag.name, {
          ...flag,
          targetingRules: flag.targeting_rules || [],
          variants: flag.variants || [],
          rolloutPercentage: flag.rollout_percentage,
          createdAt: new Date(flag.created_at),
          updatedAt: new Date(flag.updated_at)
        })
        
        // Store in Redis for distributed cache
        await this.redis.setex(
          `feature_flag:${flag.name}`,
          this.cacheExpiry / 1000,
          JSON.stringify(flag)
        )
      }
      
      this.lastSync = Date.now()
      this.emit('flags_updated', flags.length)
      
      logger.info(`Loaded ${flags.length} feature flags`)
    } catch (error) {
      logger.error('Failed to load feature flags from database:', error)
      throw error
    }
  }
  
  /**
   * Get a feature flag
   */
  async getFlag(name: string): Promise<FeatureFlag | null> {
    // Check memory cache first
    if (this.cache.has(name)) {
      return this.cache.get(name)!
    }
    
    // Check Redis cache
    const cached = await this.redis.get(`feature_flag:${name}`)
    if (cached) {
      const flag = JSON.parse(cached)
      this.cache.set(name, flag)
      return flag
    }
    
    // Load from database
    const { data: flag, error } = await this.supabase
      .from('feature_flags')
      .select('*')
      .eq('name', name)
      .eq('active', true)
      .single()
    
    if (error || !flag) {
      return null
    }
    
    const processedFlag: FeatureFlag = {
      ...flag,
      targetingRules: flag.targeting_rules || [],
      variants: flag.variants || [],
      rolloutPercentage: flag.rollout_percentage,
      createdAt: new Date(flag.created_at),
      updatedAt: new Date(flag.updated_at)
    }
    
    // Update caches
    this.cache.set(name, processedFlag)
    await this.redis.setex(
      `feature_flag:${name}`,
      this.cacheExpiry / 1000,
      JSON.stringify(processedFlag)
    )
    
    return processedFlag
  }
  
  /**
   * Evaluate a feature flag
   */
  async evaluate(
    flagName: string,
    context: EvaluationContext
  ): Promise<EvaluationResult> {
    const startTime = Date.now()
    
    try {
      const flag = await this.getFlag(flagName)
      
      if (!flag) {
        return {
          enabled: false,
          reason: 'Flag not found'
        }
      }
      
      // Check if flag is globally disabled
      if (!flag.enabled) {
        return {
          enabled: false,
          reason: 'Flag disabled'
        }
      }
      
      // Evaluate targeting rules
      if (flag.targetingRules && flag.targetingRules.length > 0) {
        const targetingResult = this.evaluateTargeting(flag.targetingRules, context)
        if (targetingResult !== null) {
          return {
            enabled: targetingResult,
            reason: targetingResult ? 'Targeting rule matched' : 'Targeting rule excluded'
          }
        }
      }
      
      // Check rollout percentage
      if (flag.rolloutPercentage !== undefined && flag.rolloutPercentage < 100) {
        const bucket = this.getBucket(flagName, context)
        const enabled = bucket < flag.rolloutPercentage
        
        return {
          enabled,
          reason: enabled ? 'In rollout percentage' : 'Outside rollout percentage'
        }
      }
      
      // Check variants
      if (flag.variants && flag.variants.length > 0) {
        const variant = this.selectVariant(flag.variants, flagName, context)
        return {
          enabled: true,
          variant: variant.key,
          reason: 'Variant selected',
          metadata: variant.payload
        }
      }
      
      // Flag is enabled for everyone
      return {
        enabled: true,
        reason: 'Flag enabled for all'
      }
    } finally {
      // Track evaluation metrics
      if (this.config.enableAnalytics) {
        this.trackEvaluation(flagName, context, Date.now() - startTime)
      }
    }
  }
  
  /**
   * Evaluate targeting rules
   */
  private evaluateTargeting(
    rules: TargetingRule[],
    context: EvaluationContext
  ): boolean | null {
    for (const rule of rules) {
      if (!rule.enabled) continue
      
      const value = this.getAttributeValue(rule.attribute, context)
      if (value === undefined) continue
      
      const matches = this.evaluateRule(rule, value)
      
      if (matches) {
        return true // Include if any rule matches
      }
    }
    
    return null // No rules matched
  }
  
  /**
   * Get attribute value from context
   */
  private getAttributeValue(
    attribute: string,
    context: EvaluationContext
  ): any {
    // Check standard attributes
    if (attribute in context) {
      return (context as any)[attribute]
    }
    
    // Check custom attributes
    if (context.attributes && attribute in context.attributes) {
      return context.attributes[attribute]
    }
    
    return undefined
  }
  
  /**
   * Evaluate a single rule
   */
  private evaluateRule(rule: TargetingRule, value: any): boolean {
    switch (rule.operator) {
      case 'equals':
        return value === rule.value
      
      case 'contains':
        return String(value).includes(String(rule.value))
      
      case 'in':
        return Array.isArray(rule.value) && rule.value.includes(value)
      
      case 'greater_than':
        return Number(value) > Number(rule.value)
      
      case 'less_than':
        return Number(value) < Number(rule.value)
      
      case 'regex':
        return new RegExp(rule.value).test(String(value))
      
      default:
        return false
    }
  }
  
  /**
   * Get bucket for percentage rollout
   */
  private getBucket(flagName: string, context: EvaluationContext): number {
    const identifier = context.userId || context.organizationId || 'anonymous'
    const hash = crypto
      .createHash('md5')
      .update(`${flagName}:${identifier}`)
      .digest('hex')
    
    // Convert first 8 hex chars to number and normalize to 0-100
    return (parseInt(hash.substring(0, 8), 16) / 0xffffffff) * 100
  }
  
  /**
   * Select variant based on weights
   */
  private selectVariant(
    variants: Variant[],
    flagName: string,
    context: EvaluationContext
  ): Variant {
    const bucket = this.getBucket(`${flagName}:variant`, context)
    
    let cumulativeWeight = 0
    const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0)
    const normalizedBucket = bucket * (totalWeight / 100)
    
    for (const variant of variants) {
      cumulativeWeight += variant.weight
      if (normalizedBucket < cumulativeWeight) {
        return variant
      }
    }
    
    return variants[variants.length - 1] // Fallback to last variant
  }
  
  /**
   * Track flag evaluation for analytics
   */
  private async trackEvaluation(
    flagName: string,
    context: EvaluationContext,
    duration: number
  ): Promise<void> {
    try {
      // Store in Redis for aggregation
      const key = `flag_evaluation:${flagName}:${new Date().toISOString().slice(0, 10)}`
      await this.redis.hincrby(key, 'total', 1)
      
      if (context.userId) {
        await this.redis.pfadd(`flag_users:${flagName}`, context.userId)
      }
      
      // Store detailed event for analysis
      const event = {
        flag: flagName,
        context,
        duration,
        timestamp: new Date().toISOString()
      }
      
      await this.redis.lpush('flag_evaluation_events', JSON.stringify(event))
      await this.redis.ltrim('flag_evaluation_events', 0, 9999) // Keep last 10k events
      
      // Set expiry for cleanup
      await this.redis.expire(key, 86400 * 30) // 30 days
    } catch (error) {
      logger.error('Failed to track flag evaluation:', error)
    }
  }
  
  /**
   * Create or update a feature flag
   */
  async upsertFlag(flag: Partial<FeatureFlag> & { name: string }): Promise<FeatureFlag> {
    const { data, error } = await this.supabase
      .from('feature_flags')
      .upsert({
        name: flag.name,
        description: flag.description,
        enabled: flag.enabled ?? false,
        rollout_percentage: flag.rolloutPercentage,
        targeting_rules: flag.targetingRules,
        variants: flag.variants,
        metadata: flag.metadata,
        active: true
      })
      .select()
      .single()
    
    if (error) throw error
    
    // Clear caches
    this.cache.delete(flag.name)
    await this.redis.del(`feature_flag:${flag.name}`)
    
    // Reload flags
    await this.loadFlags()
    
    return data
  }
  
  /**
   * Delete a feature flag
   */
  async deleteFlag(name: string): Promise<void> {
    const { error } = await this.supabase
      .from('feature_flags')
      .update({ active: false })
      .eq('name', name)
    
    if (error) throw error
    
    // Clear caches
    this.cache.delete(name)
    await this.redis.del(`feature_flag:${name}`)
  }
  
  /**
   * Get all flags
   */
  getAllFlags(): FeatureFlag[] {
    return Array.from(this.cache.values())
  }
  
  /**
   * Get flag analytics
   */
  async getAnalytics(flagName: string, days: number = 7): Promise<any> {
    const analytics: any = {
      flag: flagName,
      period: `${days} days`,
      evaluations: {},
      uniqueUsers: 0
    }
    
    // Get evaluation counts for each day
    for (let i = 0; i < days; i++) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().slice(0, 10)
      
      const key = `flag_evaluation:${flagName}:${dateStr}`
      const count = await this.redis.hget(key, 'total')
      
      analytics.evaluations[dateStr] = parseInt(count || '0')
    }
    
    // Get unique users
    analytics.uniqueUsers = await this.redis.pfcount(`flag_users:${flagName}`)
    
    return analytics
  }
  
  /**
   * Bulk evaluate multiple flags
   */
  async evaluateMultiple(
    flagNames: string[],
    context: EvaluationContext
  ): Promise<Record<string, EvaluationResult>> {
    const results: Record<string, EvaluationResult> = {}
    
    await Promise.all(
      flagNames.map(async (flagName) => {
        results[flagName] = await this.evaluate(flagName, context)
      })
    )
    
    return results
  }
}

/**
 * Express middleware for feature flags
 */
export function featureFlagMiddleware(
  flagsService: FeatureFlagsService
) {
  return async (req: any, res: any, next: any) => {
    // Create evaluation context from request
    const context: EvaluationContext = {
      userId: req.user?.id,
      organizationId: req.user?.organizationId,
      email: req.user?.email,
      role: req.user?.role,
      plan: req.user?.plan,
      country: req.headers['cf-ipcountry'] || req.headers['x-country'],
      attributes: {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        ...req.query
      }
    }
    
    // Add feature flag evaluation function to request
    req.featureFlag = async (flagName: string) => {
      const result = await flagsService.evaluate(flagName, context)
      return result.enabled
    }
    
    req.featureFlagWithVariant = async (flagName: string) => {
      return flagsService.evaluate(flagName, context)
    }
    
    req.featureFlags = async (flagNames: string[]) => {
      return flagsService.evaluateMultiple(flagNames, context)
    }
    
    next()
  }
}

/**
 * React hook for feature flags (to be used in frontend)
 */
export const useFeatureFlag = `
import { useState, useEffect } from 'react'

export function useFeatureFlag(flagName: string) {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [variant, setVariant] = useState(null)
  
  useEffect(() => {
    async function checkFlag() {
      try {
        const response = await fetch(\`/api/features/\${flagName}\`, {
          credentials: 'include'
        })
        const data = await response.json()
        setEnabled(data.enabled)
        setVariant(data.variant)
      } catch (error) {
        console.error('Failed to check feature flag:', error)
        setEnabled(false)
      } finally {
        setLoading(false)
      }
    }
    
    checkFlag()
  }, [flagName])
  
  return { enabled, loading, variant }
}
`