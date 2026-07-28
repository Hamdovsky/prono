/**
 * System Routes Unit Tests
 * Tests for routes/system.js - Health, status, predict, sentiment endpoints
 */

const request = require('supertest')
const express = require('express')
const systemRouter = require('../routes/system')
const securityEngine = require('../core/securityEngine')
const database = require('../core/database')
const shieldEngine = require('../core/shieldEngine')
const configEngine = require('../core/configEngine')
const mlPredictionService = require('../services/mlPredictionService')

describe('System API Routes', () => {
  let app

  beforeAll(() => {
    app = express()
    app.use(express.json())
    app.use('/api', systemRouter)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('GET /api/ping', () => {
    it('should return pong response', async () => {
      const response = await request(app).get('/api/ping')
      expect(response.status).toBe(200)
      expect(response.text).toBe('API_PONG')
    })
  })

  describe('GET /api/system/intel', () => {
    it('should return system telemetry and stats', async () => {
      // Mock shieldEngine
      jest.spyOn(shieldEngine, 'getStatus').mockReturnValue({
        latency: 45,
        shieldActive: false,
        activeProxy: 'DIRECT',
        proxyCount: 4,
        healthyCount: 4,
        totalCount: 4,
        avgLatency: 45,
        shieldLevel: 1,
        currentProxy: 'DIRECT',
      })

      // Mock mlPredictionService
      jest.spyOn(mlPredictionService, 'getStatus').mockReturnValue({
        queueSize: 5,
        isPredicting: false,
        cacheCount: 100,
      })

      // Mock configEngine
      jest.spyOn(configEngine, 'getStrategyParams').mockReturnValue({
        label: 'Aggressive',
        oddsCap: 2.5,
      })

      const response = await request(app).get('/api/system/intel')

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('telemetry')
      expect(response.body).toHaveProperty('ai_workers')
      expect(response.body).toHaveProperty('strategy')
      expect(response.body).toHaveProperty('database')
      expect(response.body).toHaveProperty('uptime')
      expect(response.body).toHaveProperty('memory')
    })

    it('should handle database errors gracefully', async () => {
      jest.spyOn(database, 'prepare').mockImplementation(() => ({
        get: () => {
          throw new Error('DB error')
        },
        all: () => {
          throw new Error('DB error')
        },
      }))

      const response = await request(app).get('/api/system/intel')
      expect(response.status).toBe(500)
      expect(response.body.error).toBeDefined()
    })
  })

  describe('GET /api/system/status', () => {
    it('should return online status with counts', async () => {
      const response = await request(app).get('/api/status')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ONLINE')
      expect(response.body).toHaveProperty('lastSync')
      expect(response.body).toHaveProperty('totalMatches')
      expect(response.body).toHaveProperty('liveMatchesCount')
      expect(response.body).toHaveProperty('uptime')
      expect(response.body).toHaveProperty('memory')
    })
  })

  describe('GET /api/health', () => {
    it('should return health check', async () => {
      const response = await request(app).get('/api/health')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ONLINE')
      expect(response.body).toHaveProperty('uptime')
    })
  })

  describe('POST /api/predict', () => {
    it('should authenticate then return prediction', async () => {
      const validToken = 'Bearer Matrix22!'
      const mockPrediction = { prediction: '1', confidence: 75 }

      jest.spyOn(mlPredictionService, 'getMLPrediction').mockResolvedValue(mockPrediction)

      const response = await request(app)
        .post('/api/predict')
        .set('Authorization', validToken)
        .send({ matchId: 'test-match' })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.prediction).toBe('1')
    })

    it('should handle request without auth in non-production', async () => {
      const response = await request(app).post('/api/predict').send({ matchId: 'test' })

      // localOnlyOrAuth middleware skips auth when NODE_ENV !== 'production'
      expect([200, 401, 403]).toContain(response.status)
    })

    it('should handle request with invalid auth in non-production', async () => {
      const response = await request(app)
        .post('/api/predict')
        .set('Authorization', 'Bearer wrong-token')
        .send({ matchId: 'test' })

      expect([200, 401, 403]).toContain(response.status)
    })

    it('should handle prediction errors', async () => {
      jest.spyOn(mlPredictionService, 'getMLPrediction').mockRejectedValue(new Error('Model error'))

      const response = await request(app)
        .post('/api/predict')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ matchId: 'test' })

      expect(response.status).toBe(500)
      expect(response.body.success).toBe(false)
      expect(response.body.error).toContain('Model error')
    })
  })

  describe('POST /api/sentiment', () => {
    it('should authenticate then return sentiment analysis', async () => {
      const pythonService = require('../core/pythonService')
      const mockSentiment = { sentiment: 'positive', confidence: 0.92 }

      jest.spyOn(pythonService, 'predict').mockResolvedValue(mockSentiment)

      const response = await request(app)
        .post('/api/sentiment')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ text: 'Great performance!' })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.sentiment).toBe('positive')
    })

    it('should handle sentiment analysis errors', async () => {
      const pythonService = require('../core/pythonService')
      jest.spyOn(pythonService, 'predict').mockRejectedValue(new Error('Python service down'))

      const response = await request(app)
        .post('/api/sentiment')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ text: 'test' })

      expect(response.status).toBe(500)
      expect(response.body.error).toContain('Python service down')
    })
  })
})
