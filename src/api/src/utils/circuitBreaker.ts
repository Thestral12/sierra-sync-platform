import { EventEmitter } from 'events'
import { logger } from './logger'
import { captureError } from './monitoring'

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface CircuitBreakerOptions {
  timeout?: number // Request timeout in ms
  errorThreshold?: number // Number of errors before opening
  errorThresholdPercentage?: number // Percentage of errors before opening
  resetTimeout?: number // Time before trying half-open
  monitoringPeriod?: number // Time window for monitoring
  minimumRequests?: number // Minimum requests before evaluating
  halfOpenMaxAttempts?: number // Max attempts in half-open state
  fallbackFunction?: () => Promise<any> // Fallback when circuit is open
  volumeThreshold?: number // Request volume threshold
  sleepWindow?: number // How long to wait before retry
  isError?: (error: any) => boolean // Custom error evaluation
}

interface CircuitStats {
  totalRequests: number
  successCount: number
  failureCount: number
  timeoutCount: number
  lastFailureTime?: Date
  lastSuccessTime?: Date
  consecutiveFailures: number
  consecutiveSuccesses: number
  averageResponseTime: number
  percentile95: number
  percentile99: number
}

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED
  private options: Required<CircuitBreakerOptions>
  private stats: CircuitStats
  private halfOpenAttempts: number = 0
  private nextAttempt: number = Date.now()
  private requestLog: { timestamp: number; duration: number; success: boolean }[] = []
  private stateChangeCallbacks: ((state: CircuitState) => void)[] = []
  
  constructor(
    private name: string,
    options: CircuitBreakerOptions = {}
  ) {
    super()
    
    this.options = {
      timeout: options.timeout ?? 10000,
      errorThreshold: options.errorThreshold ?? 5,
      errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
      resetTimeout: options.resetTimeout ?? 60000,
      monitoringPeriod: options.monitoringPeriod ?? 60000,
      minimumRequests: options.minimumRequests ?? 20,
      halfOpenMaxAttempts: options.halfOpenMaxAttempts ?? 3,
      fallbackFunction: options.fallbackFunction ?? null,
      volumeThreshold: options.volumeThreshold ?? 20,
      sleepWindow: options.sleepWindow ?? 5000,
      isError: options.isError ?? ((error) => true)
    }
    
    this.stats = this.resetStats()
    
    // Clean up old request logs periodically
    setInterval(() => this.cleanupRequestLog(), this.options.monitoringPeriod)
  }
  
  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should be opened based on stats
    this.evaluateCircuit()
    
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        return this.handleOpen()
      }
      // Try to half-open
      this.halfOpen()
    }
    
    if (this.state === CircuitState.HALF_OPEN && this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
      this.open()
      return this.handleOpen()
    }
    
    const startTime = Date.now()
    
    try {
      // Set timeout for the request
      const result = await this.executeWithTimeout(fn)
      this.onSuccess(Date.now() - startTime)
      return result
    } catch (error) {
      this.onFailure(Date.now() - startTime, error)
      throw error
    }
  }
  
  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Circuit breaker timeout after ${this.options.timeout}ms`))
        }, this.options.timeout)
      })
    ])
  }
  
  /**
   * Handle successful execution
   */
  private onSuccess(duration: number): void {
    this.stats.totalRequests++
    this.stats.successCount++
    this.stats.consecutiveSuccesses++
    this.stats.consecutiveFailures = 0
    this.stats.lastSuccessTime = new Date()
    
    this.recordRequest(duration, true)
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts++
      if (this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
        this.close()
      }
    }
    
    this.updateMetrics(duration)
    this.emit('success', { duration, state: this.state })
  }
  
  /**
   * Handle failed execution
   */
  private onFailure(duration: number, error: any): void {
    const isTimeout = error.message?.includes('timeout')
    const isError = this.options.isError(error)
    
    if (!isError) {
      // Not considered an error for circuit breaker
      this.onSuccess(duration)
      return
    }
    
    this.stats.totalRequests++
    this.stats.failureCount++
    this.stats.consecutiveFailures++
    this.stats.consecutiveSuccesses = 0
    this.stats.lastFailureTime = new Date()
    
    if (isTimeout) {
      this.stats.timeoutCount++
    }
    
    this.recordRequest(duration, false)
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.open()
    } else if (this.state === CircuitState.CLOSED) {
      this.evaluateCircuit()
    }
    
    this.updateMetrics(duration)
    this.emit('failure', { duration, error, state: this.state })
    
    // Log to monitoring
    captureError(error, {
      tags: {
        circuit_breaker: this.name,
        circuit_state: this.state
      },
      extra: {
        stats: this.stats
      }
    })
  }
  
  /**
   * Evaluate if circuit should be opened
   */
  private evaluateCircuit(): void {
    const recentRequests = this.getRecentRequests()
    
    if (recentRequests.length < this.options.minimumRequests) {
      return // Not enough data
    }
    
    const failures = recentRequests.filter(r => !r.success).length
    const failureRate = (failures / recentRequests.length) * 100
    
    if (
      this.stats.consecutiveFailures >= this.options.errorThreshold ||
      failureRate >= this.options.errorThresholdPercentage
    ) {
      this.open()
    }
  }
  
  /**
   * Open the circuit
   */
  private open(): void {
    if (this.state === CircuitState.OPEN) return
    
    this.state = CircuitState.OPEN
    this.nextAttempt = Date.now() + this.options.resetTimeout
    this.halfOpenAttempts = 0
    
    logger.warn(`Circuit breaker OPENED: ${this.name}`, {
      stats: this.stats,
      nextAttempt: new Date(this.nextAttempt)
    })
    
    this.emit('open', this.stats)
    this.notifyStateChange(CircuitState.OPEN)
  }
  
  /**
   * Half-open the circuit
   */
  private halfOpen(): void {
    if (this.state === CircuitState.HALF_OPEN) return
    
    this.state = CircuitState.HALF_OPEN
    this.halfOpenAttempts = 0
    
    logger.info(`Circuit breaker HALF-OPEN: ${this.name}`)
    
    this.emit('half-open', this.stats)
    this.notifyStateChange(CircuitState.HALF_OPEN)
  }
  
  /**
   * Close the circuit
   */
  private close(): void {
    if (this.state === CircuitState.CLOSED) return
    
    this.state = CircuitState.CLOSED
    this.stats = this.resetStats()
    this.halfOpenAttempts = 0
    
    logger.info(`Circuit breaker CLOSED: ${this.name}`)
    
    this.emit('close', this.stats)
    this.notifyStateChange(CircuitState.CLOSED)
  }
  
  /**
   * Handle open circuit
   */
  private async handleOpen(): Promise<any> {
    this.emit('reject', this.stats)
    
    if (this.options.fallbackFunction) {
      logger.info(`Circuit breaker using fallback: ${this.name}`)
      return this.options.fallbackFunction()
    }
    
    throw new Error(`Circuit breaker is OPEN: ${this.name}`)
  }
  
  /**
   * Record request for monitoring
   */
  private recordRequest(duration: number, success: boolean): void {
    this.requestLog.push({
      timestamp: Date.now(),
      duration,
      success
    })
  }
  
  /**
   * Get recent requests within monitoring period
   */
  private getRecentRequests(): typeof this.requestLog {
    const cutoff = Date.now() - this.options.monitoringPeriod
    return this.requestLog.filter(r => r.timestamp > cutoff)
  }
  
  /**
   * Clean up old request logs
   */
  private cleanupRequestLog(): void {
    const cutoff = Date.now() - this.options.monitoringPeriod * 2
    this.requestLog = this.requestLog.filter(r => r.timestamp > cutoff)
  }
  
  /**
   * Update performance metrics
   */
  private updateMetrics(duration: number): void {
    const recentRequests = this.getRecentRequests()
    if (recentRequests.length === 0) return
    
    const durations = recentRequests.map(r => r.duration).sort((a, b) => a - b)
    
    this.stats.averageResponseTime = 
      durations.reduce((sum, d) => sum + d, 0) / durations.length
    
    this.stats.percentile95 = durations[Math.floor(durations.length * 0.95)] || 0
    this.stats.percentile99 = durations[Math.floor(durations.length * 0.99)] || 0
  }
  
  /**
   * Reset statistics
   */
  private resetStats(): CircuitStats {
    return {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      averageResponseTime: 0,
      percentile95: 0,
      percentile99: 0
    }
  }
  
  /**
   * Notify state change callbacks
   */
  private notifyStateChange(state: CircuitState): void {
    this.stateChangeCallbacks.forEach(callback => callback(state))
  }
  
  /**
   * Register state change callback
   */
  onStateChange(callback: (state: CircuitState) => void): void {
    this.stateChangeCallbacks.push(callback)
  }
  
  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state
  }
  
  /**
   * Get current stats
   */
  getStats(): CircuitStats {
    return { ...this.stats }
  }
  
  /**
   * Force reset circuit
   */
  reset(): void {
    this.close()
  }
  
  /**
   * Force open circuit
   */
  forceOpen(): void {
    this.open()
  }
}

/**
 * Circuit breaker factory for managing multiple breakers
 */
export class CircuitBreakerFactory {
  private static breakers: Map<string, CircuitBreaker> = new Map()
  
  /**
   * Get or create a circuit breaker
   */
  static getBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker(name, options)
      this.breakers.set(name, breaker)
      
      // Log state changes
      breaker.on('open', (stats) => {
        logger.error(`Circuit breaker opened: ${name}`, stats)
      })
      
      breaker.on('half-open', (stats) => {
        logger.warn(`Circuit breaker half-open: ${name}`, stats)
      })
      
      breaker.on('close', (stats) => {
        logger.info(`Circuit breaker closed: ${name}`, stats)
      })
    }
    
    return this.breakers.get(name)!
  }
  
  /**
   * Get all circuit breakers
   */
  static getAllBreakers(): Map<string, CircuitBreaker> {
    return new Map(this.breakers)
  }
  
  /**
   * Get circuit breaker stats
   */
  static getStats(): Record<string, any> {
    const stats: Record<string, any> = {}
    
    this.breakers.forEach((breaker, name) => {
      stats[name] = {
        state: breaker.getState(),
        stats: breaker.getStats()
      }
    })
    
    return stats
  }
  
  /**
   * Reset all circuit breakers
   */
  static resetAll(): void {
    this.breakers.forEach(breaker => breaker.reset())
  }
  
  /**
   * Remove a circuit breaker
   */
  static removeBreaker(name: string): void {
    this.breakers.delete(name)
  }
}

/**
 * Decorator for adding circuit breaker to methods
 */
export function WithCircuitBreaker(name: string, options?: CircuitBreakerOptions) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    
    descriptor.value = async function (...args: any[]) {
      const breaker = CircuitBreakerFactory.getBreaker(name, options)
      return breaker.execute(() => originalMethod.apply(this, args))
    }
    
    return descriptor
  }
}