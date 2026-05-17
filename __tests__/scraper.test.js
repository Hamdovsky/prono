/**
 * Scraper Routes Unit Tests
 * Tests for routes/scraper.js - Booking codes and scraper status endpoints
 */

const request = require('supertest');
const express = require('express');
const scraperRouter = require('../routes/scraper');
const fs = require('fs');
const path = require('path');

describe('Scraper API Routes', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', scraperRouter);
  });

  describe('GET /api/scraper/status', () => {
    it('should return scraper schedule and progress', async () => {
      const response = await request(app).get('/api/scraper/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('times');
      expect(response.body).toHaveProperty('lastRun');
      expect(response.body).toHaveProperty('nextRun');
      expect(response.body).toHaveProperty('running');
      expect(Array.isArray(response.body.times)).toBe(true);
      expect(response.body.times).toContain('06:00');
    });
  });

  describe('GET /api/booking-codes/all', () => {
    it('should return all booking codes merged from JSON files', async () => {
      // Mock the booking DB file
      const mockDb = {
        codes: [
          {
            id: 'code1',
            platform: 'Betclic',
            code: 'ABC123',
            channel: 'VIP',
            description: 'Test code',
            status: 'active',
            addedAt: new Date().toISOString()
          }
        ],
        meta: { lastUpdated: new Date().toISOString(), total: 1 }
      };

      // Mock fs.readFileSync for booking_codes.json
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = jest.fn((filePath) => {
        if (filePath.includes('booking_codes.json')) {
          return JSON.stringify(mockDb);
        }
        // For bibeet_tomorrow.json - return NOT_FOUND
        if (filePath.includes('bibeet_tomorrow.json')) {
          return JSON.stringify({ bookingCode: 'NOT_FOUND' });
        }
        return originalReadFileSync(filePath);
      });

      const originalExistsSync = fs.existsSync;
      fs.existsSync = jest.fn((filePath) => {
        if (filePath.includes('booking_codes.json')) return true;
        if (filePath.includes('bibeet_tomorrow.json')) return true;
        return originalExistsSync(filePath);
      });

      const response = await request(app).get('/api/booking-codes/all');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.codes)).toBe(true);
      expect(response.body.total).toBeGreaterThanOrEqual(1);

      // Restore
      fs.readFileSync = originalReadFileSync;
      fs.existsSync = originalExistsSync;
    });

    it('should handle missing booking DB files gracefully', async () => {
      const originalExists = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const response = await request(app).get('/api/booking-codes/all');

      expect(response.status).toBe(200);
      expect(response.body.codes).toEqual([]);

      fs.existsSync = originalExists;
    });
  });

  describe('POST /api/booking-codes/add', () => {
    it('should add a new booking code', async () => {
      const mockDb = { codes: [] };
      const originalWriteFileSync = fs.writeFileSync;
      const originalReadFileSync = fs.readFileSync;
      const originalMkdirSync = fs.mkdirSync;

      fs.readFileSync = jest.fn(() => JSON.stringify(mockDb));
      fs.writeFileSync = jest.fn((path, data) => {
        const parsed = JSON.parse(data);
        mockDb.codes = parsed.codes;
      });
      fs.mkdirSync = jest.fn(() => {});

      const newCode = {
        platform: 'Betx2',
        code: 'TEST456',
        channel: 'API Test',
        description: 'Test booking code'
      };

      const response = await request(app)
        .post('/api/booking-codes/add')
        .send(newCode);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.entry.code).toBe('TEST456');
      expect(mockDb.codes.length).toBe(1);

      // Restore
      fs.writeFileSync = originalWriteFileSync;
      fs.readFileSync = originalReadFileSync;
      fs.mkdirSync = originalMkdirSync;
    });

    it('should reject duplicate codes for same platform', async () => {
      const existingDb = {
        codes: [
          {
            id: 'existing',
            platform: 'Betclic',
            code: 'EXIST123',
            channel: 'Test',
            description: 'Existing',
            status: 'active',
            addedAt: new Date().toISOString()
          }
        ]
      };

      const originalReadFileSync = fs.readFileSync;
      const originalWriteFileSync = fs.writeFileSync;
      const originalMkdirSync = fs.mkdirSync;

      fs.readFileSync = jest.fn(() => JSON.stringify(existingDb));
      fs.writeFileSync = jest.fn();
      fs.mkdirSync = jest.fn();

      const duplicateCode = {
        platform: 'Betclic',
        code: 'EXIST123', // Same code
        channel: 'API'
      };

      const response = await request(app)
        .post('/api/booking-codes/add')
        .send(duplicateCode);

      expect(response.status).toBe(409);
      expect(response.body.error).toContain('already exists');

      // Restore
      fs.readFileSync = originalReadFileSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.mkdirSync = originalMkdirSync;
    });

    it('should require code field', async () => {
      const response = await request(app)
        .post('/api/booking-codes/add')
        .send({ platform: 'Test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('code is required');
    });
  });

  describe('DELETE /api/booking-codes/:id', () => {
    it('should delete a booking code by ID', async () => {
      const mockDb = {
        codes: [
          { id: 'keep-this', code: 'KEEP1' },
          { id: 'delete-me', code: 'DELETE1' }
        ]
      };

      const originalReadFileSync = fs.readFileSync;
      const originalWriteFileSync = fs.writeFileSync;

      fs.readFileSync = jest.fn(() => JSON.stringify(mockDb));
      fs.writeFileSync = jest.fn((path, data) => {
        const parsed = JSON.parse(data);
        mockDb.codes = parsed.codes;
      });

      const response = await request(app).delete('/api/booking-codes/delete-me');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockDb.codes.find(c => c.id === 'delete-me')).toBeUndefined();
      expect(mockDb.codes.find(c => c.id === 'keep-this')).toBeDefined();

      // Restore
      fs.readFileSync = originalReadFileSync;
      fs.writeFileSync = originalWriteFileSync;
    });

    it('should return 404 for non-existent code ID', async () => {
      const originalExists = fs.existsSync;
      fs.existsSync = jest.fn(() => false);

      const response = await request(app).delete('/api/booking-codes/nonexistent');

      expect(response.status).toBe(404);

      fs.existsSync = originalExists;
    });
  });

  describe('PATCH /api/booking-codes/:id', () => {
    it('should update booking code fields', async () => {
      const mockDb = {
        codes: [
          { id: 'update-me', code: 'OLD', platform: 'Betclic', status: 'active' }
        ]
      };

      const originalReadFileSync = fs.readFileSync;
      const originalWriteFileSync = fs.writeFileSync;

      fs.readFileSync = jest.fn(() => JSON.stringify(mockDb));
      fs.writeFileSync = jest.fn((path, data) => {
        const parsed = JSON.parse(data);
        mockDb.codes = parsed.codes;
      });

      const response = await request(app)
        .patch('/api/booking-codes/update-me')
        .send({ status: 'inactive', description: 'Updated desc' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.entry.status).toBe('inactive');
      expect(response.body.entry.description).toBe('Updated desc');
      expect(response.body.entry.code).toBe('OLD'); // Unchanged

      // Restore
      fs.readFileSync = originalReadFileSync;
      fs.writeFileSync = originalWriteFileSync;
    });

    it('should return 404 for non-existent code', async () => {
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = jest.fn(() => JSON.stringify({ codes: [] }));

      const response = await request(app)
        .patch('/api/booking-codes/nonexistent')
        .send({ status: 'inactive' });

      expect(response.status).toBe(404);

      fs.readFileSync = originalReadFileSync;
    });
  });
});
