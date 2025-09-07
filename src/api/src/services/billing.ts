import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger'
import { captureError } from '../utils/monitoring'
import { EventEmitter } from 'events'
import crypto from 'crypto'

interface SubscriptionPlan {
  id: string
  name: string
  priceId: string
  price: number
  interval: 'month' | 'year'
  features: string[]
  maxUsers: number
  maxIntegrations: number
  maxSyncsPerMonth: number
  priority: 'low' | 'normal' | 'high'
}

interface BillingCustomer {
  id: string
  organizationId: string
  stripeCustomerId: string
  email: string
  name: string
  subscriptionId?: string
  subscriptionStatus?: string
  currentPlan?: string
  billingCycle?: 'monthly' | 'yearly'
  nextBillingDate?: Date
  trialing?: boolean
  trialEndsAt?: Date
}

interface UsageMetrics {
  organizationId: string
  period: string
  totalUsers: number
  totalIntegrations: number
  totalSyncs: number
  storageUsed: number
  apiCalls: number
}

export class BillingService extends EventEmitter {
  private stripe: Stripe
  private supabase: any
  
  // Subscription plans
  private plans: SubscriptionPlan[] = [
    {
      id: 'free',
      name: 'Free',
      priceId: '',
      price: 0,
      interval: 'month',
      features: [
        'Up to 2 CRM integrations',
        'Up to 5 team members',
        '1,000 syncs per month',
        'Basic support'
      ],
      maxUsers: 5,
      maxIntegrations: 2,
      maxSyncsPerMonth: 1000,
      priority: 'low'
    },
    {
      id: 'starter',
      name: 'Starter',
      priceId: process.env.STRIPE_STARTER_PRICE_ID!,
      price: 29,
      interval: 'month',
      features: [
        'Up to 5 CRM integrations',
        'Up to 10 team members',
        '10,000 syncs per month',
        'Priority support',
        'Advanced reporting'
      ],
      maxUsers: 10,
      maxIntegrations: 5,
      maxSyncsPerMonth: 10000,
      priority: 'normal'
    },
    {
      id: 'professional',
      name: 'Professional',
      priceId: process.env.STRIPE_PROFESSIONAL_PRICE_ID!,
      price: 99,
      interval: 'month',
      features: [
        'Unlimited CRM integrations',
        'Up to 50 team members',
        '100,000 syncs per month',
        'Priority support',
        'Advanced reporting',
        'Custom field mappings',
        'API access'
      ],
      maxUsers: 50,
      maxIntegrations: -1, // Unlimited
      maxSyncsPerMonth: 100000,
      priority: 'high'
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID!,
      price: 299,
      interval: 'month',
      features: [
        'Everything in Professional',
        'Unlimited team members',
        'Unlimited syncs',
        'Dedicated support',
        'Custom integrations',
        'SLA guarantees',
        'White-label options'
      ],
      maxUsers: -1, // Unlimited
      maxIntegrations: -1, // Unlimited
      maxSyncsPerMonth: -1, // Unlimited
      priority: 'high'
    }
  ]
  
  constructor() {
    super()
    
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
      typescript: true
    })
    
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    )
  }
  
  /**
   * Create a new customer in Stripe
   */
  async createCustomer(organizationId: string, email: string, name: string): Promise<BillingCustomer> {
    try {
      const stripeCustomer = await this.stripe.customers.create({
        email,
        name,
        metadata: {
          organizationId
        }
      })
      
      // Store in database
      const { data: customer, error } = await this.supabase
        .from('billing_customers')
        .insert({
          organization_id: organizationId,
          stripe_customer_id: stripeCustomer.id,
          email,
          name
        })
        .select()
        .single()
      
      if (error) throw error
      
      const billingCustomer: BillingCustomer = {
        id: customer.id,
        organizationId: customer.organization_id,
        stripeCustomerId: customer.stripe_customer_id,
        email: customer.email,
        name: customer.name
      }
      
      this.emit('customer_created', billingCustomer)
      
      logger.info('Billing customer created', { organizationId, stripeCustomerId: stripeCustomer.id })
      
      return billingCustomer
    } catch (error) {
      logger.error('Failed to create billing customer:', error)
      captureError(error as Error, { tags: { organizationId } })
      throw error
    }
  }
  
  /**
   * Get customer by organization ID
   */
  async getCustomer(organizationId: string): Promise<BillingCustomer | null> {
    try {
      const { data: customer, error } = await this.supabase
        .from('billing_customers')
        .select('*')
        .eq('organization_id', organizationId)
        .single()
      
      if (error && error.code !== 'PGRST116') { // Not found
        throw error
      }
      
      if (!customer) return null
      
      return {
        id: customer.id,
        organizationId: customer.organization_id,
        stripeCustomerId: customer.stripe_customer_id,
        email: customer.email,
        name: customer.name,
        subscriptionId: customer.subscription_id,
        subscriptionStatus: customer.subscription_status,
        currentPlan: customer.current_plan,
        billingCycle: customer.billing_cycle,
        nextBillingDate: customer.next_billing_date ? new Date(customer.next_billing_date) : undefined,
        trialing: customer.trialing,
        trialEndsAt: customer.trial_ends_at ? new Date(customer.trial_ends_at) : undefined
      }
    } catch (error) {
      logger.error('Failed to get billing customer:', error)
      throw error
    }
  }
  
  /**
   * Create checkout session for subscription
   */
  async createCheckoutSession(
    organizationId: string,
    planId: string,
    successUrl: string,
    cancelUrl: string,
    trialDays?: number
  ): Promise<string> {
    try {
      const customer = await this.getCustomer(organizationId)
      if (!customer) {
        throw new Error('Customer not found')
      }
      
      const plan = this.plans.find(p => p.id === planId)
      if (!plan || !plan.priceId) {
        throw new Error('Invalid plan')
      }
      
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        customer: customer.stripeCustomerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: plan.priceId,
            quantity: 1
          }
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          organizationId,
          planId
        },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        tax_id_collection: {
          enabled: true
        }
      }
      
      // Add trial if specified
      if (trialDays) {
        sessionParams.subscription_data = {
          trial_period_days: trialDays,
          metadata: {
            organizationId,
            planId
          }
        }
      }
      
      const session = await this.stripe.checkout.sessions.create(sessionParams)
      
      logger.info('Checkout session created', {
        organizationId,
        planId,
        sessionId: session.id
      })
      
      return session.url!
    } catch (error) {
      logger.error('Failed to create checkout session:', error)
      captureError(error as Error, { tags: { organizationId, planId } })
      throw error
    }
  }
  
  /**
   * Create billing portal session
   */
  async createPortalSession(organizationId: string, returnUrl: string): Promise<string> {
    try {
      const customer = await this.getCustomer(organizationId)
      if (!customer) {
        throw new Error('Customer not found')
      }
      
      const session = await this.stripe.billingPortal.sessions.create({
        customer: customer.stripeCustomerId,
        return_url: returnUrl
      })
      
      return session.url
    } catch (error) {
      logger.error('Failed to create portal session:', error)
      throw error
    }
  }
  
  /**
   * Handle Stripe webhook
   */
  async handleWebhook(payload: string, signature: string): Promise<void> {
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
      
      logger.info('Stripe webhook received', { type: event.type, id: event.id })
      
      switch (event.type) {
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
          break
          
        case 'customer.subscription.created':
          await this.handleSubscriptionCreated(event.data.object as Stripe.Subscription)
          break
          
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
          break
          
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
          break
          
        case 'invoice.payment_succeeded':
          await this.handlePaymentSucceeded(event.data.object as Stripe.Invoice)
          break
          
        case 'invoice.payment_failed':
          await this.handlePaymentFailed(event.data.object as Stripe.Invoice)
          break
          
        case 'customer.subscription.trial_will_end':
          await this.handleTrialWillEnd(event.data.object as Stripe.Subscription)
          break
          
        default:
          logger.info('Unhandled webhook event type', { type: event.type })
      }
      
      this.emit('webhook_processed', { type: event.type, id: event.id })
    } catch (error) {
      logger.error('Webhook processing failed:', error)
      captureError(error as Error, { tags: { webhook: 'stripe' } })
      throw error
    }
  }
  
  /**
   * Handle successful checkout
   */
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const organizationId = session.metadata?.organizationId
    const planId = session.metadata?.planId
    
    if (!organizationId || !planId) {
      logger.error('Missing metadata in checkout session', { sessionId: session.id })
      return
    }
    
    // Update organization with subscription info
    await this.updateOrganizationSubscription(organizationId, {
      subscriptionId: session.subscription as string,
      currentPlan: planId,
      subscriptionStatus: 'active'
    })
    
    this.emit('subscription_activated', { organizationId, planId })
  }
  
  /**
   * Handle subscription created
   */
  private async handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
    const organizationId = subscription.metadata?.organizationId
    
    if (!organizationId) return
    
    await this.updateCustomerSubscription(organizationId, subscription)
    this.emit('subscription_created', { organizationId, subscriptionId: subscription.id })
  }
  
  /**
   * Handle subscription updated
   */
  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const organizationId = subscription.metadata?.organizationId
    
    if (!organizationId) return
    
    await this.updateCustomerSubscription(organizationId, subscription)
    this.emit('subscription_updated', { organizationId, subscriptionId: subscription.id })
  }
  
  /**
   * Handle subscription deleted
   */
  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const organizationId = subscription.metadata?.organizationId
    
    if (!organizationId) return
    
    // Downgrade to free plan
    await this.updateOrganizationSubscription(organizationId, {
      subscriptionId: null,
      currentPlan: 'free',
      subscriptionStatus: 'canceled'
    })
    
    this.emit('subscription_canceled', { organizationId, subscriptionId: subscription.id })
  }
  
  /**
   * Handle successful payment
   */
  private async handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string
    
    // Get organization from customer
    const { data: customer } = await this.supabase
      .from('billing_customers')
      .select('organization_id')
      .eq('stripe_customer_id', customerId)
      .single()
    
    if (customer) {
      this.emit('payment_succeeded', {
        organizationId: customer.organization_id,
        amount: invoice.amount_paid,
        currency: invoice.currency
      })
    }
  }
  
  /**
   * Handle failed payment
   */
  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string
    
    // Get organization from customer
    const { data: customer } = await this.supabase
      .from('billing_customers')
      .select('organization_id, email')
      .eq('stripe_customer_id', customerId)
      .single()
    
    if (customer) {
      // Send notification about failed payment
      this.emit('payment_failed', {
        organizationId: customer.organization_id,
        email: customer.email,
        amount: invoice.amount_due,
        currency: invoice.currency
      })
    }
  }
  
  /**
   * Handle trial ending soon
   */
  private async handleTrialWillEnd(subscription: Stripe.Subscription): Promise<void> {
    const organizationId = subscription.metadata?.organizationId
    
    if (organizationId) {
      this.emit('trial_ending', { organizationId, endsAt: subscription.trial_end })
    }
  }
  
  /**
   * Update customer subscription info
   */
  private async updateCustomerSubscription(
    organizationId: string,
    subscription: Stripe.Subscription
  ): Promise<void> {
    const plan = this.getPlanByPriceId(subscription.items.data[0].price.id)
    
    await this.supabase
      .from('billing_customers')
      .update({
        subscription_id: subscription.id,
        subscription_status: subscription.status,
        current_plan: plan?.id || 'free',
        billing_cycle: subscription.items.data[0].price.recurring?.interval === 'year' ? 'yearly' : 'monthly',
        next_billing_date: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
        trialing: subscription.status === 'trialing',
        trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
      })
      .eq('organization_id', organizationId)
    
    // Update organization limits
    if (plan) {
      await this.updateOrganizationLimits(organizationId, plan)
    }
  }
  
  /**
   * Update organization subscription
   */
  private async updateOrganizationSubscription(
    organizationId: string,
    update: {
      subscriptionId?: string | null
      currentPlan?: string
      subscriptionStatus?: string
    }
  ): Promise<void> {
    await this.supabase
      .from('organizations')
      .update({
        subscription_tier: update.currentPlan
      })
      .eq('id', organizationId)
    
    await this.supabase
      .from('billing_customers')
      .update({
        subscription_id: update.subscriptionId,
        subscription_status: update.subscriptionStatus,
        current_plan: update.currentPlan
      })
      .eq('organization_id', organizationId)
  }
  
  /**
   * Update organization limits based on plan
   */
  private async updateOrganizationLimits(
    organizationId: string,
    plan: SubscriptionPlan
  ): Promise<void> {
    await this.supabase
      .from('organizations')
      .update({
        max_users: plan.maxUsers,
        max_integrations: plan.maxIntegrations,
        max_syncs_per_month: plan.maxSyncsPerMonth,
        subscription_tier: plan.id
      })
      .eq('id', organizationId)
  }
  
  /**
   * Get plan by price ID
   */
  private getPlanByPriceId(priceId: string): SubscriptionPlan | undefined {
    return this.plans.find(p => p.priceId === priceId)
  }
  
  /**
   * Get all available plans
   */
  getPlans(): SubscriptionPlan[] {
    return this.plans
  }
  
  /**
   * Get plan by ID
   */
  getPlan(planId: string): SubscriptionPlan | undefined {
    return this.plans.find(p => p.id === planId)
  }
  
  /**
   * Check if organization can perform action based on limits
   */
  async checkLimits(organizationId: string, action: 'add_user' | 'add_integration' | 'sync'): Promise<boolean> {
    const customer = await this.getCustomer(organizationId)
    const plan = customer?.currentPlan ? this.getPlan(customer.currentPlan) : this.getPlan('free')
    
    if (!plan) return false
    
    const { data: org } = await this.supabase
      .from('organizations')
      .select('*')
      .eq('id', organizationId)
      .single()
    
    if (!org) return false
    
    switch (action) {
      case 'add_user':
        if (plan.maxUsers === -1) return true
        const { count: userCount } = await this.supabase
          .from('users')
          .select('*', { count: 'exact' })
          .eq('organization_id', organizationId)
        return (userCount || 0) < plan.maxUsers
      
      case 'add_integration':
        if (plan.maxIntegrations === -1) return true
        const { count: integrationCount } = await this.supabase
          .from('crm_integrations')
          .select('*', { count: 'exact' })
          .eq('organization_id', organizationId)
          .eq('is_active', true)
        return (integrationCount || 0) < plan.maxIntegrations
      
      case 'sync':
        if (plan.maxSyncsPerMonth === -1) return true
        // Check current month sync count
        const startOfMonth = new Date()
        startOfMonth.setDate(1)
        startOfMonth.setHours(0, 0, 0, 0)
        
        const { count: syncCount } = await this.supabase
          .from('sync_logs')
          .select('*', { count: 'exact' })
          .eq('organization_id', organizationId)
          .gte('created_at', startOfMonth.toISOString())
        
        return (syncCount || 0) < plan.maxSyncsPerMonth
      
      default:
        return true
    }
  }
  
  /**
   * Get usage metrics for organization
   */
  async getUsageMetrics(organizationId: string): Promise<UsageMetrics> {
    const currentMonth = new Date()
    currentMonth.setDate(1)
    currentMonth.setHours(0, 0, 0, 0)
    
    const [users, integrations, syncs] = await Promise.all([
      this.supabase
        .from('users')
        .select('*', { count: 'exact' })
        .eq('organization_id', organizationId),
      
      this.supabase
        .from('crm_integrations')
        .select('*', { count: 'exact' })
        .eq('organization_id', organizationId)
        .eq('is_active', true),
      
      this.supabase
        .from('sync_logs')
        .select('*', { count: 'exact' })
        .eq('organization_id', organizationId)
        .gte('created_at', currentMonth.toISOString())
    ])
    
    return {
      organizationId,
      period: currentMonth.toISOString().slice(0, 7), // YYYY-MM format
      totalUsers: users.count || 0,
      totalIntegrations: integrations.count || 0,
      totalSyncs: syncs.count || 0,
      storageUsed: 0, // TODO: Calculate storage usage
      apiCalls: 0 // TODO: Calculate API calls
    }
  }
  
  /**
   * Generate invoice preview for plan change
   */
  async previewPlanChange(organizationId: string, newPlanId: string): Promise<any> {
    const customer = await this.getCustomer(organizationId)
    if (!customer?.subscriptionId) {
      throw new Error('No active subscription')
    }
    
    const newPlan = this.getPlan(newPlanId)
    if (!newPlan || !newPlan.priceId) {
      throw new Error('Invalid plan')
    }
    
    const subscription = await this.stripe.subscriptions.retrieve(customer.subscriptionId)
    
    const invoice = await this.stripe.invoices.createPreview({
      customer: customer.stripeCustomerId,
      subscription: customer.subscriptionId,
      subscription_items: [
        {
          id: subscription.items.data[0].id,
          price: newPlan.priceId,
          quantity: 1
        }
      ],
      subscription_proration_behavior: 'always_invoice'
    })
    
    return {
      subtotal: invoice.subtotal,
      total: invoice.total,
      amountDue: invoice.amount_due,
      currency: invoice.currency,
      lines: invoice.lines.data
    }
  }
}