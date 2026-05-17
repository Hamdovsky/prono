/**
 * System Routes Unit Tests
 * Tests for routes/system.js - Health, status, predict, sentiment endpoints
 */

const request = require('supertest');
const express = require('express');
const systemRouter = require('../routes/system');
const securityEngine = require('../core/securityEngine');
const database = require('../core/database');
const shieldEngine = require('../core/shieldEngine');
const configEngine = require('../core/configEngine');
const mlPredictionService = require('../services/mlPredictionService');

describe('System API Routes', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', systemRouter);
  });

  describe('GET /api/ping', () => {
    it('should return pong response', async () => {
      const response = await request(app).get('/api/ping');
      expect(response.status).toBe(200);
      expect(response.text).toBe('API_PONG');
    });
  });

  describe('GET /api/system/intel', () => {
    it('should return system telemetry and stats', async () => {
      // Mock shieldEngine
      jest.spyOn(shieldEngine, 'getStats').mockReturnValue({
        avgLatency: 45,
        shieldLevel: 1,
        currentProxy: 'DIRECT',
        shieldActive: false
      });

      // Mock mlPredictionService
      jest.spyOn(mlPredictionService, 'getStatus').mockReturnValue({
        queueSize: 5,
        isPredicting: false,
        cacheCount: 100
      });

      // Mock configEngine
      jest.spyOn(configEngine, 'getStrategyParams').mockReturnValue({
        label: 'Aggressive',
        oddsCap: 2.5
      });

      const response = await request(app).get('/api/system/intel');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('telemetry');
      expect(response.body).toHaveProperty('ai_workers');
      expect(response.body).toHaveProperty('strategy');
      expect(response.body).toHaveProperty('database');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('memory');
    });

    it('should handle database errors gracefully', async () => {
      jest.spyOn(database.prepare, 'SELECT * FROM matches').mockImplementation(() => ({
        get: () => { throw new Error('DB error'); },
        all: () => { throw new Error('DB error'); }
      }));

      const response = await request(app).get('/api/system/intel');
      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /api/system/status', () => {
    it('should return online status with counts', async () => {
      const response = await request(app).get('/api/system/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ONLINE');
      expect(response.body).toHaveProperty('lastSync');
      expect(response.body).toHaveProperty('totalMatches');
      expect(response.body).toHaveProperty('liveMatchesCount');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('memory');
    });
  });

  describe('GET /api/system/health', () => {
    it('should return health check', async () => {
      const response = await request(app).get('/api/system/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ONLINE');
      expect(response.body).toHaveProperty('diagnostic');
    });
  });

  describe('POST /api/system/predict', () => {
    it('should authenticate then return prediction', async () => {
      const validToken = 'Bearer Matrix22!';
      const mockPrediction = { prediction: '1', confidence: 75 };

      jest.spyOn(mlPredictionService, 'getMLPrediction').mockResolvedValue(mockPrediction);

      const response = await request(app)
        .post('/api/system/predict')
        .set('Authorization', validToken)
        .send({ matchId: 'test-match' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.prediction).toBe('1');
    });

    it('should reject request without token', async () => {
      const response = await request(app)
        .post('/api/system/predict')
        .send({ matchId: 'test' });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Unauthorized');
    });

    it('should reject request with invalid token', async () => {
      const response = await request(app)
        .post('/api/system/predict')
        .set('Authorization', 'Bearer wrong-token')
        .send({ matchId: 'test' });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Forbidden');
    });

    it('should handle prediction errors', async () => {
      jest.spyOn(mlPredictionService, 'getMLPrediction').mockRejectedValue(new Error('Model error'));

      const response = await request(app)
        .post('/api/system/predict')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ matchId: 'test' });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Model error');
    });
  });

  describe('POST /api/system/sentiment', () => {
    it('should authenticate then return sentiment analysis', async () => {
      const pythonService = require('../core/pythonService');
      const mockSentiment = { sentiment: 'positive', confidence: 0.92 };

      jest.spyOn(pythonService, 'predict').mockResolvedValue(mockSentiment);

      const response = await request(app)
        .post('/api/system/sentiment')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ text: 'Great performance!' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.sentiment).toBe('positive');
    });

    it('should handle sentiment analysis errors', async () => {
      const pythonService = require('../core/pythonService');
      jest.spyOn(pythonService, 'predict').mockRejectedValue(new Error('Python service down'));

      const response = await request(app)
        .post('/api/system/sentiment')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ text: 'test' });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Python service down');
    });
  });
});
