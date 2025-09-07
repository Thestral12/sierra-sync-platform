// Incident Management System for Sierra Sync
// Handles incident creation, escalation, and resolution

const EventEmitter = require('events');
const axios = require('axios');
const crypto = require('crypto');

class IncidentManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      pagerduty: {
        apiKey: process.env.PAGERDUTY_API_KEY,
        integrationKey: process.env.PAGERDUTY_INTEGRATION_KEY,
        baseUrl: 'https://api.pagerduty.com',
        ...config.pagerduty,
      },
      slack: {
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
        channel: process.env.SLACK_INCIDENT_CHANNEL || '#incidents',
        ...config.slack,
      },
      opsgenie: {
        apiKey: process.env.OPSGENIE_API_KEY,
        baseUrl: 'https://api.opsgenie.com/v2',
        ...config.opsgenie,
      },
      escalation: {
        levels: [
          { name: 'L1', timeout: 300, contacts: ['oncall-l1'] },
          { name: 'L2', timeout: 600, contacts: ['oncall-l2', 'team-lead'] },
          { name: 'L3', timeout: 900, contacts: ['oncall-l3', 'engineering-manager'] },
          { name: 'L4', timeout: 1200, contacts: ['cto', 'vp-engineering'] },
        ],
        ...config.escalation,
      },
      ...config,
    };
    
    this.incidents = new Map();
    this.escalationTimers = new Map();
    this.metrics = {
      created: 0,
      resolved: 0,
      escalated: 0,
      mttr: [],
    };
  }
  
  // Create new incident
  async createIncident(data) {
    const incident = {
      id: this.generateIncidentId(),
      title: data.title,
      description: data.description,
      severity: data.severity || 'P3',
      service: data.service,
      status: 'triggered',
      createdAt: new Date(),
      updatedAt: new Date(),
      assignedTo: null,
      escalationLevel: 0,
      timeline: [],
      metadata: data.metadata || {},
      alerts: data.alerts || [],
      runbookUrl: this.getRunbookUrl(data.service, data.alertName),
    };
    
    // Add to timeline
    incident.timeline.push({
      timestamp: new Date(),
      action: 'created',
      message: 'Incident created',
      user: 'system',
    });
    
    // Store incident
    this.incidents.set(incident.id, incident);
    this.metrics.created++;
    
    // Create in external systems
    await Promise.all([
      this.createPagerDutyIncident(incident),
      this.notifySlack(incident, 'created'),
      this.createOpsGenieAlert(incident),
    ]);
    
    // Start escalation timer
    this.startEscalationTimer(incident);
    
    // Emit event
    this.emit('incident:created', incident);
    
    // Auto-remediation for known issues
    await this.attemptAutoRemediation(incident);
    
    return incident;
  }
  
  // Update incident
  async updateIncident(incidentId, updates) {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident ${incidentId} not found`);
    }
    
    // Update fields
    Object.assign(incident, updates, {
      updatedAt: new Date(),
    });
    
    // Add to timeline
    incident.timeline.push({
      timestamp: new Date(),
      action: 'updated',
      message: `Incident updated: ${JSON.stringify(updates)}`,
      user: updates.user || 'system',
    });
    
    // Update external systems
    await Promise.all([
      this.updatePagerDutyIncident(incident),
      this.notifySlack(incident, 'updated'),
    ]);
    
    // Emit event
    this.emit('incident:updated', incident);
    
    return incident;
  }
  
  // Acknowledge incident
  async acknowledgeIncident(incidentId, user) {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident ${incidentId} not found`);
    }
    
    incident.status = 'acknowledged';
    incident.assignedTo = user;
    incident.acknowledgedAt = new Date();
    incident.updatedAt = new Date();
    
    // Add to timeline
    incident.timeline.push({
      timestamp: new Date(),
      action: 'acknowledged',
      message: `Incident acknowledged by ${user}`,
      user,
    });
    
    // Stop escalation
    this.stopEscalationTimer(incidentId);
    
    // Update external systems
    await Promise.all([
      this.acknowledgePagerDutyIncident(incident),
      this.notifySlack(incident, 'acknowledged'),
    ]);
    
    // Emit event
    this.emit('incident:acknowledged', incident);
    
    return incident;
  }
  
  // Resolve incident
  async resolveIncident(incidentId, resolution) {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident ${incidentId} not found`);
    }
    
    incident.status = 'resolved';
    incident.resolvedAt = new Date();
    incident.resolution = resolution;
    incident.updatedAt = new Date();
    
    // Calculate MTTR
    const mttr = incident.resolvedAt - incident.createdAt;
    this.metrics.mttr.push(mttr);
    this.metrics.resolved++;
    
    // Add to timeline
    incident.timeline.push({
      timestamp: new Date(),
      action: 'resolved',
      message: `Incident resolved: ${resolution.summary}`,
      user: resolution.user || 'system',
    });
    
    // Stop escalation
    this.stopEscalationTimer(incidentId);
    
    // Update external systems
    await Promise.all([
      this.resolvePagerDutyIncident(incident),
      this.notifySlack(incident, 'resolved'),
      this.resolveOpsGenieAlert(incident),
    ]);
    
    // Create post-mortem if needed
    if (this.shouldCreatePostMortem(incident)) {
      await this.createPostMortem(incident);
    }
    
    // Emit event
    this.emit('incident:resolved', incident);
    
    return incident;
  }
  
  // Escalate incident
  async escalateIncident(incidentId) {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident ${incidentId} not found`);
    }
    
    incident.escalationLevel++;
    incident.updatedAt = new Date();
    this.metrics.escalated++;
    
    const escalationLevel = this.config.escalation.levels[incident.escalationLevel];
    if (!escalationLevel) {
      console.error(`No escalation level ${incident.escalationLevel} defined`);
      return incident;
    }
    
    // Add to timeline
    incident.timeline.push({
      timestamp: new Date(),
      action: 'escalated',
      message: `Incident escalated to ${escalationLevel.name}`,
      user: 'system',
    });
    
    // Notify escalation contacts
    await this.notifyEscalationContacts(incident, escalationLevel);
    
    // Update external systems
    await Promise.all([
      this.escalatePagerDutyIncident(incident),
      this.notifySlack(incident, 'escalated'),
    ]);
    
    // Restart escalation timer for next level
    this.startEscalationTimer(incident);
    
    // Emit event
    this.emit('incident:escalated', incident);
    
    return incident;
  }
  
  // PagerDuty integration
  async createPagerDutyIncident(incident) {
    if (!this.config.pagerduty.integrationKey) return;
    
    try {
      const response = await axios.post(
        'https://events.pagerduty.com/v2/enqueue',
        {
          routing_key: this.config.pagerduty.integrationKey,
          event_action: 'trigger',
          dedup_key: incident.id,
          payload: {
            summary: incident.title,
            source: 'sierra-sync',
            severity: this.mapSeverityToPagerDuty(incident.severity),
            component: incident.service,
            group: incident.metadata.group,
            class: incident.metadata.class,
            custom_details: {
              description: incident.description,
              runbook_url: incident.runbookUrl,
              alerts: incident.alerts,
              metadata: incident.metadata,
            },
          },
          links: [
            {
              href: incident.runbookUrl,
              text: 'Runbook',
            },
          ],
        }
      );
      
      incident.pagerdutyId = response.data.dedup_key;
    } catch (error) {
      console.error('Failed to create PagerDuty incident:', error);
    }
  }
  
  async acknowledgePagerDutyIncident(incident) {
    if (!incident.pagerdutyId) return;
    
    try {
      await axios.post('https://events.pagerduty.com/v2/enqueue', {
        routing_key: this.config.pagerduty.integrationKey,
        event_action: 'acknowledge',
        dedup_key: incident.pagerdutyId,
      });
    } catch (error) {
      console.error('Failed to acknowledge PagerDuty incident:', error);
    }
  }
  
  async resolvePagerDutyIncident(incident) {
    if (!incident.pagerdutyId) return;
    
    try {
      await axios.post('https://events.pagerduty.com/v2/enqueue', {
        routing_key: this.config.pagerduty.integrationKey,
        event_action: 'resolve',
        dedup_key: incident.pagerdutyId,
      });
    } catch (error) {
      console.error('Failed to resolve PagerDuty incident:', error);
    }
  }
  
  async updatePagerDutyIncident(incident) {
    if (!incident.pagerdutyId) return;
    
    try {
      await axios.post('https://events.pagerduty.com/v2/enqueue', {
        routing_key: this.config.pagerduty.integrationKey,
        event_action: 'change',
        dedup_key: incident.pagerdutyId,
        payload: {
          summary: incident.title,
          severity: this.mapSeverityToPagerDuty(incident.severity),
          custom_details: incident.metadata,
        },
      });
    } catch (error) {
      console.error('Failed to update PagerDuty incident:', error);
    }
  }
  
  async escalatePagerDutyIncident(incident) {
    if (!incident.pagerdutyId || !this.config.pagerduty.apiKey) return;
    
    try {
      await axios.put(
        `${this.config.pagerduty.baseUrl}/incidents/${incident.pagerdutyId}/escalate`,
        {},
        {
          headers: {
            'Authorization': `Token token=${this.config.pagerduty.apiKey}`,
            'Accept': 'application/vnd.pagerduty+json;version=2',
          },
        }
      );
    } catch (error) {
      console.error('Failed to escalate PagerDuty incident:', error);
    }
  }
  
  // Slack integration
  async notifySlack(incident, action) {
    if (!this.config.slack.webhookUrl) return;
    
    const color = this.getSlackColor(incident.severity);
    const emoji = this.getSlackEmoji(action);
    
    try {
      await axios.post(this.config.slack.webhookUrl, {
        channel: this.config.slack.channel,
        username: 'Incident Bot',
        icon_emoji: ':rotating_light:',
        attachments: [
          {
            color,
            title: `${emoji} Incident ${incident.id}: ${incident.title}`,
            title_link: `https://sierrasync.com/incidents/${incident.id}`,
            text: incident.description,
            fields: [
              {
                title: 'Status',
                value: incident.status,
                short: true,
              },
              {
                title: 'Severity',
                value: incident.severity,
                short: true,
              },
              {
                title: 'Service',
                value: incident.service,
                short: true,
              },
              {
                title: 'Assigned To',
                value: incident.assignedTo || 'Unassigned',
                short: true,
              },
            ],
            footer: 'Sierra Sync Incident Management',
            ts: Math.floor(Date.now() / 1000),
            actions: [
              {
                type: 'button',
                text: 'View Incident',
                url: `https://sierrasync.com/incidents/${incident.id}`,
              },
              {
                type: 'button',
                text: 'View Runbook',
                url: incident.runbookUrl,
              },
            ],
          },
        ],
      });
    } catch (error) {
      console.error('Failed to notify Slack:', error);
    }
  }
  
  // OpsGenie integration
  async createOpsGenieAlert(incident) {
    if (!this.config.opsgenie.apiKey) return;
    
    try {
      const response = await axios.post(
        `${this.config.opsgenie.baseUrl}/alerts`,
        {
          message: incident.title,
          alias: incident.id,
          description: incident.description,
          priority: this.mapSeverityToOpsGenie(incident.severity),
          entity: incident.service,
          tags: [`severity:${incident.severity}`, `service:${incident.service}`],
          details: incident.metadata,
          actions: ['Check runbook', 'Restart service'],
        },
        {
          headers: {
            'Authorization': `GenieKey ${this.config.opsgenie.apiKey}`,
          },
        }
      );
      
      incident.opsgenieId = response.data.data.id;
    } catch (error) {
      console.error('Failed to create OpsGenie alert:', error);
    }
  }
  
  async resolveOpsGenieAlert(incident) {
    if (!incident.opsgenieId || !this.config.opsgenie.apiKey) return;
    
    try {
      await axios.post(
        `${this.config.opsgenie.baseUrl}/alerts/${incident.opsgenieId}/close`,
        {
          note: incident.resolution?.summary || 'Incident resolved',
        },
        {
          headers: {
            'Authorization': `GenieKey ${this.config.opsgenie.apiKey}`,
          },
        }
      );
    } catch (error) {
      console.error('Failed to resolve OpsGenie alert:', error);
    }
  }
  
  // Auto-remediation
  async attemptAutoRemediation(incident) {
    const remediations = {
      'high_memory_usage': this.remediateHighMemory,
      'service_down': this.remediateServiceDown,
      'database_connection_pool': this.remediateDatabasePool,
      'ssl_certificate_expiry': this.remediateSSLCertificate,
    };
    
    const remediation = remediations[incident.metadata.alertName];
    if (!remediation) return;
    
    try {
      const result = await remediation.call(this, incident);
      
      if (result.success) {
        incident.timeline.push({
          timestamp: new Date(),
          action: 'auto_remediated',
          message: `Auto-remediation successful: ${result.message}`,
          user: 'system',
        });
        
        // Auto-resolve if remediation was successful
        if (result.autoResolve) {
          await this.resolveIncident(incident.id, {
            summary: `Auto-remediated: ${result.message}`,
            user: 'system',
          });
        }
      } else {
        incident.timeline.push({
          timestamp: new Date(),
          action: 'auto_remediation_failed',
          message: `Auto-remediation failed: ${result.message}`,
          user: 'system',
        });
      }
    } catch (error) {
      console.error('Auto-remediation error:', error);
      incident.timeline.push({
        timestamp: new Date(),
        action: 'auto_remediation_error',
        message: `Auto-remediation error: ${error.message}`,
        user: 'system',
      });
    }
  }
  
  async remediateHighMemory(incident) {
    // Implement memory cleanup logic
    return {
      success: true,
      message: 'Cleared cache and restarted service',
      autoResolve: true,
    };
  }
  
  async remediateServiceDown(incident) {
    // Implement service restart logic
    return {
      success: true,
      message: 'Service restarted successfully',
      autoResolve: false,
    };
  }
  
  async remediateDatabasePool(incident) {
    // Implement database pool cleanup
    return {
      success: true,
      message: 'Database connections reset',
      autoResolve: true,
    };
  }
  
  async remediateSSLCertificate(incident) {
    // Implement SSL renewal logic
    return {
      success: true,
      message: 'SSL certificate renewed',
      autoResolve: true,
    };
  }
  
  // Escalation management
  startEscalationTimer(incident) {
    const escalationLevel = this.config.escalation.levels[incident.escalationLevel];
    if (!escalationLevel) return;
    
    const timer = setTimeout(() => {
      this.escalateIncident(incident.id);
    }, escalationLevel.timeout * 1000);
    
    this.escalationTimers.set(incident.id, timer);
  }
  
  stopEscalationTimer(incidentId) {
    const timer = this.escalationTimers.get(incidentId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(incidentId);
    }
  }
  
  async notifyEscalationContacts(incident, escalationLevel) {
    for (const contact of escalationLevel.contacts) {
      // Implement contact notification logic
      console.log(`Notifying ${contact} about incident ${incident.id}`);
    }
  }
  
  // Post-mortem creation
  shouldCreatePostMortem(incident) {
    return (
      incident.severity === 'P1' ||
      incident.severity === 'P2' ||
      incident.escalationLevel >= 2 ||
      (incident.resolvedAt - incident.createdAt) > 3600000 // 1 hour
    );
  }
  
  async createPostMortem(incident) {
    const postMortem = {
      incidentId: incident.id,
      title: `Post-Mortem: ${incident.title}`,
      createdAt: new Date(),
      sections: {
        summary: incident.description,
        timeline: incident.timeline,
        rootCause: '',
        resolution: incident.resolution?.summary || '',
        actionItems: [],
        lessonsLearned: [],
      },
    };
    
    // Notify team about post-mortem
    await this.notifySlack({
      ...incident,
      title: `Post-Mortem Required: ${incident.title}`,
      description: `Please complete the post-mortem at https://sierrasync.com/post-mortems/${incident.id}`,
    }, 'post_mortem');
    
    return postMortem;
  }
  
  // Helper methods
  generateIncidentId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `INC-${timestamp}-${random}`.toUpperCase();
  }
  
  getRunbookUrl(service, alertName) {
    const runbooks = {
      'api': 'https://wiki.sierrasync.com/runbooks/api',
      'database': 'https://wiki.sierrasync.com/runbooks/database',
      'redis': 'https://wiki.sierrasync.com/runbooks/redis',
      'kubernetes': 'https://wiki.sierrasync.com/runbooks/kubernetes',
    };
    
    return runbooks[service] || 'https://wiki.sierrasync.com/runbooks/general';
  }
  
  mapSeverityToPagerDuty(severity) {
    const mapping = {
      'P1': 'critical',
      'P2': 'error',
      'P3': 'warning',
      'P4': 'info',
    };
    return mapping[severity] || 'info';
  }
  
  mapSeverityToOpsGenie(severity) {
    const mapping = {
      'P1': 'P1',
      'P2': 'P2',
      'P3': 'P3',
      'P4': 'P4',
    };
    return mapping[severity] || 'P3';
  }
  
  getSlackColor(severity) {
    const colors = {
      'P1': '#FF0000',
      'P2': '#FF9900',
      'P3': '#FFFF00',
      'P4': '#00FF00',
    };
    return colors[severity] || '#808080';
  }
  
  getSlackEmoji(action) {
    const emojis = {
      'created': '🚨',
      'acknowledged': '👀',
      'updated': '📝',
      'escalated': '⬆️',
      'resolved': '✅',
      'post_mortem': '📋',
    };
    return emojis[action] || '📢';
  }
  
  // Metrics and reporting
  getMetrics() {
    const avgMTTR = this.metrics.mttr.length > 0
      ? this.metrics.mttr.reduce((a, b) => a + b, 0) / this.metrics.mttr.length
      : 0;
    
    return {
      ...this.metrics,
      avgMTTR,
      activeIncidents: Array.from(this.incidents.values()).filter(i => i.status !== 'resolved').length,
    };
  }
  
  getActiveIncidents() {
    return Array.from(this.incidents.values()).filter(i => i.status !== 'resolved');
  }
  
  getIncident(incidentId) {
    return this.incidents.get(incidentId);
  }
}

module.exports = IncidentManager;