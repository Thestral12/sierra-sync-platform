-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create enum types
CREATE TYPE crm_type AS ENUM ('hubspot', 'salesforce', 'zoho', 'pipedrive', 'monday');
CREATE TYPE sync_status AS ENUM ('pending', 'in_progress', 'completed', 'failed', 'partial');
CREATE TYPE lead_status AS ENUM ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost');
CREATE TYPE webhook_event AS ENUM ('lead.created', 'lead.updated', 'lead.deleted', 'deal.created', 'deal.updated', 'contact.created', 'contact.updated');
CREATE TYPE subscription_tier AS ENUM ('free', 'starter', 'professional', 'enterprise');

-- Organizations (Tenants) table
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    subscription_tier subscription_tier DEFAULT 'free',
    max_users INTEGER DEFAULT 5,
    max_integrations INTEGER DEFAULT 2,
    max_syncs_per_month INTEGER DEFAULT 1000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    settings JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}'
);

-- Users table with RLS
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'member',
    avatar_url TEXT,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    settings JSONB DEFAULT '{}',
    INDEX idx_users_org (organization_id),
    INDEX idx_users_email (email)
);

-- CRM Integrations configuration
CREATE TABLE crm_integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    crm_type crm_type NOT NULL,
    name VARCHAR(255) NOT NULL,
    api_key_encrypted TEXT,
    oauth_tokens JSONB,
    webhook_secret VARCHAR(255),
    webhook_url TEXT,
    field_mappings JSONB DEFAULT '{}',
    sync_settings JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    last_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, crm_type),
    INDEX idx_integrations_org (organization_id),
    INDEX idx_integrations_active (is_active)
);

-- Sierra Interactive configuration
CREATE TABLE sierra_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    api_key_encrypted TEXT NOT NULL,
    api_url TEXT DEFAULT 'https://api.sierrainteractive.com',
    site_id VARCHAR(255),
    webhook_secret VARCHAR(255),
    webhook_endpoints JSONB DEFAULT '[]',
    sync_settings JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    last_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id),
    INDEX idx_sierra_org (organization_id)
);

-- Leads master table
CREATE TABLE leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    sierra_id VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    lead_source VARCHAR(255),
    lead_score INTEGER DEFAULT 0,
    status lead_status DEFAULT 'new',
    assigned_to UUID REFERENCES users(id),
    property_interests JSONB DEFAULT '[]',
    tags TEXT[] DEFAULT '{}',
    custom_fields JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ,
    INDEX idx_leads_org (organization_id),
    INDEX idx_leads_email (email),
    INDEX idx_leads_sierra (sierra_id),
    INDEX idx_leads_status (status),
    INDEX idx_leads_score (lead_score DESC)
);

-- CRM sync mappings
CREATE TABLE crm_sync_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    crm_integration_id UUID REFERENCES crm_integrations(id) ON DELETE CASCADE,
    crm_record_id VARCHAR(255) NOT NULL,
    crm_record_type VARCHAR(50) DEFAULT 'lead',
    last_synced_at TIMESTAMPTZ,
    sync_status sync_status DEFAULT 'pending',
    sync_errors JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(lead_id, crm_integration_id),
    INDEX idx_sync_mappings_lead (lead_id),
    INDEX idx_sync_mappings_crm (crm_integration_id),
    INDEX idx_sync_mappings_status (sync_status)
);

-- Sync logs for audit trail
CREATE TABLE sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    crm_integration_id UUID REFERENCES crm_integrations(id) ON DELETE SET NULL,
    event_type webhook_event NOT NULL,
    direction VARCHAR(20) CHECK (direction IN ('inbound', 'outbound')),
    status sync_status NOT NULL,
    request_data JSONB,
    response_data JSONB,
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    INDEX idx_sync_logs_org (organization_id),
    INDEX idx_sync_logs_created (created_at DESC),
    INDEX idx_sync_logs_status (status)
);

-- Workflow templates
CREATE TABLE workflow_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    n8n_workflow_id VARCHAR(255),
    workflow_json JSONB NOT NULL,
    trigger_conditions JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    is_system BOOLEAN DEFAULT false,
    execution_count INTEGER DEFAULT 0,
    last_executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    INDEX idx_workflows_org (organization_id),
    INDEX idx_workflows_active (is_active)
);

-- Lead routing rules
CREATE TABLE lead_routing_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    priority INTEGER DEFAULT 0,
    conditions JSONB NOT NULL,
    assignment_rules JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    INDEX idx_routing_org (organization_id),
    INDEX idx_routing_priority (priority),
    INDEX idx_routing_active (is_active)
);

-- Notifications and alerts
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT,
    data JSONB DEFAULT '{}',
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    INDEX idx_notifications_user (user_id),
    INDEX idx_notifications_unread (user_id, is_read),
    INDEX idx_notifications_created (created_at DESC)
);

-- API keys for external access
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) UNIQUE NOT NULL,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    scopes TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    INDEX idx_api_keys_org (organization_id),
    INDEX idx_api_keys_hash (key_hash)
);

-- Metrics and analytics
CREATE TABLE sync_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    total_syncs INTEGER DEFAULT 0,
    successful_syncs INTEGER DEFAULT 0,
    failed_syncs INTEGER DEFAULT 0,
    average_sync_time_ms INTEGER,
    leads_created INTEGER DEFAULT 0,
    leads_updated INTEGER DEFAULT 0,
    error_rate DECIMAL(5,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, date),
    INDEX idx_metrics_org_date (organization_id, date DESC)
);

-- Create functions for updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers to all tables
CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_crm_integrations_updated_at BEFORE UPDATE ON crm_integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sierra_configs_updated_at BEFORE UPDATE ON sierra_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workflow_templates_updated_at BEFORE UPDATE ON workflow_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security Policies
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sierra_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- RLS Policies for organizations
CREATE POLICY "Users can view their own organization" ON organizations
    FOR SELECT USING (auth.uid() IN (
        SELECT id FROM users WHERE organization_id = organizations.id
    ));

CREATE POLICY "Users can update their own organization" ON organizations
    FOR UPDATE USING (auth.uid() IN (
        SELECT id FROM users WHERE organization_id = organizations.id AND role IN ('admin', 'owner')
    ));

-- RLS Policies for users
CREATE POLICY "Users can view users in their organization" ON users
    FOR SELECT USING (organization_id IN (
        SELECT organization_id FROM users WHERE id = auth.uid()
    ));

CREATE POLICY "Users can update their own profile" ON users
    FOR UPDATE USING (id = auth.uid());

-- RLS Policies for leads
CREATE POLICY "Users can view leads in their organization" ON leads
    FOR SELECT USING (organization_id IN (
        SELECT organization_id FROM users WHERE id = auth.uid()
    ));

CREATE POLICY "Users can manage leads in their organization" ON leads
    FOR ALL USING (organization_id IN (
        SELECT organization_id FROM users WHERE id = auth.uid()
    ));

-- Create indexes for performance
CREATE INDEX idx_leads_full_text ON leads USING gin(
    to_tsvector('english', coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email, ''))
);

-- Create materialized view for dashboard metrics
CREATE MATERIALIZED VIEW dashboard_metrics AS
SELECT 
    o.id as organization_id,
    COUNT(DISTINCT l.id) as total_leads,
    COUNT(DISTINCT l.id) FILTER (WHERE l.created_at >= NOW() - INTERVAL '24 hours') as leads_today,
    COUNT(DISTINCT l.id) FILTER (WHERE l.created_at >= NOW() - INTERVAL '7 days') as leads_week,
    COUNT(DISTINCT sm.id) FILTER (WHERE sm.sync_status = 'completed') as successful_syncs,
    COUNT(DISTINCT sm.id) FILTER (WHERE sm.sync_status = 'failed') as failed_syncs,
    AVG(l.lead_score) as avg_lead_score,
    COUNT(DISTINCT ci.id) as active_integrations
FROM organizations o
LEFT JOIN leads l ON l.organization_id = o.id
LEFT JOIN crm_sync_mappings sm ON sm.lead_id = l.id
LEFT JOIN crm_integrations ci ON ci.organization_id = o.id AND ci.is_active = true
GROUP BY o.id;

-- Create index on materialized view
CREATE UNIQUE INDEX idx_dashboard_metrics_org ON dashboard_metrics(organization_id);

-- Refresh materialized view every hour
SELECT cron.schedule('refresh-dashboard-metrics', '0 * * * *', $$
    REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_metrics;
$$);