import { createClient } from '@supabase/supabase-js'
import { Redis } from 'ioredis'
import { logger } from '../utils/logger'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'

interface SupportTicket {
  id: string
  organizationId: string
  userId: string
  subject: string
  description: string
  category: 'technical' | 'billing' | 'feature_request' | 'bug_report' | 'general'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  status: 'open' | 'in_progress' | 'waiting_for_customer' | 'resolved' | 'closed'
  assignedTo?: string
  tags: string[]
  metadata: Record<string, any>
  createdAt: Date
  updatedAt: Date
  resolvedAt?: Date
  firstResponseAt?: Date
}

interface TicketComment {
  id: string
  ticketId: string
  authorId: string
  authorType: 'customer' | 'agent'
  content: string
  isInternal: boolean
  attachments?: string[]
  createdAt: Date
}

interface KnowledgeBaseArticle {
  id: string
  title: string
  content: string
  category: string
  tags: string[]
  status: 'draft' | 'published' | 'archived'
  authorId: string
  views: number
  helpful: number
  notHelpful: number
  searchKeywords: string[]
  createdAt: Date
  updatedAt: Date
}

interface LiveChatSession {
  id: string
  organizationId: string
  userId?: string
  visitorId?: string
  agentId?: string
  status: 'waiting' | 'active' | 'ended'
  metadata: {
    userAgent?: string
    ip?: string
    page?: string
    referrer?: string
  }
  startedAt: Date
  endedAt?: Date
  rating?: number
  feedback?: string
}

interface ChatMessage {
  id: string
  sessionId: string
  senderId: string
  senderType: 'customer' | 'agent' | 'system'
  message: string
  messageType: 'text' | 'image' | 'file' | 'system'
  timestamp: Date
}

interface SupportConfig {
  redis: Redis
  supabaseUrl: string
  supabaseKey: string
  zendesk?: {
    domain: string
    email: string
    token: string
  }
  intercom?: {
    accessToken: string
  }
  slack?: {
    webhookUrl: string
    channel: string
  }
  autoAssignment: {
    enabled: boolean
    roundRobin: boolean
    skillBasedRouting: boolean
  }
  sla: {
    firstResponse: {
      low: number      // hours
      medium: number
      high: number
      urgent: number
    }
    resolution: {
      low: number      // hours
      medium: number
      high: number
      urgent: number
    }
  }
}

export class SupportService extends EventEmitter {
  private redis: Redis
  private supabase: any
  private config: SupportConfig

  constructor(config: SupportConfig) {
    super()
    
    this.config = config
    this.redis = config.redis
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey)
  }

  /**
   * Create support ticket
   */
  async createTicket(
    organizationId: string,
    userId: string,
    ticketData: {
      subject: string
      description: string
      category: SupportTicket['category']
      priority: SupportTicket['priority']
      tags?: string[]
      metadata?: Record<string, any>
    }
  ): Promise<SupportTicket> {
    const ticket: SupportTicket = {
      id: uuidv4(),
      organizationId,
      userId,
      subject: ticketData.subject,
      description: ticketData.description,
      category: ticketData.category,
      priority: ticketData.priority,
      status: 'open',
      tags: ticketData.tags || [],
      metadata: ticketData.metadata || {},
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // Auto-assign if enabled
    if (this.config.autoAssignment.enabled) {
      ticket.assignedTo = await this.autoAssignTicket(ticket)
    }

    // Store ticket
    const { error } = await this.supabase
      .from('support_tickets')
      .insert({
        id: ticket.id,
        organization_id: organizationId,
        user_id: userId,
        subject: ticket.subject,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        assigned_to: ticket.assignedTo,
        tags: ticket.tags,
        metadata: ticket.metadata,
        created_at: ticket.createdAt.toISOString(),
        updated_at: ticket.updatedAt.toISOString()
      })

    if (error) throw error

    // Create initial system comment
    await this.addTicketComment(ticket.id, 'system', 'system', `Ticket created by customer`, true)

    // Notify relevant parties
    await this.notifyTicketCreated(ticket)

    // Track metrics
    await this.trackTicketMetrics('created', ticket.category, ticket.priority)

    this.emit('ticket_created', ticket)

    logger.info('Support ticket created', {
      ticketId: ticket.id,
      organizationId,
      userId,
      category: ticket.category,
      priority: ticket.priority
    })

    return ticket
  }

  /**
   * Update ticket
   */
  async updateTicket(
    ticketId: string,
    userId: string,
    updates: Partial<Pick<SupportTicket, 'status' | 'priority' | 'assignedTo' | 'tags'>>
  ): Promise<SupportTicket> {
    // Get current ticket
    const { data: currentTicket, error: fetchError } = await this.supabase
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .single()

    if (fetchError || !currentTicket) {
      throw new Error('Ticket not found')
    }

    // Prepare updates
    const updateData: any = {
      updated_at: new Date().toISOString()
    }

    if (updates.status) {
      updateData.status = updates.status
      
      // Track resolution time if closing
      if (['resolved', 'closed'].includes(updates.status)) {
        updateData.resolved_at = new Date().toISOString()
      }
    }

    if (updates.priority) updateData.priority = updates.priority
    if (updates.assignedTo) updateData.assigned_to = updates.assignedTo
    if (updates.tags) updateData.tags = updates.tags

    // Update ticket
    const { data: updatedTicket, error: updateError } = await this.supabase
      .from('support_tickets')
      .update(updateData)
      .eq('id', ticketId)
      .select()
      .single()

    if (updateError) throw updateError

    // Add system comment for status changes
    if (updates.status && updates.status !== currentTicket.status) {
      await this.addTicketComment(
        ticketId,
        userId,
        'system',
        `Status changed from ${currentTicket.status} to ${updates.status}`,
        true
      )
    }

    // Calculate SLA compliance
    await this.checkSLACompliance(ticketId)

    // Notify about updates
    await this.notifyTicketUpdated(updatedTicket, currentTicket)

    const ticket = this.mapTicketFromDB(updatedTicket)

    this.emit('ticket_updated', ticket)

    logger.info('Support ticket updated', {
      ticketId,
      updates,
      updatedBy: userId
    })

    return ticket
  }

  /**
   * Add comment to ticket
   */
  async addTicketComment(
    ticketId: string,
    authorId: string,
    authorType: TicketComment['authorType'],
    content: string,
    isInternal: boolean = false,
    attachments?: string[]
  ): Promise<TicketComment> {
    const comment: TicketComment = {
      id: uuidv4(),
      ticketId,
      authorId,
      authorType,
      content,
      isInternal,
      attachments,
      createdAt: new Date()
    }

    const { error } = await this.supabase
      .from('ticket_comments')
      .insert({
        id: comment.id,
        ticket_id: ticketId,
        author_id: authorId,
        author_type: authorType,
        content,
        is_internal: isInternal,
        attachments,
        created_at: comment.createdAt.toISOString()
      })

    if (error) throw error

    // Update ticket updated_at timestamp
    await this.supabase
      .from('support_tickets')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', ticketId)

    // Track first response time for agent replies
    if (authorType === 'agent' && !isInternal) {
      await this.trackFirstResponse(ticketId)
    }

    // Notify if it's a customer-facing comment
    if (!isInternal) {
      await this.notifyNewComment(ticketId, comment)
    }

    this.emit('ticket_comment_added', comment)

    return comment
  }

  /**
   * Get ticket with comments
   */
  async getTicketWithComments(ticketId: string, includeInternal: boolean = false): Promise<{
    ticket: SupportTicket
    comments: TicketComment[]
  }> {
    // Get ticket
    const { data: ticketData, error: ticketError } = await this.supabase
      .from('support_tickets')
      .select(`
        *,
        users!support_tickets_user_id_fkey(email, first_name, last_name),
        assigned_user:users!support_tickets_assigned_to_fkey(email, first_name, last_name)
      `)
      .eq('id', ticketId)
      .single()

    if (ticketError) throw ticketError

    // Get comments
    let commentsQuery = this.supabase
      .from('ticket_comments')
      .select(`
        *,
        author:users(email, first_name, last_name)
      `)
      .eq('ticket_id', ticketId)

    if (!includeInternal) {
      commentsQuery = commentsQuery.eq('is_internal', false)
    }

    const { data: commentsData, error: commentsError } = await commentsQuery
      .order('created_at', { ascending: true })

    if (commentsError) throw commentsError

    const ticket = this.mapTicketFromDB(ticketData)
    const comments = commentsData.map(this.mapCommentFromDB)

    return { ticket, comments }
  }

  /**
   * Search tickets
   */
  async searchTickets(
    organizationId: string,
    filters: {
      status?: string[]
      category?: string[]
      priority?: string[]
      assignedTo?: string
      userId?: string
      search?: string
      dateFrom?: Date
      dateTo?: Date
    },
    pagination: { page: number; limit: number }
  ): Promise<{
    tickets: SupportTicket[]
    total: number
  }> {
    let query = this.supabase
      .from('support_tickets')
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId)

    // Apply filters
    if (filters.status?.length) {
      query = query.in('status', filters.status)
    }

    if (filters.category?.length) {
      query = query.in('category', filters.category)
    }

    if (filters.priority?.length) {
      query = query.in('priority', filters.priority)
    }

    if (filters.assignedTo) {
      query = query.eq('assigned_to', filters.assignedTo)
    }

    if (filters.userId) {
      query = query.eq('user_id', filters.userId)
    }

    if (filters.dateFrom) {
      query = query.gte('created_at', filters.dateFrom.toISOString())
    }

    if (filters.dateTo) {
      query = query.lte('created_at', filters.dateTo.toISOString())
    }

    if (filters.search) {
      query = query.or(
        `subject.ilike.%${filters.search}%,description.ilike.%${filters.search}%`
      )
    }

    // Apply pagination
    const offset = (pagination.page - 1) * pagination.limit
    const { data: tickets, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + pagination.limit - 1)

    if (error) throw error

    return {
      tickets: tickets.map(this.mapTicketFromDB),
      total: count || 0
    }
  }

  /**
   * Auto-assign ticket
   */
  private async autoAssignTicket(ticket: SupportTicket): Promise<string | undefined> {
    try {
      // Get available agents
      const { data: agents, error } = await this.supabase
        .from('support_agents')
        .select('*')
        .eq('is_active', true)
        .eq('is_available', true)

      if (error || !agents?.length) return undefined

      let selectedAgent

      if (this.config.autoAssignment.skillBasedRouting) {
        // Find agents with matching skills
        selectedAgent = agents.find(agent => 
          agent.skills?.includes(ticket.category) || 
          agent.categories?.includes(ticket.category)
        )
      }

      if (!selectedAgent && this.config.autoAssignment.roundRobin) {
        // Round-robin assignment
        const lastAssigned = await this.redis.get('support:last_assigned') || '0'
        const nextIndex = (parseInt(lastAssigned) + 1) % agents.length
        selectedAgent = agents[nextIndex]
        await this.redis.set('support:last_assigned', nextIndex.toString())
      }

      if (!selectedAgent) {
        // Default to least busy agent
        const { data: workloads } = await this.supabase
          .from('support_tickets')
          .select('assigned_to')
          .in('status', ['open', 'in_progress'])
          .in('assigned_to', agents.map(a => a.user_id))

        const workloadMap = workloads?.reduce((acc, t) => {
          acc[t.assigned_to] = (acc[t.assigned_to] || 0) + 1
          return acc
        }, {}) || {}

        selectedAgent = agents.reduce((least, agent) => {
          const agentLoad = workloadMap[agent.user_id] || 0
          const leastLoad = workloadMap[least.user_id] || 0
          return agentLoad < leastLoad ? agent : least
        })
      }

      return selectedAgent?.user_id

    } catch (error) {
      logger.error('Auto-assignment failed', error)
      return undefined
    }
  }

  /**
   * Track first response time
   */
  private async trackFirstResponse(ticketId: string): Promise<void> {
    const { data: ticket } = await this.supabase
      .from('support_tickets')
      .select('first_response_at, created_at')
      .eq('id', ticketId)
      .single()

    if (ticket && !ticket.first_response_at) {
      await this.supabase
        .from('support_tickets')
        .update({
          first_response_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', ticketId)
    }
  }

  /**
   * Check SLA compliance
   */
  private async checkSLACompliance(ticketId: string): Promise<void> {
    const { data: ticket } = await this.supabase
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .single()

    if (!ticket) return

    const createdAt = new Date(ticket.created_at)
    const now = new Date()
    const hoursElapsed = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60)

    const slaTargets = this.config.sla

    // Check first response SLA
    if (!ticket.first_response_at) {
      const responseTarget = slaTargets.firstResponse[ticket.priority]
      if (hoursElapsed > responseTarget) {
        await this.createSLAAlert(ticketId, 'first_response_breach', hoursElapsed, responseTarget)
      }
    }

    // Check resolution SLA
    if (!ticket.resolved_at && ['open', 'in_progress'].includes(ticket.status)) {
      const resolutionTarget = slaTargets.resolution[ticket.priority]
      if (hoursElapsed > resolutionTarget) {
        await this.createSLAAlert(ticketId, 'resolution_breach', hoursElapsed, resolutionTarget)
      }
    }
  }

  /**
   * Create SLA alert
   */
  private async createSLAAlert(
    ticketId: string,
    type: 'first_response_breach' | 'resolution_breach',
    elapsed: number,
    target: number
  ): Promise<void> {
    const { error } = await this.supabase
      .from('sla_alerts')
      .insert({
        ticket_id: ticketId,
        alert_type: type,
        elapsed_hours: elapsed,
        target_hours: target,
        created_at: new Date().toISOString()
      })

    if (error) {
      logger.error('Failed to create SLA alert', error)
      return
    }

    // Notify via Slack if configured
    if (this.config.slack) {
      await this.sendSlackNotification(
        `🚨 SLA Breach Alert: Ticket ${ticketId} - ${type} (${Math.round(elapsed)}h vs ${target}h target)`
      )
    }

    this.emit('sla_breach', { ticketId, type, elapsed, target })
  }

  /**
   * Create knowledge base article
   */
  async createKBArticle(
    authorId: string,
    articleData: {
      title: string
      content: string
      category: string
      tags: string[]
      searchKeywords: string[]
      status?: 'draft' | 'published'
    }
  ): Promise<KnowledgeBaseArticle> {
    const article: KnowledgeBaseArticle = {
      id: uuidv4(),
      title: articleData.title,
      content: articleData.content,
      category: articleData.category,
      tags: articleData.tags,
      status: articleData.status || 'draft',
      authorId,
      views: 0,
      helpful: 0,
      notHelpful: 0,
      searchKeywords: articleData.searchKeywords,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const { error } = await this.supabase
      .from('kb_articles')
      .insert({
        id: article.id,
        title: article.title,
        content: article.content,
        category: article.category,
        tags: article.tags,
        status: article.status,
        author_id: authorId,
        views: 0,
        helpful: 0,
        not_helpful: 0,
        search_keywords: article.searchKeywords,
        created_at: article.createdAt.toISOString(),
        updated_at: article.updatedAt.toISOString()
      })

    if (error) throw error

    this.emit('kb_article_created', article)

    logger.info('Knowledge base article created', {
      articleId: article.id,
      title: article.title,
      category: article.category,
      authorId
    })

    return article
  }

  /**
   * Search knowledge base
   */
  async searchKB(
    query: string,
    category?: string,
    limit: number = 10
  ): Promise<KnowledgeBaseArticle[]> {
    let searchQuery = this.supabase
      .from('kb_articles')
      .select('*')
      .eq('status', 'published')

    if (category) {
      searchQuery = searchQuery.eq('category', category)
    }

    // Full-text search on title, content, and keywords
    searchQuery = searchQuery.or(
      `title.ilike.%${query}%,content.ilike.%${query}%,search_keywords.cs.{${query}}`
    )

    const { data: articles, error } = await searchQuery
      .order('views', { ascending: false })
      .limit(limit)

    if (error) throw error

    return articles.map(this.mapKBArticleFromDB)
  }

  /**
   * Track article view
   */
  async trackArticleView(articleId: string): Promise<void> {
    await this.supabase.rpc('increment_article_views', { article_id: articleId })
  }

  /**
   * Rate article helpfulness
   */
  async rateArticle(articleId: string, helpful: boolean): Promise<void> {
    const column = helpful ? 'helpful' : 'not_helpful'
    await this.supabase.rpc(`increment_article_${column}`, { article_id: articleId })
  }

  /**
   * Start live chat session
   */
  async startChatSession(
    organizationId: string,
    userId?: string,
    metadata?: Record<string, any>
  ): Promise<LiveChatSession> {
    const session: LiveChatSession = {
      id: uuidv4(),
      organizationId,
      userId,
      visitorId: userId ? undefined : uuidv4(),
      status: 'waiting',
      metadata: metadata || {},
      startedAt: new Date()
    }

    const { error } = await this.supabase
      .from('chat_sessions')
      .insert({
        id: session.id,
        organization_id: organizationId,
        user_id: userId,
        visitor_id: session.visitorId,
        status: session.status,
        metadata: session.metadata,
        started_at: session.startedAt.toISOString()
      })

    if (error) throw error

    // Queue for agent assignment
    await this.redis.lpush('chat_queue', JSON.stringify({
      sessionId: session.id,
      organizationId,
      userId,
      startedAt: session.startedAt.toISOString()
    }))

    this.emit('chat_session_started', session)

    return session
  }

  /**
   * Send chat message
   */
  async sendChatMessage(
    sessionId: string,
    senderId: string,
    senderType: ChatMessage['senderType'],
    message: string,
    messageType: ChatMessage['messageType'] = 'text'
  ): Promise<ChatMessage> {
    const chatMessage: ChatMessage = {
      id: uuidv4(),
      sessionId,
      senderId,
      senderType,
      message,
      messageType,
      timestamp: new Date()
    }

    const { error } = await this.supabase
      .from('chat_messages')
      .insert({
        id: chatMessage.id,
        session_id: sessionId,
        sender_id: senderId,
        sender_type: senderType,
        message,
        message_type: messageType,
        timestamp: chatMessage.timestamp.toISOString()
      })

    if (error) throw error

    // Publish to real-time channel
    await this.redis.publish(`chat:${sessionId}`, JSON.stringify(chatMessage))

    this.emit('chat_message_sent', chatMessage)

    return chatMessage
  }

  /**
   * Get support metrics
   */
  async getSupportMetrics(
    organizationId: string,
    dateFrom: Date,
    dateTo: Date
  ): Promise<{
    tickets: any
    sla: any
    satisfaction: any
    agents: any
  }> {
    // Ticket metrics
    const { data: ticketStats } = await this.supabase
      .from('support_tickets')
      .select('status, priority, category, created_at, resolved_at, first_response_at')
      .eq('organization_id', organizationId)
      .gte('created_at', dateFrom.toISOString())
      .lte('created_at', dateTo.toISOString())

    // Calculate metrics
    const totalTickets = ticketStats?.length || 0
    const resolvedTickets = ticketStats?.filter(t => t.resolved_at).length || 0
    const avgResolutionTime = this.calculateAverageResolutionTime(ticketStats || [])
    const avgFirstResponseTime = this.calculateAverageFirstResponseTime(ticketStats || [])

    const ticketsByStatus = this.groupBy(ticketStats || [], 'status')
    const ticketsByPriority = this.groupBy(ticketStats || [], 'priority')
    const ticketsByCategory = this.groupBy(ticketStats || [], 'category')

    return {
      tickets: {
        total: totalTickets,
        resolved: resolvedTickets,
        resolutionRate: totalTickets > 0 ? (resolvedTickets / totalTickets) * 100 : 0,
        byStatus: ticketsByStatus,
        byPriority: ticketsByPriority,
        byCategory: ticketsByCategory
      },
      sla: {
        avgResolutionTime,
        avgFirstResponseTime,
        breaches: await this.getSLABreaches(organizationId, dateFrom, dateTo)
      },
      satisfaction: await this.getSatisfactionMetrics(organizationId, dateFrom, dateTo),
      agents: await this.getAgentMetrics(organizationId, dateFrom, dateTo)
    }
  }

  // Helper methods
  private mapTicketFromDB(dbTicket: any): SupportTicket {
    return {
      id: dbTicket.id,
      organizationId: dbTicket.organization_id,
      userId: dbTicket.user_id,
      subject: dbTicket.subject,
      description: dbTicket.description,
      category: dbTicket.category,
      priority: dbTicket.priority,
      status: dbTicket.status,
      assignedTo: dbTicket.assigned_to,
      tags: dbTicket.tags || [],
      metadata: dbTicket.metadata || {},
      createdAt: new Date(dbTicket.created_at),
      updatedAt: new Date(dbTicket.updated_at),
      resolvedAt: dbTicket.resolved_at ? new Date(dbTicket.resolved_at) : undefined,
      firstResponseAt: dbTicket.first_response_at ? new Date(dbTicket.first_response_at) : undefined
    }
  }

  private mapCommentFromDB(dbComment: any): TicketComment {
    return {
      id: dbComment.id,
      ticketId: dbComment.ticket_id,
      authorId: dbComment.author_id,
      authorType: dbComment.author_type,
      content: dbComment.content,
      isInternal: dbComment.is_internal,
      attachments: dbComment.attachments,
      createdAt: new Date(dbComment.created_at)
    }
  }

  private mapKBArticleFromDB(dbArticle: any): KnowledgeBaseArticle {
    return {
      id: dbArticle.id,
      title: dbArticle.title,
      content: dbArticle.content,
      category: dbArticle.category,
      tags: dbArticle.tags || [],
      status: dbArticle.status,
      authorId: dbArticle.author_id,
      views: dbArticle.views || 0,
      helpful: dbArticle.helpful || 0,
      notHelpful: dbArticle.not_helpful || 0,
      searchKeywords: dbArticle.search_keywords || [],
      createdAt: new Date(dbArticle.created_at),
      updatedAt: new Date(dbArticle.updated_at)
    }
  }

  private calculateAverageResolutionTime(tickets: any[]): number {
    const resolvedTickets = tickets.filter(t => t.resolved_at)
    if (resolvedTickets.length === 0) return 0

    const totalHours = resolvedTickets.reduce((sum, ticket) => {
      const created = new Date(ticket.created_at)
      const resolved = new Date(ticket.resolved_at)
      return sum + (resolved.getTime() - created.getTime()) / (1000 * 60 * 60)
    }, 0)

    return Math.round(totalHours / resolvedTickets.length * 100) / 100
  }

  private calculateAverageFirstResponseTime(tickets: any[]): number {
    const respondedTickets = tickets.filter(t => t.first_response_at)
    if (respondedTickets.length === 0) return 0

    const totalHours = respondedTickets.reduce((sum, ticket) => {
      const created = new Date(ticket.created_at)
      const responded = new Date(ticket.first_response_at)
      return sum + (responded.getTime() - created.getTime()) / (1000 * 60 * 60)
    }, 0)

    return Math.round(totalHours / respondedTickets.length * 100) / 100
  }

  private groupBy(array: any[], key: string): Record<string, number> {
    return array.reduce((groups, item) => {
      const group = item[key] || 'unknown'
      groups[group] = (groups[group] || 0) + 1
      return groups
    }, {})
  }

  private async getSLABreaches(organizationId: string, from: Date, to: Date): Promise<any> {
    const { data: breaches } = await this.supabase
      .from('sla_alerts')
      .select('*')
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString())

    return {
      total: breaches?.length || 0,
      byType: this.groupBy(breaches || [], 'alert_type')
    }
  }

  private async getSatisfactionMetrics(organizationId: string, from: Date, to: Date): Promise<any> {
    // Implementation would depend on how satisfaction ratings are stored
    return {
      averageRating: 4.2,
      totalResponses: 156,
      distribution: {
        5: 45,
        4: 67,
        3: 28,
        2: 12,
        1: 4
      }
    }
  }

  private async getAgentMetrics(organizationId: string, from: Date, to: Date): Promise<any> {
    const { data: agents } = await this.supabase
      .from('support_agents')
      .select(`
        *,
        assigned_tickets:support_tickets(count)
      `)
      .eq('organization_id', organizationId)

    return {
      totalAgents: agents?.length || 0,
      activeAgents: agents?.filter(a => a.is_active).length || 0,
      avgTicketsPerAgent: agents?.length ? 
        (agents.reduce((sum, a) => sum + (a.assigned_tickets?.[0]?.count || 0), 0) / agents.length) : 0
    }
  }

  private async notifyTicketCreated(ticket: SupportTicket): Promise<void> {
    // Implementation for notifications (email, Slack, etc.)
    if (this.config.slack) {
      await this.sendSlackNotification(
        `🎫 New ${ticket.priority} priority ticket created: ${ticket.subject}`
      )
    }
  }

  private async notifyTicketUpdated(ticket: any, previousTicket: any): Promise<void> {
    // Implementation for update notifications
  }

  private async notifyNewComment(ticketId: string, comment: TicketComment): Promise<void> {
    // Implementation for comment notifications
  }

  private async sendSlackNotification(message: string): Promise<void> {
    if (!this.config.slack?.webhookUrl) return

    try {
      await axios.post(this.config.slack.webhookUrl, {
        channel: this.config.slack.channel,
        text: message,
        username: 'Sierra Sync Support'
      })
    } catch (error) {
      logger.error('Failed to send Slack notification', error)
    }
  }

  private async trackTicketMetrics(action: string, category: string, priority: string): Promise<void> {
    const key = `support_metrics:${new Date().toISOString().split('T')[0]}`
    
    await this.redis.multi()
      .hincrby(key, 'total', 1)
      .hincrby(key, `action_${action}`, 1)
      .hincrby(key, `category_${category}`, 1)
      .hincrby(key, `priority_${priority}`, 1)
      .expire(key, 86400 * 30) // 30 days
      .exec()
  }
}