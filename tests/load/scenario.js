import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend, Counter, Gauge } from 'k6/metrics'
import { randomString, randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js'

// Custom metrics
const errorRate = new Rate('errors')
const syncDuration = new Trend('sync_duration')
const syncSuccess = new Counter('sync_success')
const syncFailure = new Counter('sync_failure')
const activeUsers = new Gauge('active_users')
const apiLatency = new Trend('api_latency')

// Configuration
const BASE_URL = __ENV.BASE_URL || 'https://staging.sierrasync.com'
const API_KEY = __ENV.API_KEY || 'test-api-key'

// Test scenarios
export const options = {
  scenarios: {
    // Smoke test - minimal load
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '1m',
      tags: { test_type: 'smoke' },
      startTime: '0s'
    },
    
    // Average load test
    average_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 20 },  // Ramp up
        { duration: '5m', target: 20 },  // Stay at 20 users
        { duration: '2m', target: 0 }    // Ramp down
      ],
      tags: { test_type: 'average' },
      startTime: '2m'
    },
    
    // Stress test - beyond normal load
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '5m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '5m', target: 100 },
        { duration: '2m', target: 0 }
      ],
      tags: { test_type: 'stress' },
      startTime: '12m'
    },
    
    // Spike test - sudden load increase
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '10s', target: 0 }
      ],
      tags: { test_type: 'spike' },
      startTime: '28m'
    },
    
    // Soak test - sustained load
    soak: {
      executor: 'constant-vus',
      vus: 30,
      duration: '30m',
      tags: { test_type: 'soak' },
      startTime: '31m'
    },
    
    // Breakpoint test - find the limit
    breakpoint: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        { duration: '10m', target: 500 }
      ],
      tags: { test_type: 'breakpoint' },
      startTime: '62m'
    }
  },
  
  thresholds: {
    // API response time thresholds
    http_req_duration: [
      'p(50)<500',   // 50% of requests under 500ms
      'p(95)<2000',  // 95% of requests under 2s
      'p(99)<5000'   // 99% of requests under 5s
    ],
    
    // Error rate thresholds
    errors: ['rate<0.1'],  // Less than 10% errors
    http_req_failed: ['rate<0.1'],
    
    // Custom metric thresholds
    sync_duration: ['p(95)<10000'],  // 95% of syncs under 10s
    api_latency: ['p(95)<1000']      // 95% of API calls under 1s
  },
  
  // Cloud configuration
  ext: {
    loadimpact: {
      projectID: __ENV.K6_PROJECT_ID,
      name: 'Sierra Sync Load Test',
      distribution: {
        'amazon:us:ashburn': { loadZone: 'amazon:us:ashburn', percent: 50 },
        'amazon:eu:dublin': { loadZone: 'amazon:eu:dublin', percent: 50 }
      }
    }
  }
}

// Setup - runs once before the test
export function setup() {
  // Create test organization and get auth token
  const setupRes = http.post(
    `${BASE_URL}/api/test/setup`,
    JSON.stringify({
      organization: 'LoadTest_' + Date.now(),
      users: 5
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      }
    }
  )
  
  const setupData = JSON.parse(setupRes.body)
  
  return {
    authToken: setupData.token,
    organizationId: setupData.organizationId,
    testUsers: setupData.users
  }
}

// Main test function - runs for each VU
export default function(data) {
  const authHeaders = {
    'Authorization': `Bearer ${data.authToken}`,
    'Content-Type': 'application/json'
  }
  
  activeUsers.add(1)
  
  // Test scenario groups
  group('Authentication Flow', () => {
    const startTime = Date.now()
    
    const loginRes = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({
        email: randomItem(data.testUsers).email,
        password: 'LoadTest123!'
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
    
    apiLatency.add(Date.now() - startTime)
    
    check(loginRes, {
      'login successful': (r) => r.status === 200,
      'has access token': (r) => JSON.parse(r.body).accessToken !== undefined
    })
    
    errorRate.add(loginRes.status !== 200)
  })
  
  sleep(1)
  
  group('Lead Sync Operations', () => {
    // Create a lead
    const leadData = {
      firstName: 'Load',
      lastName: 'Test_' + randomString(5),
      email: `loadtest_${randomString(10)}@example.com`,
      phone: '+1234567890',
      leadScore: Math.floor(Math.random() * 100),
      source: 'LoadTest'
    }
    
    const createStartTime = Date.now()
    const createRes = http.post(
      `${BASE_URL}/api/leads`,
      JSON.stringify(leadData),
      { headers: authHeaders }
    )
    
    const createDuration = Date.now() - createStartTime
    apiLatency.add(createDuration)
    
    const leadCreated = check(createRes, {
      'lead created': (r) => r.status === 201,
      'has lead ID': (r) => JSON.parse(r.body).id !== undefined
    })
    
    if (leadCreated) {
      const leadId = JSON.parse(createRes.body).id
      
      // Trigger sync
      const syncStartTime = Date.now()
      const syncRes = http.post(
        `${BASE_URL}/api/sync/lead/${leadId}`,
        JSON.stringify({ 
          crmTypes: ['hubspot', 'salesforce', 'zoho'] 
        }),
        { headers: authHeaders }
      )
      
      const syncTime = Date.now() - syncStartTime
      syncDuration.add(syncTime)
      
      const syncSuccessful = check(syncRes, {
        'sync triggered': (r) => r.status === 202,
        'sync time < 10s': (r) => syncTime < 10000
      })
      
      if (syncSuccessful) {
        syncSuccess.add(1)
      } else {
        syncFailure.add(1)
      }
      
      errorRate.add(!syncSuccessful)
      
      // Check sync status
      sleep(2)
      
      const statusRes = http.get(
        `${BASE_URL}/api/sync/status/${leadId}`,
        { headers: authHeaders }
      )
      
      check(statusRes, {
        'sync status retrieved': (r) => r.status === 200,
        'sync completed': (r) => JSON.parse(r.body).status === 'completed'
      })
    }
  })
  
  sleep(1)
  
  group('Dashboard Metrics', () => {
    const metricsRes = http.get(
      `${BASE_URL}/api/dashboard/metrics`,
      { headers: authHeaders }
    )
    
    check(metricsRes, {
      'metrics retrieved': (r) => r.status === 200,
      'has sync data': (r) => JSON.parse(r.body).totalSyncs !== undefined
    })
    
    errorRate.add(metricsRes.status !== 200)
  })
  
  sleep(1)
  
  group('Webhook Reception', () => {
    const webhookData = {
      event: 'lead.updated',
      data: {
        id: 'test-' + randomString(10),
        firstName: 'Webhook',
        lastName: 'Test',
        leadScore: 90
      },
      timestamp: new Date().toISOString()
    }
    
    const webhookRes = http.post(
      `${BASE_URL}/api/webhooks/sierra`,
      JSON.stringify(webhookData),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Sierra-Signature': 'test-signature'
        }
      }
    )
    
    check(webhookRes, {
      'webhook accepted': (r) => r.status === 200 || r.status === 202
    })
    
    errorRate.add(webhookRes.status >= 400)
  })
  
  sleep(1)
  
  group('CRM Integration Health', () => {
    const integrationsRes = http.get(
      `${BASE_URL}/api/integrations`,
      { headers: authHeaders }
    )
    
    check(integrationsRes, {
      'integrations retrieved': (r) => r.status === 200,
      'has active integrations': (r) => {
        const integrations = JSON.parse(r.body)
        return integrations.length > 0 && integrations.some(i => i.isActive)
      }
    })
  })
  
  sleep(1)
  
  group('Real-time Updates', () => {
    // Simulate WebSocket connection for real-time updates
    const wsRes = http.get(
      `${BASE_URL}/api/ws/token`,
      { headers: authHeaders }
    )
    
    check(wsRes, {
      'WebSocket token retrieved': (r) => r.status === 200
    })
  })
  
  activeUsers.add(-1)
  sleep(Math.random() * 2)
}

// Teardown - runs once after the test
export function teardown(data) {
  // Clean up test data
  http.post(
    `${BASE_URL}/api/test/cleanup`,
    JSON.stringify({
      organizationId: data.organizationId
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      }
    }
  )
}

// Handle test results
export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    environment: BASE_URL,
    scenarios: {},
    thresholds: {},
    metrics: {}
  }
  
  // Process scenarios
  Object.keys(options.scenarios).forEach(scenario => {
    const scenarioData = data.metrics[scenario] || {}
    summary.scenarios[scenario] = {
      vus: scenarioData.vus,
      duration: scenarioData.duration,
      iterations: scenarioData.iterations
    }
  })
  
  // Process thresholds
  Object.keys(data.metrics).forEach(metric => {
    if (data.metrics[metric].thresholds) {
      summary.thresholds[metric] = {
        passes: data.metrics[metric].thresholds.passes,
        fails: data.metrics[metric].thresholds.fails
      }
    }
  })
  
  // Process key metrics
  const keyMetrics = [
    'http_req_duration',
    'http_req_failed',
    'errors',
    'sync_duration',
    'api_latency'
  ]
  
  keyMetrics.forEach(metric => {
    if (data.metrics[metric]) {
      summary.metrics[metric] = {
        avg: data.metrics[metric].avg,
        min: data.metrics[metric].min,
        max: data.metrics[metric].max,
        p50: data.metrics[metric].p(50),
        p95: data.metrics[metric].p(95),
        p99: data.metrics[metric].p(99)
      }
    }
  })
  
  // Return multiple outputs
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(summary, null, 2),
    'summary.html': htmlReport(data)
  }
}

// Helper function for text summary
function textSummary(data, options) {
  // Implementation would format the data as text
  return JSON.stringify(data, null, 2)
}

// Helper function for HTML report
function htmlReport(data) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Load Test Report - ${new Date().toISOString()}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .metric { margin: 10px 0; padding: 10px; border: 1px solid #ddd; }
        .pass { background-color: #d4edda; }
        .fail { background-color: #f8d7da; }
      </style>
    </head>
    <body>
      <h1>Sierra Sync Load Test Report</h1>
      <div id="results">${JSON.stringify(data, null, 2)}</div>
    </body>
    </html>
  `
}