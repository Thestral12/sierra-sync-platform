import { createClient } from '@supabase/supabase-js'
import { Redis } from 'ioredis'
import { logger } from '../utils/logger'
import { EventEmitter } from 'events'

interface MetricValue {
  timestamp: Date
  value: number
  metadata?: Record<string, any>
}

interface TimeSeriesData {
  metric: string
  dataPoints: MetricValue[]
  aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max'
  timeRange: {
    start: Date
    end: Date
    granularity: 'minute' | 'hour' | 'day' | 'week' | 'month'
  }
}

interface Dashboard {
  id: string
  organizationId: string
  name: string
  description?: string
  widgets: Widget[]
  filters: DashboardFilter[]
  refreshInterval: number // seconds
  isPublic: boolean
  createdAt: Date
  updatedAt: Date
}

interface Widget {
  id: string
  type: 'line_chart' | 'bar_chart' | 'pie_chart' | 'metric_card' | 'table' | 'heatmap'
  title: string
  position: { x: number; y: number; width: number; height: number }
  config: WidgetConfig
  dataSource: DataSource
}

interface WidgetConfig {
  metrics: string[]
  dimensions?: string[]
  filters?: Record<string, any>
  aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max'
  timeRange?: {
    type: 'relative' | 'absolute'
    value: string // e.g., 'last_7_days', '2024-01-01_2024-01-31'
  }
  visualization?: {
    colorScheme?: string
    showLegend?: boolean
    showGrid?: boolean
    yAxisLabel?: string
    xAxisLabel?: string
  }
}

interface DataSource {
  type: 'postgres' | 'redis' | 'api'
  query: string
  parameters?: Record<string, any>
  cacheTtl?: number // seconds
}

interface DashboardFilter {
  id: string
  name: string
  type: 'date_range' | 'select' | 'multiselect' | 'text'
  options?: string[]
  defaultValue?: any
}

interface AnalyticsEvent {
  organizationId: string
  userId?: string
  eventType: string
  eventName: string
  properties: Record<string, any>
  timestamp: Date
  sessionId?: string
  deviceInfo?: {
    userAgent?: string
    ip?: string
    country?: string
  }
}

interface Funnel {
  id: string
  name: string
  steps: FunnelStep[]
  conversionWindow: number // hours
}

interface FunnelStep {
  name: string
  eventName: string
  filters?: Record<string, any>
}

interface Cohort {
  period: string // YYYY-MM or YYYY-MM-DD
  users: number
  retention: Record<string, number> // period -> retention rate
}

interface AnalyticsConfig {
  redis: Redis
  supabaseUrl: string
  supabaseKey: string
  clickhouseUrl?: string
  clickhouseToken?: string
  enableRealTime: boolean
  retentionDays: number
  aggregationIntervals: string[]
}

export class AnalyticsService extends EventEmitter {
  private redis: Redis
  private supabase: any
  private config: AnalyticsConfig

  constructor(config: AnalyticsConfig) {
    super()
    
    this.config = config
    this.redis = config.redis
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)

    // Start background aggregation if enabled
    if (config.enableRealTime) {
      this.startBackgroundAggregation()
    }
  }

  /**
   * Track analytics event
   */
  async trackEvent(event: AnalyticsEvent): Promise<void> {
    try {
      // Store raw event
      const { error } = await this.supabase
        .from('analytics_events')
        .insert({
          organization_id: event.organizationId,
          user_id: event.userId,
          event_type: event.eventType,
          event_name: event.eventName,
          properties: event.properties,
          timestamp: event.timestamp.toISOString(),
          session_id: event.sessionId,
          device_info: event.deviceInfo
        })

      if (error) throw error

      // Update real-time aggregations
      await this.updateRealTimeAggregations(event)

      this.emit('event_tracked', event)

      logger.debug('Analytics event tracked', {
        organizationId: event.organizationId,
        eventType: event.eventType,
        eventName: event.eventName
      })

    } catch (error) {
      logger.error('Failed to track analytics event', error)
      throw error
    }
  }

  /**
   * Get time series data
   */
  async getTimeSeriesData(
    organizationId: string,
    metric: string,
    timeRange: {
      start: Date
      end: Date
      granularity: 'minute' | 'hour' | 'day' | 'week' | 'month'
    },
    filters?: Record<string, any>
  ): Promise<TimeSeriesData> {
    try {
      // Generate time buckets
      const buckets = this.generateTimeBuckets(timeRange.start, timeRange.end, timeRange.granularity)
      
      // Build query based on metric
      let query = this.buildMetricQuery(metric, organizationId, timeRange, filters)
      
      const { data, error } = await this.supabase.rpc(query.function, query.parameters)
      
      if (error) throw error

      // Fill missing data points
      const dataPoints = this.fillMissingDataPoints(buckets, data || [])

      return {
        metric,
        dataPoints,
        aggregation: this.getMetricAggregation(metric),
        timeRange
      }

    } catch (error) {
      logger.error('Failed to get time series data', error)
      throw error
    }
  }

  /**
   * Get business metrics
   */
  async getBusinessMetrics(
    organizationId: string,
    dateRange: { start: Date; end: Date }
  ): Promise<{
    overview: any
    growth: any
    engagement: any
    conversion: any
  }> {
    const [overview, growth, engagement, conversion] = await Promise.all([
      this.getOverviewMetrics(organizationId, dateRange),
      this.getGrowthMetrics(organizationId, dateRange),
      this.getEngagementMetrics(organizationId, dateRange),
      this.getConversionMetrics(organizationId, dateRange)
    ])

    return { overview, growth, engagement, conversion }
  }

  /**
   * Get overview metrics
   */
  private async getOverviewMetrics(
    organizationId: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any> {
    // Total users
    const { count: totalUsers } = await this.supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)

    // Active users (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const { count: activeUsers } = await this.supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .gte('last_login', thirtyDaysAgo.toISOString())

    // Total leads
    const { count: totalLeads } = await this.supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .gte('created_at', dateRange.start.toISOString())
      .lte('created_at', dateRange.end.toISOString())

    // Successful syncs
    const { count: successfulSyncs } = await this.supabase
      .from('sync_logs')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'success')
      .gte('created_at', dateRange.start.toISOString())
      .lte('created_at', dateRange.end.toISOString())

    // Failed syncs
    const { count: failedSyncs } = await this.supabase
      .from('sync_logs')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'failed')
      .gte('created_at', dateRange.start.toISOString())
      .lte('created_at', dateRange.end.toISOString())

    const totalSyncs = successfulSyncs + failedSyncs
    const syncSuccessRate = totalSyncs > 0 ? (successfulSyncs / totalSyncs) * 100 : 0

    return {
      totalUsers,
      activeUsers,
      totalLeads,
      totalSyncs,
      successfulSyncs,
      failedSyncs,
      syncSuccessRate: Math.round(syncSuccessRate * 100) / 100
    }
  }

  /**
   * Get growth metrics
   */
  private async getGrowthMetrics(
    organizationId: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any> {
    // Get daily user signups
    const { data: signups } = await this.supabase
      .from('users')
      .select('created_at')
      .eq('organization_id', organizationId)
      .gte('created_at', dateRange.start.toISOString())
      .lte('created_at', dateRange.end.toISOString())
      .order('created_at')

    // Get daily lead creation
    const { data: leadCreation } = await this.supabase
      .from('leads')
      .select('created_at')
      .eq('organization_id', organizationId)
      .gte('created_at', dateRange.start.toISOString())
      .lte('created_at', dateRange.end.toISOString())
      .order('created_at')

    // Group by day
    const signupsByDay = this.groupByDay(signups || [])
    const leadsByDay = this.groupByDay(leadCreation || [])

    // Calculate growth rates
    const userGrowthRate = this.calculateGrowthRate(signupsByDay)
    const leadGrowthRate = this.calculateGrowthRate(leadsByDay)

    return {
      userGrowth: {
        data: signupsByDay,
        growthRate: userGrowthRate
      },
      leadGrowth: {
        data: leadsByDay,
        growthRate: leadGrowthRate
      }
    }
  }

  /**
   * Get engagement metrics
   */
  private async getEngagementMetrics(
    organizationId: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any> {
    // Daily active users from events
    const { data: dailyEvents } = await this.supabase
      .from('analytics_events')
      .select('user_id, timestamp')
      .eq('organization_id', organizationId)
      .gte('timestamp', dateRange.start.toISOString())
      .lte('timestamp', dateRange.end.toISOString())

    const dauData = this.calculateDAU(dailyEvents || [])

    // Session duration from events
    const sessionDurations = await this.calculateSessionDurations(organizationId, dateRange)

    // Feature usage
    const { data: featureEvents } = await this.supabase
      .from('analytics_events')
      .select('event_name, timestamp')
      .eq('organization_id', organizationId)
      .eq('event_type', 'feature_usage')
      .gte('timestamp', dateRange.start.toISOString())
      .lte('timestamp', dateRange.end.toISOString())

    const featureUsage = this.groupBy(featureEvents || [], 'event_name')

    return {
      dailyActiveUsers: dauData,
      averageSessionDuration: sessionDurations.average,
      featureUsage
    }
  }

  /**
   * Get conversion metrics
   */
  private async getConversionMetrics(
    organizationId: string,
    dateRange: { start: Date; end: Date }
  ): Promise<any> {
    // Lead to customer conversion
    const { data: leads } = await this.supabase
      .from('leads')
      .select('id, status, created_at')
      .eq('organization_id', organizationId)
      .gte('created_at', dateRange.start.toISOString())
      .lte('created_at', dateRange.end.toISOString())

    const totalLeads = leads?.length || 0
    const convertedLeads = leads?.filter(l => l.status === 'converted').length || 0
    const conversionRate = totalLeads > 0 ? (convertedLeads / totalLeads) * 100 : 0

    // Sync success rates by CRM
    const { data: syncsByCreatedAt } = await this.supabase
      .from('sync_logs')
      .select('crm_type, status, created_at')
      .eq('organization_id', organizationId)
      .gte('created_at', dateRange.start.toISOString())
      .lte('created_at', dateRange.end.toISOString())

    const syncSuccessRateByCRM = this.calculateSyncSuccessRates(syncsByCreatedAt || [])

    return {
      leadConversion: {
        total: totalLeads,
        converted: convertedLeads,
        rate: Math.round(conversionRate * 100) / 100
      },
      syncSuccessRates: syncSuccessRateByCRM
    }
  }

  /**
   * Calculate funnel conversion rates
   */
  async calculateFunnel(
    organizationId: string,
    funnel: Funnel,
    dateRange: { start: Date; end: Date }
  ): Promise<{
    steps: Array<{ name: string; users: number; conversionRate: number }>
    totalConversionRate: number
  }> {
    const results = []
    let previousStepUsers = 0

    for (let i = 0; i < funnel.steps.length; i++) {
      const step = funnel.steps[i]
      
      // Get users who completed this step
      let query = this.supabase
        .from('analytics_events')
        .select('user_id')
        .eq('organization_id', organizationId)
        .eq('event_name', step.eventName)
        .gte('timestamp', dateRange.start.toISOString())
        .lte('timestamp', dateRange.end.toISOString())

      // Apply step-specific filters
      if (step.filters) {
        Object.entries(step.filters).forEach(([key, value]) => {
          query = query.eq(`properties->>${key}`, value)
        })
      }

      const { data: stepEvents } = await query

      const uniqueUsers = [...new Set(stepEvents?.map(e => e.user_id) || [])].length

      // For first step, conversion rate is 100%
      // For subsequent steps, calculate based on previous step
      const conversionRate = i === 0 ? 100 : 
        previousStepUsers > 0 ? (uniqueUsers / previousStepUsers) * 100 : 0

      results.push({
        name: step.name,
        users: uniqueUsers,
        conversionRate: Math.round(conversionRate * 100) / 100
      })

      previousStepUsers = uniqueUsers
    }

    const totalConversionRate = results.length > 0 && results[0].users > 0 
      ? (results[results.length - 1].users / results[0].users) * 100 
      : 0

    return {
      steps: results,
      totalConversionRate: Math.round(totalConversionRate * 100) / 100
    }
  }

  /**
   * Calculate cohort retention
   */
  async calculateCohortRetention(
    organizationId: string,
    cohortType: 'weekly' | 'monthly' = 'monthly'
  ): Promise<Cohort[]> {
    // Get all users with their signup date
    const { data: users } = await this.supabase
      .from('users')
      .select('id, created_at')
      .eq('organization_id', organizationId)
      .order('created_at')

    if (!users?.length) return []

    // Get all user activity events
    const { data: events } = await this.supabase
      .from('analytics_events')
      .select('user_id, timestamp')
      .eq('organization_id', organizationId)
      .in('user_id', users.map(u => u.id))
      .order('timestamp')

    // Group users by cohort period
    const cohorts = this.groupUsersByCohort(users, cohortType)
    
    // Calculate retention for each cohort
    const cohortData = cohorts.map(cohort => {
      const retention = this.calculateRetentionForCohort(
        cohort.users,
        events || [],
        cohort.period,
        cohortType
      )

      return {
        period: cohort.period,
        users: cohort.users.length,
        retention
      }
    })

    return cohortData
  }

  /**
   * Create dashboard
   */
  async createDashboard(
    organizationId: string,
    userId: string,
    dashboardData: {
      name: string
      description?: string
      widgets: Omit<Widget, 'id'>[]
      filters: DashboardFilter[]
      refreshInterval?: number
      isPublic?: boolean
    }
  ): Promise<Dashboard> {
    const dashboard: Dashboard = {
      id: crypto.randomUUID(),
      organizationId,
      name: dashboardData.name,
      description: dashboardData.description,
      widgets: dashboardData.widgets.map(w => ({ ...w, id: crypto.randomUUID() })),
      filters: dashboardData.filters,
      refreshInterval: dashboardData.refreshInterval || 300, // 5 minutes
      isPublic: dashboardData.isPublic || false,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const { error } = await this.supabase
      .from('analytics_dashboards')
      .insert({
        id: dashboard.id,
        organization_id: organizationId,
        created_by: userId,
        name: dashboard.name,
        description: dashboard.description,
        widgets: dashboard.widgets,
        filters: dashboard.filters,
        refresh_interval: dashboard.refreshInterval,
        is_public: dashboard.isPublic,
        created_at: dashboard.createdAt.toISOString(),
        updated_at: dashboard.updatedAt.toISOString()
      })

    if (error) throw error

    this.emit('dashboard_created', dashboard)

    return dashboard
  }

  /**
   * Get widget data
   */
  async getWidgetData(
    organizationId: string,
    widget: Widget,
    filters?: Record<string, any>
  ): Promise<any> {
    try {
      // Merge widget filters with dashboard filters
      const combinedFilters = { ...widget.config.filters, ...filters }

      // Determine time range
      const timeRange = this.resolveTimeRange(widget.config.timeRange)

      switch (widget.type) {
        case 'metric_card':
          return await this.getMetricCardData(organizationId, widget, combinedFilters, timeRange)
        
        case 'line_chart':
        case 'bar_chart':
          return await this.getChartData(organizationId, widget, combinedFilters, timeRange)
        
        case 'pie_chart':
          return await this.getPieChartData(organizationId, widget, combinedFilters, timeRange)
        
        case 'table':
          return await this.getTableData(organizationId, widget, combinedFilters, timeRange)
        
        case 'heatmap':
          return await this.getHeatmapData(organizationId, widget, combinedFilters, timeRange)
        
        default:
          throw new Error(`Unsupported widget type: ${widget.type}`)
      }

    } catch (error) {
      logger.error('Failed to get widget data', {
        widgetId: widget.id,
        widgetType: widget.type,
        error: error.message
      })
      throw error
    }
  }

  // Helper methods
  private async updateRealTimeAggregations(event: AnalyticsEvent): Promise<void> {
    const timestamp = event.timestamp
    const dateKey = timestamp.toISOString().split('T')[0]
    const hourKey = `${dateKey}:${timestamp.getHours().toString().padStart(2, '0')}`
    
    const baseKey = `analytics:${event.organizationId}`

    await this.redis.multi()
      // Daily aggregations
      .hincrby(`${baseKey}:daily:${dateKey}`, 'events', 1)
      .hincrby(`${baseKey}:daily:${dateKey}`, `event_${event.eventName}`, 1)
      .sadd(`${baseKey}:daily:${dateKey}:users`, event.userId || 'anonymous')
      
      // Hourly aggregations
      .hincrby(`${baseKey}:hourly:${hourKey}`, 'events', 1)
      .hincrby(`${baseKey}:hourly:${hourKey}`, `event_${event.eventName}`, 1)
      .sadd(`${baseKey}:hourly:${hourKey}:users`, event.userId || 'anonymous')
      
      // Set expiry
      .expire(`${baseKey}:daily:${dateKey}`, 86400 * this.config.retentionDays)
      .expire(`${baseKey}:hourly:${hourKey}`, 86400 * 7) // 7 days for hourly data
      
      .exec()
  }

  private startBackgroundAggregation(): void {
    // Process aggregations every minute
    setInterval(async () => {
      try {
        await this.processAggregations()
      } catch (error) {
        logger.error('Background aggregation failed', error)
      }
    }, 60000) // 1 minute
  }

  private async processAggregations(): Promise<void> {
    // Implementation for background aggregation processing
    // This would aggregate raw events into time-based buckets
  }

  private generateTimeBuckets(start: Date, end: Date, granularity: string): Date[] {
    const buckets: Date[] = []
    const current = new Date(start)
    
    while (current <= end) {
      buckets.push(new Date(current))
      
      switch (granularity) {
        case 'minute':
          current.setMinutes(current.getMinutes() + 1)
          break
        case 'hour':
          current.setHours(current.getHours() + 1)
          break
        case 'day':
          current.setDate(current.getDate() + 1)
          break
        case 'week':
          current.setDate(current.getDate() + 7)
          break
        case 'month':
          current.setMonth(current.getMonth() + 1)
          break
      }
    }
    
    return buckets
  }

  private buildMetricQuery(
    metric: string,
    organizationId: string,
    timeRange: any,
    filters?: Record<string, any>
  ): { function: string; parameters: any } {
    // Build SQL function call based on metric type
    const baseParams = {
      org_id: organizationId,
      start_time: timeRange.start.toISOString(),
      end_time: timeRange.end.toISOString(),
      granularity: timeRange.granularity
    }

    switch (metric) {
      case 'users':
        return {
          function: 'get_user_metrics',
          parameters: { ...baseParams, ...filters }
        }
      case 'events':
        return {
          function: 'get_event_metrics',
          parameters: { ...baseParams, ...filters }
        }
      case 'syncs':
        return {
          function: 'get_sync_metrics',
          parameters: { ...baseParams, ...filters }
        }
      default:
        return {
          function: 'get_generic_metrics',
          parameters: { ...baseParams, metric_name: metric, ...filters }
        }
    }
  }

  private fillMissingDataPoints(buckets: Date[], data: any[]): MetricValue[] {
    const dataMap = new Map()
    data.forEach(point => {
      const key = new Date(point.timestamp).toISOString()
      dataMap.set(key, point)
    })

    return buckets.map(bucket => {
      const key = bucket.toISOString()
      const existing = dataMap.get(key)
      
      return {
        timestamp: bucket,
        value: existing?.value || 0,
        metadata: existing?.metadata
      }
    })
  }

  private getMetricAggregation(metric: string): 'sum' | 'avg' | 'count' | 'min' | 'max' {
    const aggregationMap = {
      users: 'count',
      events: 'sum',
      sessions: 'count',
      revenue: 'sum',
      duration: 'avg'
    }

    return aggregationMap[metric] || 'sum'
  }

  private groupByDay(data: Array<{ created_at: string }>): Record<string, number> {
    return data.reduce((groups, item) => {
      const day = item.created_at.split('T')[0]
      groups[day] = (groups[day] || 0) + 1
      return groups
    }, {})
  }

  private groupBy(array: any[], key: string): Record<string, number> {
    return array.reduce((groups, item) => {
      const group = item[key] || 'unknown'
      groups[group] = (groups[group] || 0) + 1
      return groups
    }, {})
  }

  private calculateGrowthRate(data: Record<string, number>): number {
    const values = Object.values(data)
    if (values.length < 2) return 0

    const first = values[0]
    const last = values[values.length - 1]
    
    if (first === 0) return 0
    
    return ((last - first) / first) * 100
  }

  private calculateDAU(events: Array<{ user_id: string; timestamp: string }>): Record<string, number> {
    const dauByDay = {}
    
    events.forEach(event => {
      const day = event.timestamp.split('T')[0]
      if (!dauByDay[day]) {
        dauByDay[day] = new Set()
      }
      dauByDay[day].add(event.user_id)
    })

    return Object.entries(dauByDay).reduce((result, [day, userSet]) => {
      result[day] = (userSet as Set<string>).size
      return result
    }, {})
  }

  private async calculateSessionDurations(
    organizationId: string,
    dateRange: { start: Date; end: Date }
  ): Promise<{ average: number; median: number }> {
    // Implementation for session duration calculation
    // This would analyze session start/end events
    return { average: 0, median: 0 }
  }

  private calculateSyncSuccessRates(syncs: Array<{ crm_type: string; status: string }>): Record<string, number> {
    const grouped = syncs.reduce((acc, sync) => {
      if (!acc[sync.crm_type]) {
        acc[sync.crm_type] = { total: 0, success: 0 }
      }
      acc[sync.crm_type].total++
      if (sync.status === 'success') {
        acc[sync.crm_type].success++
      }
      return acc
    }, {})

    return Object.entries(grouped).reduce((rates, [crm, stats]) => {
      rates[crm] = stats.total > 0 ? (stats.success / stats.total) * 100 : 0
      return rates
    }, {})
  }

  private groupUsersByCohort(users: any[], cohortType: 'weekly' | 'monthly'): Array<{ period: string; users: any[] }> {
    const cohorts = {}

    users.forEach(user => {
      const date = new Date(user.created_at)
      let period: string

      if (cohortType === 'weekly') {
        // Get start of week (Monday)
        const startOfWeek = new Date(date)
        startOfWeek.setDate(date.getDate() - date.getDay() + 1)
        period = startOfWeek.toISOString().split('T')[0]
      } else {
        // Get start of month
        period = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`
      }

      if (!cohorts[period]) {
        cohorts[period] = []
      }
      cohorts[period].push(user)
    })

    return Object.entries(cohorts).map(([period, users]) => ({ period, users }))
  }

  private calculateRetentionForCohort(
    cohortUsers: any[],
    allEvents: any[],
    cohortPeriod: string,
    cohortType: 'weekly' | 'monthly'
  ): Record<string, number> {
    const userIds = new Set(cohortUsers.map(u => u.id))
    const userEvents = allEvents.filter(e => userIds.has(e.user_id))
    
    const retention = {}
    const cohortStart = new Date(cohortPeriod)

    // Calculate retention for each period after cohort creation
    for (let i = 1; i <= 12; i++) { // Up to 12 periods
      const periodStart = new Date(cohortStart)
      const periodEnd = new Date(cohortStart)

      if (cohortType === 'weekly') {
        periodStart.setDate(periodStart.getDate() + (i * 7))
        periodEnd.setDate(periodEnd.getDate() + ((i + 1) * 7))
      } else {
        periodStart.setMonth(periodStart.getMonth() + i)
        periodEnd.setMonth(periodEnd.getMonth() + i + 1)
      }

      const activeUsersInPeriod = new Set(
        userEvents
          .filter(e => {
            const eventDate = new Date(e.timestamp)
            return eventDate >= periodStart && eventDate < periodEnd
          })
          .map(e => e.user_id)
      )

      const retentionRate = (activeUsersInPeriod.size / cohortUsers.length) * 100
      retention[`period_${i}`] = Math.round(retentionRate * 100) / 100
    }

    return retention
  }

  private resolveTimeRange(timeRangeConfig?: WidgetConfig['timeRange']): { start: Date; end: Date } {
    if (!timeRangeConfig) {
      // Default to last 7 days
      return {
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        end: new Date()
      }
    }

    if (timeRangeConfig.type === 'absolute') {
      const [startStr, endStr] = timeRangeConfig.value.split('_')
      return {
        start: new Date(startStr),
        end: new Date(endStr)
      }
    } else {
      // Relative time range
      const now = new Date()
      const value = timeRangeConfig.value

      switch (value) {
        case 'last_hour':
          return { start: new Date(now.getTime() - 60 * 60 * 1000), end: now }
        case 'last_24_hours':
          return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now }
        case 'last_7_days':
          return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now }
        case 'last_30_days':
          return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now }
        case 'last_90_days':
          return { start: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), end: now }
        default:
          return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now }
      }
    }
  }

  private async getMetricCardData(
    organizationId: string,
    widget: Widget,
    filters: Record<string, any>,
    timeRange: { start: Date; end: Date }
  ): Promise<any> {
    // Implementation for metric card data
    return { value: 0, change: 0, changeType: 'increase' }
  }

  private async getChartData(
    organizationId: string,
    widget: Widget,
    filters: Record<string, any>,
    timeRange: { start: Date; end: Date }
  ): Promise<any> {
    // Implementation for chart data
    return { labels: [], datasets: [] }
  }

  private async getPieChartData(
    organizationId: string,
    widget: Widget,
    filters: Record<string, any>,
    timeRange: { start: Date; end: Date }
  ): Promise<any> {
    // Implementation for pie chart data
    return { labels: [], data: [] }
  }

  private async getTableData(
    organizationId: string,
    widget: Widget,
    filters: Record<string, any>,
    timeRange: { start: Date; end: Date }
  ): Promise<any> {
    // Implementation for table data
    return { headers: [], rows: [] }
  }

  private async getHeatmapData(
    organizationId: string,
    widget: Widget,
    filters: Record<string, any>,
    timeRange: { start: Date; end: Date }
  ): Promise<any> {
    // Implementation for heatmap data
    return { data: [] }
  }
}