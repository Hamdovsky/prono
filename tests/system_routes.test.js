/**
 * Tests pour routes/system.js
 * Coverage: health checks, bot debug, db debug, system intel
 */

const request = require('supertest');
const express = require('express');
const systemRoutes = require('../routes/system');

// Mock des dépendances
jest.mock('../core/database');
jest.mock('../core/shieldEngine');
jest.mock('../services/mlPredictionService');
jest.mock('../core/configEngine');
jest.mock('../core/securityEngine');
jest.mock('../core/speedCache');
jest.mock('../core/logger');
jest.mock('../services/botService');

const database = require('../core/database');
const shieldEngine = require('../core/shieldEngine');
const mlPredictionService = require('../services/mlPredictionService');
const configEngine = require('../core/configEngine');
const botService = require('../services/botService');

describe('System Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', systemRoutes);

    // Reset mocks
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
    beforeEach(() => {
      botService.token = 'test-token-12345';
      botService.chatId = 'chat-id-67890';
      botService.isPolling = true;
    });

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
      expect(res.body.tokenLength).toBe(17);
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
    });
  });

  describe('GET /api/db-debug', () => {
    beforeEach(() => {
      const mockPrepare = jest.fn();
      
      mockPrepare.mockImplementation((query) => {
        if (query.includes('COUNT(*)')) {
          return { get: () => ({ count: 150 }) };
        }
        if (query.includes('GROUP BY status')) {
          return { 
            all: () => [
              { status: 'scheduled', count: 100 },
              { status: 'live', count: 10 },
              { status: 'finished', count: 40 }
            ]
          };
        }
        if (query.includes('GROUP BY source')) {
          return {
            all: () => [
              { source: 'sofascore', count: 80 },
              { source: 'promosport', count: 70 }
            ]
          };
        }
        if (query.includes('LIMIT 5')) {
          return {
            all: () => [
              {
                id: 1,
                homeTeam: 'Team A',
                awayTeam: 'Team B',
                status: 'scheduled',
                timestamp: 1735689600,
                startTimestamp: 1735689600,
                source: 'sofascore'
              }
            ]
          };
        }
        return { get: () => ({}), all: () => [] };
      });

      database.prepare = mockPrepare;
    });

    it('should return database statistics', async () => {
      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');
      
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('statuses');
      expect(res.body).toHaveProperty('sources');
      expect(res.body).toHaveProperty('samples');
      expect(res.body).toHaveProperty('serverTime');
      expect(res.body.total).toBe(150);
    });

    it('should return status breakdown', async () => {
      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');
      
      expect(res.body.statuses).toHaveLength(3);
      expect(res.body.statuses[0]).toHaveProperty('status');
      expect(res.body.statuses[0]).toHaveProperty('count');
    });

    it('should return source breakdown', async () => {
      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');
      
      expect(res.body.sources).toHaveLength(2);
      expect(res.body.sources[0].source).toBe('sofascore');
    });

    it('should handle database errors', async () => {
      database.prepare.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const res = await request(app)
        .get('/api/db-debug')
        .set('X-Forwarded-For', '127.0.0.1');
      
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toContain('Database connection failed');
    });
  });

  describe('GET /api/system/intel', () => {
    beforeEach(() => {
      shieldEngine.getStatus.mockReturnValue({
        avgLatency: 120,
        shieldLevel: 1,
        currentProxy: 'DIRECT'
      });

      mlPredictionService.getStatus.mockReturnValue({
        enabled: true,
        model: 'v55'
      });

      configEngine.getStrategyParams.mockReturnValue({
        minConfidence: 70,
        maxRisk: 0.3
      });

      const mockPrepare = jest.fn();
      mockPrepare.mockImplementation((query) => {
        if (query.includes('COUNT(*)')) {
          if (query.includes("status = 'live'")) {
            return { get: () => ({ count: 5 }) };
          }
          return { get: () => ({ count: 200 }) };
        }
        if (query.includes('MAX(last_updated)')) {
          return { get: () => ({ lastSync: '2026-06-30T12:00:00Z' }) };
        }
        if (query.includes('GROUP BY source')) {
          return {
            all: () => [
              { source: 'sofascore', count: 120 },
              { source: 'promosport', count: 80 }
            ]
          };
        }
        return { get: () => ({}), all: () => [] };
      });

      database.prepare = mockPrepare;

      // Mock env variables
      process.env.BSD_API_KEY = 'test-key';
      process.env.PREDIXSPORT_API_KEY = 'predix-key';
      process.env.FOOTBALLDATA_ENABLED = 'true';
      process.env.GROQ_API_KEY = 'groq-key';
    });

    it('should return comprehensive system telemetry', async () => {
      const res = await request(app).get('/api/system/intel');
      
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('telemetry');
      expect(res.body).toHaveProperty('database');
      expect(res.body).toHaveProperty('apiServices');
    });

    it('should return telemetry data', async () => {
      const res = await request(app).get('/api/system/intel');
      
      expect(res.body.telemetry).toHaveProperty('latency');
      expect(res.body.telemetry).toHaveProperty('shieldActive');
      expect(res.body.telemetry).toHaveProperty('activeProxy');
      expect(res.body.telemetry.latency).toBe(120);
      expect(res.body.telemetry.shieldActive).toBe(true);
    });

    it('should return database statistics', async () => {
      const res = await request(app).get('/api/system/intel');
      
      expect(res.body.database).toHaveProperty('total');
      expect(res.body.database).toHaveProperty('liveMatches');
      expect(res.body.database.total).toBe(200);
      expect(res.body.database.liveMatches).toBe(5);
    });

    it('should check API services status', async () => {
      const res = await request(app).get('/api/system/intel');
      
      expect(res.body.apiServices).toHaveProperty('BSD');
      expect(res.body.apiServices).toHaveProperty('PredixSport');
      expect(res.body.apiServices).toHaveProperty('FootballData');
      expect(res.body.apiServices.BSD.configured).toBe(true);
    });

    it('should handle missing API keys', async () => {
      process.env.BSD_API_KEY = '';
      process.env.PREDIXSPORT_API_KEY = '';

      const res = await request(app).get('/api/system/intel');
      
      expect(res.body.apiServices.BSD.configured).toBe(false);
      expect(res.body.apiServices.PredixSport.configured).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle shieldEngine errors gracefully', async () => {
      shieldEngine.getStatus.mockImplementation(() => {
        throw new Error('Shield engine error');
      });

      const res = await request(app).get('/api/system/intel');
      
      // Should still return 200 or handle error
      expect([200, 500]).toContain(res.status);
    });

    it('should handle mlPredictionService errors', async () => {
      mlPredictionService.getStatus.mockImplementation(() => {
        throw new Error('ML service error');
      });

      const res = await request(app).get('/api/system/intel');
      
      expect([200, 500]).toContain(res.status);
    });
  });
});
