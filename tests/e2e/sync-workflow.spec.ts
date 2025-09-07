import { test, expect, Page } from '@playwright/test'
import { createMockLead, setupTestOrganization, cleanupTestData } from './helpers'

test.describe('Sierra to CRM Sync Workflow', () => {
  let page: Page
  let testOrgId: string
  let testLeadId: string

  test.beforeAll(async () => {
    // Setup test organization and integrations
    const org = await setupTestOrganization({
      name: 'Test Real Estate Team',
      integrations: ['sierra', 'hubspot', 'salesforce']
    })
    testOrgId = org.id
  })

  test.afterAll(async () => {
    // Cleanup test data
    await cleanupTestData(testOrgId)
  })

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage()
    await page.goto('http://localhost:3000')
    
    // Login with test credentials
    await page.fill('[data-testid="email-input"]', 'test@example.com')
    await page.fill('[data-testid="password-input"]', 'TestPassword123!')
    await page.click('[data-testid="login-button"]')
    
    // Wait for dashboard to load
    await page.waitForSelector('[data-testid="dashboard"]')
  })

  test('Should successfully sync a new lead from Sierra to multiple CRMs', async () => {
    // Create a mock lead in Sierra Interactive
    const mockLead = await createMockLead({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
      phone: '+1234567890',
      leadScore: 95,
      propertyInterest: ['Condo', 'Single Family'],
      source: 'Website'
    })
    testLeadId = mockLead.id

    // Navigate to sync monitoring page
    await page.click('[data-testid="nav-syncs"]')
    
    // Wait for the lead to appear in the sync queue
    await page.waitForSelector(`[data-testid="lead-${testLeadId}"]`, { timeout: 10000 })
    
    // Verify lead details are displayed correctly
    const leadCard = page.locator(`[data-testid="lead-${testLeadId}"]`)
    await expect(leadCard).toContainText('Jane Doe')
    await expect(leadCard).toContainText('jane.doe@example.com')
    await expect(leadCard).toContainText('Score: 95')
    
    // Check sync status indicators
    const hubspotStatus = leadCard.locator('[data-testid="hubspot-sync-status"]')
    const salesforceStatus = leadCard.locator('[data-testid="salesforce-sync-status"]')
    
    // Wait for syncs to complete
    await expect(hubspotStatus).toHaveAttribute('data-status', 'completed', { timeout: 15000 })
    await expect(salesforceStatus).toHaveAttribute('data-status', 'completed', { timeout: 15000 })
    
    // Verify sync logs
    await leadCard.click()
    await page.waitForSelector('[data-testid="sync-details-modal"]')
    
    const syncLogs = page.locator('[data-testid="sync-logs"]')
    await expect(syncLogs).toContainText('Lead created in HubSpot')
    await expect(syncLogs).toContainText('Lead created in Salesforce')
    
    // Verify high-value lead alert was triggered
    await page.click('[data-testid="close-modal"]')
    await page.click('[data-testid="nav-notifications"]')
    
    const notification = page.locator('[data-testid="notification-high-value-lead"]')
    await expect(notification).toBeVisible()
    await expect(notification).toContainText('High Value Lead: Jane Doe (Score: 95)')
  })

  test('Should handle CRM rate limits gracefully', async () => {
    // Create multiple leads to trigger rate limiting
    const leads = await Promise.all(
      Array(50).fill(null).map((_, i) => 
        createMockLead({
          firstName: `Test${i}`,
          lastName: 'Lead',
          email: `test${i}@example.com`,
          leadScore: 70
        })
      )
    )

    // Navigate to sync monitoring
    await page.click('[data-testid="nav-syncs"]')
    
    // Check for rate limit handling
    await page.waitForSelector('[data-testid="rate-limit-warning"]', { timeout: 30000 })
    
    const warning = page.locator('[data-testid="rate-limit-warning"]')
    await expect(warning).toContainText('Rate limit reached for HubSpot')
    await expect(warning).toContainText('Syncs queued and will retry')
    
    // Verify queued syncs are displayed
    const queuedCount = page.locator('[data-testid="queued-syncs-count"]')
    await expect(queuedCount).toHaveText(/\d+ syncs queued/)
    
    // Wait for retry and verify completion
    await page.waitForSelector('[data-testid="retry-progress"]')
    const retryProgress = page.locator('[data-testid="retry-progress"]')
    
    // Progress should update as syncs complete
    await expect(retryProgress).toHaveAttribute('data-progress', '100', { timeout: 60000 })
  })

  test('Should recover from sync failures', async () => {
    // Create a lead with invalid data to trigger failure
    const invalidLead = await createMockLead({
      firstName: 'Invalid',
      lastName: 'Lead',
      email: 'invalid-email', // Invalid email format
      phone: '123' // Invalid phone format
    })

    await page.click('[data-testid="nav-syncs"]')
    
    // Wait for sync failure
    const leadCard = page.locator(`[data-testid="lead-${invalidLead.id}"]`)
    await page.waitForSelector(`[data-testid="lead-${invalidLead.id}"]`)
    
    const syncStatus = leadCard.locator('[data-testid="sync-status"]')
    await expect(syncStatus).toHaveAttribute('data-status', 'failed', { timeout: 10000 })
    
    // Click to view error details
    await leadCard.click()
    const errorDetails = page.locator('[data-testid="error-details"]')
    await expect(errorDetails).toContainText('Invalid email format')
    
    // Fix the lead data
    await page.click('[data-testid="edit-lead-button"]')
    await page.fill('[data-testid="email-input"]', 'valid@example.com')
    await page.fill('[data-testid="phone-input"]', '+1234567890')
    await page.click('[data-testid="save-button"]')
    
    // Retry sync
    await page.click('[data-testid="retry-sync-button"]')
    
    // Verify successful sync after retry
    await expect(syncStatus).toHaveAttribute('data-status', 'completed', { timeout: 15000 })
  })

  test('Should apply lead routing rules correctly', async () => {
    // Create routing rules
    await page.goto('http://localhost:3000/settings/routing')
    
    await page.click('[data-testid="add-rule-button"]')
    await page.fill('[data-testid="rule-name"]', 'High Value Lead Route')
    await page.selectOption('[data-testid="condition-field"]', 'leadScore')
    await page.selectOption('[data-testid="condition-operator"]', 'greaterThan')
    await page.fill('[data-testid="condition-value"]', '80')
    await page.selectOption('[data-testid="assign-to"]', 'senior-agent@example.com')
    await page.click('[data-testid="save-rule-button"]')
    
    // Create a high-value lead
    const highValueLead = await createMockLead({
      firstName: 'Premium',
      lastName: 'Client',
      email: 'premium@example.com',
      leadScore: 90
    })
    
    // Navigate to leads page
    await page.goto('http://localhost:3000/leads')
    await page.waitForSelector(`[data-testid="lead-${highValueLead.id}"]`)
    
    // Verify correct assignment
    const leadRow = page.locator(`[data-testid="lead-${highValueLead.id}"]`)
    const assignedTo = leadRow.locator('[data-testid="assigned-to"]')
    await expect(assignedTo).toHaveText('senior-agent@example.com')
    
    // Verify notification was sent
    await page.goto('http://localhost:3000/notifications')
    const assignmentNotification = page.locator('[data-testid="assignment-notification"]').first()
    await expect(assignmentNotification).toContainText('New high-value lead assigned')
  })

  test('Should maintain data consistency across multiple CRMs', async () => {
    // Create a lead
    const lead = await createMockLead({
      firstName: 'Consistent',
      lastName: 'Data',
      email: 'consistent@example.com',
      leadScore: 75
    })
    
    // Wait for initial sync
    await page.goto('http://localhost:3000/leads')
    await page.waitForSelector(`[data-testid="lead-${lead.id}"]`)
    
    // Update lead in Sierra
    await page.click(`[data-testid="lead-${lead.id}"]`)
    await page.click('[data-testid="edit-button"]')
    await page.fill('[data-testid="lead-score-input"]', '85')
    await page.selectOption('[data-testid="status-select"]', 'qualified')
    await page.click('[data-testid="save-button"]')
    
    // Wait for update sync
    await page.waitForSelector('[data-testid="sync-in-progress"]')
    await page.waitForSelector('[data-testid="sync-completed"]', { timeout: 10000 })
    
    // Verify updates in all CRMs
    await page.click('[data-testid="view-in-crms"]')
    
    const hubspotData = page.locator('[data-testid="hubspot-data"]')
    await expect(hubspotData).toContainText('Lead Score: 85')
    await expect(hubspotData).toContainText('Status: qualified')
    
    const salesforceData = page.locator('[data-testid="salesforce-data"]')
    await expect(salesforceData).toContainText('Lead Score: 85')
    await expect(salesforceData).toContainText('Status: Qualified')
    
    const zohoData = page.locator('[data-testid="zoho-data"]')
    await expect(zohoData).toContainText('Lead Score: 85')
    await expect(zohoData).toContainText('Lead Status: Qualified')
  })

  test('Should handle webhook events in real-time', async () => {
    // Open dashboard
    await page.goto('http://localhost:3000/dashboard')
    
    // Get initial sync count
    const syncCounter = page.locator('[data-testid="total-syncs-count"]')
    const initialCount = parseInt(await syncCounter.textContent() || '0')
    
    // Simulate webhook from Sierra (in another context)
    const webhookResponse = await fetch('http://localhost:3001/api/webhooks/sierra', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sierra-Signature': 'test-signature'
      },
      body: JSON.stringify({
        event: 'lead.created',
        data: {
          id: 'webhook-lead-123',
          firstName: 'Webhook',
          lastName: 'Test',
          email: 'webhook@example.com',
          leadScore: 88
        }
      })
    })
    
    expect(webhookResponse.status).toBe(200)
    
    // Verify real-time update in dashboard
    await expect(syncCounter).toHaveText(String(initialCount + 1), { timeout: 5000 })
    
    // Check real-time activity feed
    const activityFeed = page.locator('[data-testid="activity-feed"]')
    const latestActivity = activityFeed.locator('[data-testid="activity-item"]').first()
    
    await expect(latestActivity).toContainText('Webhook Test')
    await expect(latestActivity).toContainText('webhook@example.com')
    await expect(latestActivity).toHaveAttribute('data-status', 'syncing')
    
    // Wait for sync completion
    await expect(latestActivity).toHaveAttribute('data-status', 'completed', { timeout: 10000 })
  })

  test('Should export sync reports', async () => {
    // Navigate to reports page
    await page.goto('http://localhost:3000/reports')
    
    // Set date range
    await page.click('[data-testid="date-range-picker"]')
    await page.click('[data-testid="last-7-days"]')
    
    // Select report type
    await page.selectOption('[data-testid="report-type"]', 'sync-summary')
    
    // Generate report
    await page.click('[data-testid="generate-report"]')
    await page.waitForSelector('[data-testid="report-ready"]', { timeout: 10000 })
    
    // Download report
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-testid="download-report"]')
    ])
    
    // Verify download
    expect(download.suggestedFilename()).toMatch(/sync-report-.*\.csv/)
    
    // Verify report preview
    const preview = page.locator('[data-testid="report-preview"]')
    await expect(preview).toContainText('Total Syncs')
    await expect(preview).toContainText('Success Rate')
    await expect(preview).toContainText('Average Sync Time')
  })
})