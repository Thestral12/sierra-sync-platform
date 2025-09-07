# Sierra Sync Platform - Real Estate CRM Integration SaaS

A comprehensive SaaS platform that automates real-time lead and sales data syncing between Sierra Interactive and popular CRMs (HubSpot, Salesforce, Zoho) using n8n workflow automation.

## 🚀 Features

### Core Functionality
- **Real-time Bidirectional Sync**: Automatic synchronization of leads, contacts, and deals between Sierra Interactive and multiple CRMs
- **Multi-CRM Support**: Connect HubSpot, Salesforce, Zoho, and more simultaneously
- **Smart Lead Routing**: Auto-assign leads based on geography, lead score, or custom rules
- **Automated Follow-ups**: Trigger personalized email/SMS campaigns for new leads
- **High-Value Alerts**: Instant notifications for hot leads via Slack/email
- **Deal Pipeline Updates**: Automatic CRM pipeline updates from Sierra transactions

### Technical Features
- **OAuth 2.0 Authentication**: Secure integration with all platforms
- **Webhook-based Real-time Updates**: Instant sync on data changes
- **Rate Limit Management**: Intelligent handling of API limits
- **Error Recovery**: Automatic retry with exponential backoff
- **Multi-tenant Architecture**: Isolated data for each customer
- **Comprehensive Monitoring**: Real-time dashboard with metrics

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Web Dashboard                        │
│                  (Next.js + shadcn/ui)                  │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                    API Backend                           │
│                  (Node.js + Express)                     │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │  Auth    │  │ Webhook  │  │  Queue   │             │
│  │ Service  │  │ Handler  │  │ Manager  │             │
│  └──────────┘  └──────────┘  └──────────┘             │
└────────┬──────────────┬──────────────┬─────────────────┘
         │              │              │
┌────────▼──────────────▼──────────────▼─────────────────┐
│                    n8n Workflows                         │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Lead Sync    │  │ Lead Routing │  │ Follow-up    │ │
│  │ Workflow     │  │ Workflow     │  │ Automation   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└────────┬──────────────┬──────────────┬─────────────────┘
         │              │              │
┌────────▼──────────────▼──────────────▼─────────────────┐
│              External Integrations                       │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │  Sierra  │  │ HubSpot  │  │Salesforce│             │
│  │Interactive│  │   API    │  │   API    │             │
│  └──────────┘  └──────────┘  └──────────┘             │
└──────────────────────────────────────────────────────────┘
```

## 🚦 Quick Start

### Prerequisites
- Node.js 18+ and npm
- Docker and Docker Compose
- Supabase CLI
- n8n instance (included in Docker setup)

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/yourusername/sierra-sync-platform.git
cd sierra-sync-platform
```

2. **Install dependencies**
```bash
npm install
cd web-ui && npm install
cd ../src/api && npm install
cd ../..
```

3. **Set up environment variables**
```bash
cp .env.example .env
# Edit .env with your credentials
```

4. **Start Docker services**
```bash
docker-compose up -d
```

5. **Run database migrations**
```bash
npx supabase migration up
```

6. **Start development servers**
```bash
npm run dev
```

The application will be available at:
- Web Dashboard: http://localhost:3000
- API Backend: http://localhost:3001
- n8n Workflows: http://localhost:5678

## 🧪 Test-Driven Development

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration

# Run E2E tests with Playwright
npm run test:e2e

# Watch mode for development
npm run test:watch
```

### Test Coverage

The platform includes comprehensive test coverage:
- **Unit Tests**: API services, data transformations, utilities
- **Integration Tests**: End-to-end sync scenarios, webhook handling
- **E2E Tests**: Complete user workflows using Playwright
- **Performance Tests**: Load testing and rate limit validation

## 📚 API Documentation

### Authentication

All API endpoints require authentication via Bearer token:

```http
Authorization: Bearer YOUR_API_TOKEN
```

### Core Endpoints

#### Organizations
- `GET /api/organizations` - List organizations
- `POST /api/organizations` - Create organization
- `GET /api/organizations/:id` - Get organization details
- `PUT /api/organizations/:id` - Update organization

#### Integrations
- `GET /api/integrations` - List CRM integrations
- `POST /api/integrations` - Add new integration
- `PUT /api/integrations/:id` - Update integration
- `DELETE /api/integrations/:id` - Remove integration
- `POST /api/integrations/:id/test` - Test connection

#### Leads
- `GET /api/leads` - List synced leads
- `GET /api/leads/:id` - Get lead details
- `POST /api/leads/:id/sync` - Trigger manual sync
- `GET /api/leads/:id/history` - Get sync history

#### Webhooks
- `POST /api/webhooks/sierra` - Sierra Interactive webhook
- `POST /api/webhooks/hubspot` - HubSpot webhook
- `POST /api/webhooks/salesforce` - Salesforce webhook

#### Sync Operations
- `POST /api/sync/trigger` - Trigger manual full sync
- `GET /api/sync/status` - Get current sync status
- `GET /api/sync/logs` - Get sync logs
- `GET /api/sync/metrics` - Get sync metrics

## 🔧 Configuration

### n8n Workflow Configuration

Workflows are stored in `/n8n-workflows/templates/`:
- `sierra-to-crm-sync.json` - Main sync workflow
- `lead-routing.json` - Lead assignment rules
- `follow-up-automation.json` - Email/SMS automation
- `high-value-alerts.json` - Notification workflow

Import these into your n8n instance via the UI or API.

### Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/sierra_sync
REDIS_URL=redis://localhost:6379

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-key

# n8n
N8N_API_URL=http://localhost:5678
N8N_API_KEY=your-n8n-api-key
N8N_ENCRYPTION_KEY=your-encryption-key

# Sierra Interactive
SIERRA_API_KEY=your-sierra-api-key
SIERRA_API_URL=https://api.sierrainteractive.com
SIERRA_WEBHOOK_SECRET=your-webhook-secret

# CRM Credentials
HUBSPOT_API_KEY=your-hubspot-key
SALESFORCE_CLIENT_ID=your-sf-client-id
SALESFORCE_CLIENT_SECRET=your-sf-client-secret
ZOHO_CLIENT_ID=your-zoho-client-id
ZOHO_CLIENT_SECRET=your-zoho-client-secret

# App Settings
JWT_SECRET=your-jwt-secret
ENCRYPTION_KEY=your-encryption-key
```

## 🚀 Deployment

### Production Deployment with Docker

1. **Build production images**
```bash
docker-compose -f docker-compose.prod.yml build
```

2. **Deploy to your server**
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Kubernetes Deployment

Helm charts are available in `/k8s/helm/`:

```bash
helm install sierra-sync ./k8s/helm/sierra-sync \
  --namespace sierra-sync \
  --create-namespace \
  --values ./k8s/helm/sierra-sync/values.production.yaml
```

### Cloud Deployment Options

- **AWS**: Use ECS with RDS and ElastiCache
- **Google Cloud**: Deploy on Cloud Run with Cloud SQL
- **Azure**: Use Container Instances with Azure Database
- **Vercel**: Deploy Next.js frontend
- **Railway/Render**: Full-stack deployment

## 📊 Monitoring & Observability

### Metrics Dashboard

Access the monitoring dashboard at `/dashboard` to view:
- Real-time sync status
- Lead flow metrics
- Error rates and logs
- API performance stats
- CRM connection health

### Logging

Logs are structured and stored in:
- Application logs: `/logs/app.log`
- Sync logs: Database table `sync_logs`
- Error logs: `/logs/error.log`

### Alerts

Configure alerts in `/config/alerts.yaml`:
- Sync failures
- Rate limit warnings
- High error rates
- Connection issues

## 🔒 Security

### Data Protection
- All API keys encrypted at rest using AES-256
- OAuth tokens stored securely in Supabase
- TLS/SSL for all external communications
- Row-level security for multi-tenancy

### Compliance
- GDPR compliant data handling
- SOC 2 Type II controls
- Regular security audits
- Data retention policies

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Write tests for new features
4. Ensure all tests pass
5. Submit a pull request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- Documentation: [docs.sierrasync.com](https://docs.sierrasync.com)
- Email: support@sierrasync.com
- Discord: [Join our community](https://discord.gg/sierrasync)
- Issues: [GitHub Issues](https://github.com/yourusername/sierra-sync-platform/issues)

## 🗺️ Roadmap

### Q1 2024
- [ ] Additional CRM integrations (Pipedrive, Monday.com)
- [ ] Advanced analytics dashboard
- [ ] Custom field mapping UI
- [ ] Mobile app for notifications

### Q2 2024
- [ ] AI-powered lead scoring
- [ ] Predictive analytics
- [ ] White-label options
- [ ] Enterprise SSO support

### Q3 2024
- [ ] Marketplace for custom workflows
- [ ] API rate limit optimization
- [ ] Advanced data transformation
- [ ] Compliance certifications

## 🙏 Acknowledgments

Built with:
- [n8n](https://n8n.io) - Workflow automation
- [Supabase](https://supabase.com) - Backend infrastructure
- [Next.js](https://nextjs.org) - React framework
- [shadcn/ui](https://ui.shadcn.com) - UI components
- [Playwright](https://playwright.dev) - E2E testing