import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SierraInteractiveAPI } from '../../src/services/sierra-interactive';
import { Lead, Contact, Transaction } from '../../src/types/sierra';

describe('Sierra Interactive API Service', () => {
  let sierraAPI: SierraInteractiveAPI;
  
  beforeEach(() => {
    sierraAPI = new SierraInteractiveAPI({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.sierrainteractive.com',
      tenantId: 'test-tenant'
    });
  });

  describe('Authentication', () => {
    it('should authenticate with valid API key', async () => {
      const isAuthenticated = await sierraAPI.authenticate();
      expect(isAuthenticated).toBe(true);
    });

    it('should handle invalid API key', async () => {
      sierraAPI = new SierraInteractiveAPI({
        apiKey: 'invalid-key',
        baseUrl: 'https://api.sierrainteractive.com',
        tenantId: 'test-tenant'
      });
      
      await expect(sierraAPI.authenticate()).rejects.toThrow('Authentication failed');
    });

    it('should refresh token when expired', async () => {
      const spy = jest.spyOn(sierraAPI, 'refreshToken');
      await sierraAPI.makeAuthenticatedRequest('/leads');
      expect(spy).toHaveBeenCalledTimes(0);
      
      // Simulate token expiry
      sierraAPI.tokenExpiry = Date.now() - 1000;
      await sierraAPI.makeAuthenticatedRequest('/leads');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Lead Management', () => {
    it('should fetch all leads with pagination', async () => {
      const leads = await sierraAPI.getLeads({ page: 1, limit: 50 });
      expect(leads).toHaveProperty('data');
      expect(leads).toHaveProperty('total');
      expect(leads).toHaveProperty('page');
      expect(leads.data).toBeInstanceOf(Array);
    });

    it('should fetch single lead by ID', async () => {
      const lead = await sierraAPI.getLeadById('lead-123');
      expect(lead).toHaveProperty('id', 'lead-123');
      expect(lead).toHaveProperty('firstName');
      expect(lead).toHaveProperty('lastName');
      expect(lead).toHaveProperty('email');
    });

    it('should create new lead', async () => {
      const newLead: Partial<Lead> = {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        phone: '+1234567890',
        source: 'Website',
        leadScore: 85
      };
      
      const createdLead = await sierraAPI.createLead(newLead);
      expect(createdLead).toHaveProperty('id');
      expect(createdLead.firstName).toBe(newLead.firstName);
      expect(createdLead.email).toBe(newLead.email);
    });

    it('should update existing lead', async () => {
      const updates = { leadScore: 95, status: 'hot' };
      const updatedLead = await sierraAPI.updateLead('lead-123', updates);
      expect(updatedLead.leadScore).toBe(95);
      expect(updatedLead.status).toBe('hot');
    });

    it('should handle lead webhooks', async () => {
      const webhook = await sierraAPI.registerWebhook({
        event: 'lead.created',
        url: 'https://example.com/webhook',
        secret: 'webhook-secret'
      });
      
      expect(webhook).toHaveProperty('id');
      expect(webhook.event).toBe('lead.created');
    });
  });

  describe('Contact Sync', () => {
    it('should sync contacts in batch', async () => {
      const contacts: Contact[] = [
        { id: '1', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com' },
        { id: '2', firstName: 'Bob', lastName: 'Johnson', email: 'bob@example.com' }
      ];
      
      const result = await sierraAPI.batchSyncContacts(contacts);
      expect(result.successful).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should handle duplicate contacts', async () => {
      const duplicate: Contact = {
        id: 'dup-1',
        firstName: 'Existing',
        lastName: 'User',
        email: 'existing@example.com'
      };
      
      const result = await sierraAPI.createContact(duplicate);
      expect(result).toHaveProperty('merged', true);
      expect(result).toHaveProperty('originalId');
    });
  });

  describe('Transaction Updates', () => {
    it('should fetch transactions by date range', async () => {
      const transactions = await sierraAPI.getTransactions({
        startDate: '2024-01-01',
        endDate: '2024-01-31'
      });
      
      expect(transactions).toBeInstanceOf(Array);
      transactions.forEach(tx => {
        expect(tx).toHaveProperty('id');
        expect(tx).toHaveProperty('amount');
        expect(tx).toHaveProperty('status');
      });
    });

    it('should update transaction status', async () => {
      const updated = await sierraAPI.updateTransactionStatus('tx-123', 'closed');
      expect(updated.status).toBe('closed');
      expect(updated.closedAt).toBeDefined();
    });
  });

  describe('Rate Limiting', () => {
    it('should respect rate limits', async () => {
      const requests = Array(10).fill(null).map(() => sierraAPI.getLeads());
      const start = Date.now();
      await Promise.all(requests);
      const duration = Date.now() - start;
      
      // Should take at least 2 seconds for 10 requests with 5 req/sec limit
      expect(duration).toBeGreaterThanOrEqual(2000);
    });

    it('should retry on rate limit error', async () => {
      const spy = jest.spyOn(sierraAPI, 'handleRateLimit');
      // Simulate rate limit error
      jest.spyOn(global, 'fetch').mockRejectedValueOnce({
        status: 429,
        headers: { 'Retry-After': '2' }
      });
      
      await sierraAPI.getLeads();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));
      
      await expect(sierraAPI.getLeads()).rejects.toThrow('Network error');
    });

    it('should handle API errors with proper messages', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Invalid request parameters' })
      } as Response);
      
      await expect(sierraAPI.getLeads()).rejects.toThrow('Invalid request parameters');
    });

    it('should implement exponential backoff for retries', async () => {
      const spy = jest.spyOn(sierraAPI, 'retryWithBackoff');
      jest.spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
      
      await sierraAPI.getLeads();
      expect(spy).toHaveBeenCalled();
    });
  });
});