import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CRMIntegrationService } from '../../src/services/crm-integration';
import { HubSpotAdapter, SalesforceAdapter, ZohoAdapter } from '../../src/services/crm-adapters';
import { Lead, Contact, Deal } from '../../src/types/crm';

describe('CRM Integration Service', () => {
  let crmService: CRMIntegrationService;
  
  beforeEach(() => {
    crmService = new CRMIntegrationService();
  });

  describe('HubSpot Integration', () => {
    let hubspotAdapter: HubSpotAdapter;
    
    beforeEach(() => {
      hubspotAdapter = new HubSpotAdapter({
        apiKey: 'test-hubspot-key',
        portalId: '12345'
      });
    });

    it('should authenticate with HubSpot OAuth', async () => {
      const token = await hubspotAdapter.authenticateOAuth({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });
      
      expect(token).toHaveProperty('access_token');
      expect(token).toHaveProperty('refresh_token');
      expect(token).toHaveProperty('expires_in');
    });

    it('should create contact in HubSpot', async () => {
      const contact: Contact = {
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        phone: '+1234567890',
        properties: {
          leadSource: 'Sierra Interactive',
          leadScore: 85
        }
      };
      
      const created = await hubspotAdapter.createContact(contact);
      expect(created).toHaveProperty('id');
      expect(created.email).toBe(contact.email);
    });

    it('should update deal stage in HubSpot', async () => {
      const dealUpdate = {
        dealId: 'deal-123',
        stage: 'closedwon',
        amount: 500000,
        closeDate: '2024-02-01'
      };
      
      const updated = await hubspotAdapter.updateDeal(dealUpdate);
      expect(updated.stage).toBe('closedwon');
      expect(updated.amount).toBe(500000);
    });

    it('should batch sync contacts to HubSpot', async () => {
      const contacts = Array(100).fill(null).map((_, i) => ({
        email: `contact${i}@example.com`,
        firstName: `Contact${i}`,
        lastName: 'Test'
      }));
      
      const result = await hubspotAdapter.batchCreateContacts(contacts);
      expect(result.created).toBe(100);
      expect(result.errors).toEqual([]);
    });

    it('should handle HubSpot rate limits', async () => {
      const spy = jest.spyOn(hubspotAdapter, 'handleRateLimit');
      
      // Simulate rate limit response
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        status: 429,
        headers: { 'X-HubSpot-RateLimit-Remaining': '0' }
      } as Response);
      
      await hubspotAdapter.createContact({ email: 'test@example.com' });
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Salesforce Integration', () => {
    let salesforceAdapter: SalesforceAdapter;
    
    beforeEach(() => {
      salesforceAdapter = new SalesforceAdapter({
        instanceUrl: 'https://test.salesforce.com',
        clientId: 'sf-client-id',
        clientSecret: 'sf-client-secret'
      });
    });

    it('should authenticate with Salesforce OAuth 2.0', async () => {
      const auth = await salesforceAdapter.authenticate({
        username: 'user@example.com',
        password: 'password123',
        securityToken: 'token123'
      });
      
      expect(auth).toHaveProperty('accessToken');
      expect(auth).toHaveProperty('instanceUrl');
      expect(auth).toHaveProperty('id');
    });

    it('should create Lead in Salesforce', async () => {
      const lead: Lead = {
        firstName: 'John',
        lastName: 'Doe',
        company: 'Example Corp',
        email: 'john@example.com',
        phone: '+1234567890',
        leadSource: 'Sierra Interactive',
        status: 'New'
      };
      
      const created = await salesforceAdapter.createLead(lead);
      expect(created).toHaveProperty('id');
      expect(created.success).toBe(true);
    });

    it('should convert Lead to Opportunity', async () => {
      const conversion = await salesforceAdapter.convertLead({
        leadId: 'lead-123',
        convertedStatus: 'Qualified',
        opportunityName: 'New Property Deal',
        doNotCreateOpportunity: false
      });
      
      expect(conversion).toHaveProperty('accountId');
      expect(conversion).toHaveProperty('contactId');
      expect(conversion).toHaveProperty('opportunityId');
    });

    it('should query Salesforce with SOQL', async () => {
      const query = "SELECT Id, Name, Email FROM Lead WHERE CreatedDate = TODAY";
      const results = await salesforceAdapter.query(query);
      
      expect(results).toHaveProperty('totalSize');
      expect(results).toHaveProperty('records');
      expect(results.records).toBeInstanceOf(Array);
    });

    it('should handle Salesforce bulk operations', async () => {
      const leads = Array(5000).fill(null).map((_, i) => ({
        firstName: `Lead${i}`,
        lastName: 'Test',
        email: `lead${i}@example.com`,
        company: 'Test Company'
      }));
      
      const bulkResult = await salesforceAdapter.bulkCreateLeads(leads);
      expect(bulkResult.jobId).toBeDefined();
      expect(bulkResult.state).toBe('Completed');
      expect(bulkResult.numberProcessed).toBe(5000);
    });
  });

  describe('Zoho CRM Integration', () => {
    let zohoAdapter: ZohoAdapter;
    
    beforeEach(() => {
      zohoAdapter = new ZohoAdapter({
        clientId: 'zoho-client-id',
        clientSecret: 'zoho-client-secret',
        refreshToken: 'zoho-refresh-token',
        domain: 'com'
      });
    });

    it('should refresh Zoho access token', async () => {
      const token = await zohoAdapter.refreshAccessToken();
      expect(token).toHaveProperty('access_token');
      expect(token).toHaveProperty('expires_in');
      expect(token.token_type).toBe('Bearer');
    });

    it('should create record in Zoho', async () => {
      const lead = {
        Last_Name: 'TestLead',
        First_Name: 'John',
        Email: 'john@example.com',
        Phone: '+1234567890',
        Lead_Source: 'Sierra Interactive',
        Lead_Status: 'Not Contacted'
      };
      
      const created = await zohoAdapter.createRecord('Leads', lead);
      expect(created).toHaveProperty('id');
      expect(created.data[0].status).toBe('success');
    });

    it('should update record in Zoho', async () => {
      const updates = {
        Lead_Status: 'Contacted',
        Lead_Score: 90
      };
      
      const updated = await zohoAdapter.updateRecord('Leads', 'lead-123', updates);
      expect(updated.data[0].status).toBe('success');
      expect(updated.data[0].message).toBe('record updated');
    });

    it('should handle Zoho webhooks', async () => {
      const webhook = await zohoAdapter.subscribeWebhook({
        module: 'Leads',
        events: ['create', 'update'],
        notify_url: 'https://example.com/zoho-webhook',
        token: 'webhook-token'
      });
      
      expect(webhook).toHaveProperty('watch_id');
      expect(webhook.events).toContain('create');
      expect(webhook.events).toContain('update');
    });

    it('should batch upsert records in Zoho', async () => {
      const records = Array(100).fill(null).map((_, i) => ({
        Email: `lead${i}@example.com`,
        Last_Name: `Lead${i}`,
        First_Name: 'Test',
        Lead_Source: 'Sierra Interactive'
      }));
      
      const result = await zohoAdapter.batchUpsert('Leads', records, 'Email');
      expect(result.data.length).toBe(100);
      expect(result.data.every(r => r.status === 'success')).toBe(true);
    });
  });

  describe('Multi-CRM Sync', () => {
    it('should sync lead to multiple CRMs simultaneously', async () => {
      const lead = {
        firstName: 'Multi',
        lastName: 'Sync',
        email: 'multi@example.com',
        phone: '+1234567890'
      };
      
      const results = await crmService.syncToMultipleCRMs(lead, [
        'hubspot',
        'salesforce',
        'zoho'
      ]);
      
      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should handle partial failures in multi-CRM sync', async () => {
      const lead = { email: 'test@example.com' };
      
      // Mock one CRM failure
      jest.spyOn(crmService.adapters.salesforce, 'createLead')
        .mockRejectedValueOnce(new Error('Salesforce error'));
      
      const results = await crmService.syncToMultipleCRMs(lead, [
        'hubspot',
        'salesforce',
        'zoho'
      ]);
      
      expect(results.filter(r => r.success)).toHaveLength(2);
      expect(results.filter(r => !r.success)).toHaveLength(1);
    });

    it('should maintain sync status across CRMs', async () => {
      const syncStatus = await crmService.getSyncStatus('lead-123');
      
      expect(syncStatus).toHaveProperty('hubspot');
      expect(syncStatus).toHaveProperty('salesforce');
      expect(syncStatus).toHaveProperty('zoho');
      expect(syncStatus.hubspot).toHaveProperty('lastSync');
      expect(syncStatus.hubspot).toHaveProperty('status');
    });
  });

  describe('Field Mapping', () => {
    it('should map Sierra fields to CRM fields correctly', async () => {
      const sierraLead = {
        first_name: 'John',
        last_name: 'Doe',
        email_address: 'john@example.com',
        phone_number: '+1234567890',
        score: 85
      };
      
      const hubspotMapped = crmService.mapFieldsToHubSpot(sierraLead);
      expect(hubspotMapped.firstname).toBe('John');
      expect(hubspotMapped.lastname).toBe('Doe');
      expect(hubspotMapped.email).toBe('john@example.com');
      expect(hubspotMapped.lead_score).toBe(85);
      
      const salesforceMapped = crmService.mapFieldsToSalesforce(sierraLead);
      expect(salesforceMapped.FirstName).toBe('John');
      expect(salesforceMapped.LastName).toBe('Doe');
      expect(salesforceMapped.Email).toBe('john@example.com');
      
      const zohoMapped = crmService.mapFieldsToZoho(sierraLead);
      expect(zohoMapped.First_Name).toBe('John');
      expect(zohoMapped.Last_Name).toBe('Doe');
      expect(zohoMapped.Email).toBe('john@example.com');
    });

    it('should support custom field mappings', async () => {
      const customMapping = {
        'sierra_custom_field': 'crm_custom_field',
        'property_interest': 'property_type_interest'
      };
      
      crmService.setCustomFieldMapping('hubspot', customMapping);
      
      const mapped = crmService.mapFieldsWithCustom({
        sierra_custom_field: 'value1',
        property_interest: 'condo'
      }, 'hubspot');
      
      expect(mapped.crm_custom_field).toBe('value1');
      expect(mapped.property_type_interest).toBe('condo');
    });
  });
});