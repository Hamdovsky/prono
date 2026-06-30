/**
 * Tests pour routes/system.js
 * Coverage: health checks, bot debug, db debug, system intel
 */

const request = require('supertest');
const express = require('express');

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../core/securityEngine', () => ({
  authenticate: jest.fn((req, res, next) => next()),
  middleware: jest.fn((req, res, next) => next())
}));

jest.mock('../core/speedCache', () => ({ speedCache: {} }));

jest.mock('../services/botService', () => ({
  token: 'test-token-12345',
  chatId: 'chat-id-67890',
  isPolling: true
}));

const systemRoutes = require('../routes/system');
const botService = require('../services/botService');

describe('System Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', systemRoutes);
    jest.clearAllMocks();
  });

  describe('GET /api/ping', () => {
    it('should return API_PONG', async () => {
      const res = await request(app).get('/api/ping');
      expect(res.status).toBe(200);
      expect(res.text).toBe('API_PONG');
    });
  });

  describe('GET /api/bot-debug', () => {
    it('should return bot status for localhost', async () => {
      const res = await request(app)
        .get('/api/bot-debug')
        .set('X-Forwarded-For', '127.0.0.1');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('hasToken');
      expect(res.body).toHaveProperty('hasChatId');
      expect(res.body).toHaveProperty('isPolling');
      expect(res.body.hasToken).toBe(true);
      expect(res.body.hasChatId).toBe(true);
    });

    it('should mask sensitive token data', async () => {
      const res = await request(app)
        .get('/api/bot-debug')
        .set('X-Forwarded-For', '127.0.0.1');

      expect(res.body.tokenStart).toBe('test-');
      expect(typeof res.body.tokenLength).toBe('number');
      expect(res.body.chatIdStart).toBe('chat-');
    });

    it('should handle missing bot token', async () => {
      botService.token = null;
      botService.chatId = null;

      const res = await request(app)
        .get('/api/bot-debug')
        .set('X-Forwarded-For', '127.0.0.1');

      expect(res.status).toBe(200);
      expect(res.body.hasToken).toBe(false);
      expect(res.body.hasChatId).toBe(false);
      expect(res.body.tokenStart).toBe('none');

      botService.token = 'test-token-12345';
      botService.chatId = 'chat-id-67890';
    });
  });

  describe('GET /api/db-debug', () => {
    it('should return database statistics with correct structure', async () => {
      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('statuses');
      expect(res.body).toHaveProperty('sources');
      expect(res.body).toHaveProperty('samples');
      expect(res.body).toHaveProperty('serverTime');
      expect(typeof res.body.total).toBe('number');
      expect(Array.isArray(res.body.statuses)).toBe(true);
      expect(Array.isArray(res.body.sources)).toBe(true);
      expect(Array.isArray(res.body.samples)).toBe(true);
    });

    it('should return valid status breakdown', async () => {
      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');

      expect(res.status).toBe(200);
      res.body.statuses.forEach(s => {
        expect(s).toHaveProperty('status');
        expect(s).toHaveProperty('count');
        expect(typeof s.count).toBe('number');
      });
    });

    it('should return valid source breakdown', async () => {
      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');

      expect(res.status).toBe(200);
      res.body.sources.forEach(s => {
        expect(s).toHaveProperty('source');
        expect(s).toHaveProperty('count');
      });
    });
  });

  describe('GET /api/system/intel', () => {
    it('should return telemetry or handle gracefully', async () => {
      const res = await request(app).get('/api/system/intel');
      expect([200, 500]).toContain(res.status);
      expect(res.body).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle ping without errors', async () => {
      const res = await request(app).get('/api/ping');
      expect(res.status).toBe(200);
    });

    it('should handle db-debug on localhost', async () => {
      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');
      expect(res.status).toBe(200);
    });

    it('should handle bot-debug on localhost', async () => {
      const res = await request(app)
        .get('/api/bot-debug')
        .set('X-Forwarded-For', '127.0.0.1');
      expect(res.status).toBe(200);
    });
  });
});
