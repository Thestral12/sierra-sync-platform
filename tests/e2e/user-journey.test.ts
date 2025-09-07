import { test, expect, Page, Browser } from '@playwright/test'

interface UserContext {
  email: string
  password: string
  organizationName: string
}

class SierraSyncApp {
  constructor(private page: Page) {}

  // Navigation helpers
  async goto(path: string = '/') {
    await this.page.goto(`${process.env.E2E_BASE_URL || 'http://localhost:3000'}${path}`)
  }

  async login(email: string, password: string) {
    await this.goto('/login')
    await this.page.fill('[data-testid="email-input"]', email)
    await this.page.fill('[data-testid="password-input"]', password)
    await this.page.click('[data-testid="login-button"]')
    
    // Wait for successful login redirect
    await this.page.waitForURL('/dashboard')
  }

  async register(user: UserContext) {
    await this.goto('/register')
    await this.page.fill('[data-testid="email-input"]', user.email)
    await this.page.fill('[data-testid="password-input"]', user.password)
    await this.page.fill('[data-testid="confirm-password-input"]', user.password)
    await this.page.fill('[data-testid="organization-name-input"]', user.organizationName)
    await this.page.click('[data-testid="register-button"]')
    
    // Wait for successful registration redirect
    await this.page.waitForURL('/dashboard')
  }

  async logout() {
    await this.page.click('[data-testid="user-menu"]')
    await this.page.click('[data-testid="logout-button"]')
    await this.page.waitForURL('/login')
  }

  // CRM Integration helpers
  async connectCRM(crmType: 'hubspot' | 'salesforce' | 'zoho', credentials: any) {
    await this.goto('/integrations')
    await this.page.click(`[data-testid="connect-${crmType}"]`)
    
    // Fill in CRM credentials form
    for (const [field, value] of Object.entries(credentials)) {
      await this.page.fill(`[data-testid="${field}-input"]`, value as string)
    }
    
    await this.page.click('[data-testid="connect-crm-button"]')
    
    // Wait for connection success
    await this.page.waitForSelector('[data-testid="connection-success"]', { timeout: 10000 })
  }

  async verifyCRMConnection(crmType: string) {
    await this.goto('/integrations')
    const connectionStatus = await this.page.textContent(`[data-testid="${crmType}-status"]`)
    expect(connectionStatus).toContain('Connected')
  }

  // Lead Management helpers
  async createLead(leadData: any) {
    await this.goto('/leads')
    await this.page.click('[data-testid="create-lead-button"]')
    
    // Fill lead form
    await this.page.fill('[data-testid="first-name-input"]', leadData.firstName)
    await this.page.fill('[data-testid="last-name-input"]', leadData.lastName)
    await this.page.fill('[data-testid="email-input"]', leadData.email)
    await this.page.fill('[data-testid="phone-input"]', leadData.phone)
    
    await this.page.click('[data-testid="save-lead-button"]')
    
    // Wait for lead to be created
    await this.page.waitForSelector('[data-testid="lead-created-success"]')
  }

  async triggerSync() {
    await this.goto('/dashboard')
    await this.page.click('[data-testid="sync-now-button"]')
    
    // Wait for sync to complete
    await this.page.waitForSelector('[data-testid="sync-complete"]', { timeout: 30000 })
  }

  async verifySyncLogs() {
    await this.goto('/sync-logs')
    
    // Check that sync logs are displayed
    const logEntries = await this.page.locator('[data-testid="sync-log-entry"]').count()
    expect(logEntries).toBeGreaterThan(0)
    
    // Verify successful sync
    const firstLogStatus = await this.page.textContent('[data-testid="sync-log-entry"]:first-child [data-testid="sync-status"]')
    expect(firstLogStatus).toContain('Success')
  }

  // Analytics helpers
  async viewAnalytics() {
    await this.goto('/analytics')
    
    // Wait for analytics to load
    await this.page.waitForSelector('[data-testid="analytics-overview"]')
    
    // Verify key metrics are displayed
    await expect(this.page.locator('[data-testid="total-leads-metric"]')).toBeVisible()
    await expect(this.page.locator('[data-testid="sync-success-rate-metric"]')).toBeVisible()
  }

  // Support helpers
  async createSupportTicket(ticketData: any) {
    await this.goto('/support')
    await this.page.click('[data-testid="create-ticket-button"]')
    
    await this.page.fill('[data-testid="ticket-subject-input"]', ticketData.subject)
    await this.page.fill('[data-testid="ticket-description-input"]', ticketData.description)
    await this.page.selectOption('[data-testid="ticket-category-select"]', ticketData.category)
    
    await this.page.click('[data-testid="submit-ticket-button"]')
    
    // Wait for ticket creation
    await this.page.waitForSelector('[data-testid="ticket-created-success"]')
  }

  // Settings helpers
  async updateProfile(profileData: any) {
    await this.goto('/settings/profile')
    
    await this.page.fill('[data-testid="first-name-input"]', profileData.firstName)
    await this.page.fill('[data-testid="last-name-input"]', profileData.lastName)
    
    await this.page.click('[data-testid="save-profile-button"]')
    
    // Wait for save confirmation
    await this.page.waitForSelector('[data-testid="profile-saved-success"]')
  }

  async updateBilling() {
    await this.goto('/settings/billing')
    
    // Verify billing information is displayed
    await expect(this.page.locator('[data-testid="current-plan"]')).toBeVisible()
    await expect(this.page.locator('[data-testid="billing-history"]')).toBeVisible()
  }

  // Utility helpers
  async waitForToast(message?: string) {
    const toast = this.page.locator('[data-testid="toast"]')
    await expect(toast).toBeVisible()
    
    if (message) {
      await expect(toast).toContainText(message)
    }
    
    // Wait for toast to disappear
    await expect(toast).toBeHidden()
  }

  async takeScreenshot(name: string) {
    await this.page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: true })
  }
}

test.describe('Sierra Sync User Journey', () => {
  let app: SierraSyncApp

  test.beforeEach(async ({ page }) => {
    app = new SierraSyncApp(page)
  })

  test.describe('New User Onboarding', () => {
    const newUser: UserContext = {
      email: `testuser-${Date.now()}@example.com`,
      password: 'TestPassword123!',
      organizationName: 'Test Organization'
    }

    test('should complete full registration flow', async () => {
      await app.register(newUser)
      
      // Should be redirected to dashboard
      await expect(app.page).toHaveURL('/dashboard')
      
      // Should show welcome message or onboarding
      await expect(app.page.locator('[data-testid="welcome-message"]')).toBeVisible()
      
      await app.takeScreenshot('after-registration')
    })

    test('should guide through CRM integration setup', async () => {
      await app.register(newUser)
      
      // Navigate to integrations
      await app.goto('/integrations')
      
      // Should show available CRM options
      await expect(app.page.locator('[data-testid="available-crms"]')).toBeVisible()
      await expect(app.page.locator('[data-testid="connect-hubspot"]')).toBeVisible()
      await expect(app.page.locator('[data-testid="connect-salesforce"]')).toBeVisible()
      await expect(app.page.locator('[data-testid="connect-zoho"]')).toBeVisible()
      
      await app.takeScreenshot('integration-options')
    })
  })

  test.describe('Existing User Workflow', () => {
    const existingUser: UserContext = {
      email: 'existing@test.example',
      password: 'TestPassword123!',
      organizationName: 'Existing Organization'
    }

    test.beforeEach(async () => {
      // Setup existing user (this would be done via API in real test)
      // For now, we'll register and then use
      await app.register(existingUser)
      await app.logout()
    })

    test('should login and access dashboard', async () => {
      await app.login(existingUser.email, existingUser.password)
      
      // Should be on dashboard
      await expect(app.page).toHaveURL('/dashboard')
      
      // Should show dashboard elements
      await expect(app.page.locator('[data-testid="dashboard-overview"]')).toBeVisible()
      
      await app.takeScreenshot('dashboard-logged-in')
    })

    test('should complete lead management workflow', async () => {
      await app.login(existingUser.email, existingUser.password)
      
      // Create a new lead
      const leadData = {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        phone: '+1-555-123-4567'
      }
      
      await app.createLead(leadData)
      
      // Verify lead appears in leads list
      await app.goto('/leads')
      await expect(app.page.locator('[data-testid="leads-table"]')).toContainText('John Doe')
      
      await app.takeScreenshot('leads-list')
    })

    test('should handle sync operations', async ({ page }) => {
      await app.login(existingUser.email, existingUser.password)
      
      // First, mock CRM connection for testing
      // In a real test, you would set up test CRM credentials
      
      // Trigger manual sync
      await app.triggerSync()
      
      // Verify sync completion
      await app.verifySyncLogs()
      
      await app.takeScreenshot('sync-completed')
    })

    test('should view analytics and reports', async () => {
      await app.login(existingUser.email, existingUser.password)
      
      await app.viewAnalytics()
      
      // Verify charts and metrics are loaded
      await expect(app.page.locator('[data-testid="analytics-chart"]')).toBeVisible()
      
      await app.takeScreenshot('analytics-dashboard')
    })

    test('should create support ticket', async () => {
      await app.login(existingUser.email, existingUser.password)
      
      const ticketData = {
        subject: 'Test Support Request',
        description: 'This is a test support ticket created during E2E testing.',
        category: 'technical'
      }
      
      await app.createSupportTicket(ticketData)
      
      // Verify ticket was created
      await app.goto('/support/tickets')
      await expect(app.page.locator('[data-testid="tickets-list"]')).toContainText(ticketData.subject)
      
      await app.takeScreenshot('support-ticket-created')
    })

    test('should update user profile', async () => {
      await app.login(existingUser.email, existingUser.password)
      
      const updatedProfile = {
        firstName: 'Updated',
        lastName: 'Name'
      }
      
      await app.updateProfile(updatedProfile)
      
      // Verify profile was updated
      await expect(app.page.locator('[data-testid="profile-name"]')).toContainText('Updated Name')
      
      await app.takeScreenshot('profile-updated')
    })

    test('should access billing information', async () => {
      await app.login(existingUser.email, existingUser.password)
      
      await app.updateBilling()
      
      await app.takeScreenshot('billing-settings')
    })
  })

  test.describe('Error Handling', () => {
    test('should handle login errors gracefully', async () => {
      await app.goto('/login')
      
      // Try invalid credentials
      await app.page.fill('[data-testid="email-input"]', 'invalid@example.com')
      await app.page.fill('[data-testid="password-input"]', 'wrongpassword')
      await app.page.click('[data-testid="login-button"]')
      
      // Should show error message
      await expect(app.page.locator('[data-testid="error-message"]')).toBeVisible()
      await expect(app.page.locator('[data-testid="error-message"]')).toContainText('Invalid credentials')
      
      await app.takeScreenshot('login-error')
    })

    test('should handle network errors', async () => {
      // This test would need to simulate network failures
      // For example, by intercepting API calls and returning errors
      await app.goto('/dashboard')
      
      // Simulate network failure for API calls
      await app.page.route('**/api/**', route => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal server error' })
        })
      })
      
      // Try to perform an action that requires API call
      await app.page.click('[data-testid="sync-now-button"]')
      
      // Should show error message
      await expect(app.page.locator('[data-testid="error-message"]')).toBeVisible()
      
      await app.takeScreenshot('network-error')
    })

    test('should handle validation errors', async () => {
      const newUser: UserContext = {
        email: 'invalid-email', // Invalid format
        password: '123', // Too weak
        organizationName: ''
      }
      
      await app.goto('/register')
      await app.page.fill('[data-testid="email-input"]', newUser.email)
      await app.page.fill('[data-testid="password-input"]', newUser.password)
      await app.page.fill('[data-testid="organization-name-input"]', newUser.organizationName)
      await app.page.click('[data-testid="register-button"]')
      
      // Should show validation errors
      await expect(app.page.locator('[data-testid="email-error"]')).toBeVisible()
      await expect(app.page.locator('[data-testid="password-error"]')).toBeVisible()
      
      await app.takeScreenshot('validation-errors')
    })
  })

  test.describe('Mobile Responsiveness', () => {
    test('should work on mobile devices', async ({ page }) => {
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 })
      
      const mobileUser: UserContext = {
        email: `mobile-${Date.now()}@example.com`,
        password: 'TestPassword123!',
        organizationName: 'Mobile Test Org'
      }
      
      app = new SierraSyncApp(page)
      
      // Test mobile registration
      await app.register(mobileUser)
      
      // Should show mobile-friendly dashboard
      await expect(app.page.locator('[data-testid="mobile-menu"]')).toBeVisible()
      
      // Test mobile navigation
      await app.page.click('[data-testid="mobile-menu"]')
      await expect(app.page.locator('[data-testid="mobile-nav"]')).toBeVisible()
      
      await app.takeScreenshot('mobile-dashboard')
    })
  })

  test.describe('Performance', () => {
    test('should load dashboard within acceptable time', async ({ page }) => {
      const user: UserContext = {
        email: `perf-${Date.now()}@example.com`,
        password: 'TestPassword123!',
        organizationName: 'Performance Test Org'
      }
      
      app = new SierraSyncApp(page)
      await app.register(user)
      
      // Measure dashboard load time
      const startTime = Date.now()
      await app.goto('/dashboard')
      await app.page.waitForSelector('[data-testid="dashboard-overview"]')
      const loadTime = Date.now() - startTime
      
      // Should load within 3 seconds
      expect(loadTime).toBeLessThan(3000)
      
      console.log(`Dashboard loaded in ${loadTime}ms`)
    })

    test('should handle large data sets', async ({ page }) => {
      const user: UserContext = {
        email: `data-${Date.now()}@example.com`,
        password: 'TestPassword123!',
        organizationName: 'Data Test Org'
      }
      
      app = new SierraSyncApp(page)
      await app.login(user.email, user.password)
      
      // Navigate to leads page with many records
      await app.goto('/leads')
      
      // Should still be responsive with large data
      const startTime = Date.now()
      await app.page.waitForSelector('[data-testid="leads-table"]')
      const loadTime = Date.now() - startTime
      
      expect(loadTime).toBeLessThan(5000)
    })
  })

  test.describe('Accessibility', () => {
    test('should be keyboard navigable', async ({ page }) => {
      app = new SierraSyncApp(page)
      await app.goto('/login')
      
      // Test tab navigation
      await page.keyboard.press('Tab') // Email field
      await expect(page.locator('[data-testid="email-input"]')).toBeFocused()
      
      await page.keyboard.press('Tab') // Password field
      await expect(page.locator('[data-testid="password-input"]')).toBeFocused()
      
      await page.keyboard.press('Tab') // Login button
      await expect(page.locator('[data-testid="login-button"]')).toBeFocused()
    })

    test('should have proper ARIA labels', async ({ page }) => {
      app = new SierraSyncApp(page)
      await app.goto('/dashboard')
      
      // Check for ARIA labels on key elements
      const emailInput = page.locator('[data-testid="email-input"]')
      await expect(emailInput).toHaveAttribute('aria-label')
      
      const menuButton = page.locator('[data-testid="user-menu"]')
      await expect(menuButton).toHaveAttribute('aria-expanded')
    })
  })
})