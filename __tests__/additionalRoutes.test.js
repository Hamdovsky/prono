/**
 * API Routes - Integration Style Tests for Additional Critical Routes
 * Tests for routes/learn.js, routes/analytics.js, routes/integration.js, routes/promosport.js
 */

const request = require('supertest');
const express = require('express');

describe('Additional API Routes', () => {
  describe('Learn Routes (/api/learn)', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      const learnRoutes = require('../routes/learn');
      app.use('/api/learn', learnRoutes);
    });

    it('should handle learning endpoints', async () => {
      // Test stub - actual endpoints may vary based on implementation
      // Placeholder to ensure routes load without errors
      const response = await request(app).get('/api/learn');
      // May return 404 or specific data depending on routes defined
      expect([200, 404, 500]).toContain(response.status);
    });
  });

  describe('Analytics Routes (/api/analytics)', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      const analyticsRoutes = require('../routes/analytics');
      app.use('/api', analyticsRoutes);
    });

    it('should have analytics endpoints', async () => {
      // Add specific tests for analytics endpoints when implemented
      const response = await request(app).get('/api/analytics');
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('Integration Routes (/api/webhook)', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      const integrationRoutes = require('../routes/integration');
      // These routes typically require authentication
      app.use('/api/webhook', integrationRoutes);
    });

    it('should require authentication for webhook', async () => {
      const response = await request(app).post('/api/webhook').send({});
      expect(response.status).toBe(401);
    });

    it('should accept valid auth token', async () => {
      const response = await request(app)
        .post('/api/webhook')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ event: 'test' });

      // Should either succeed (200) or validation error (400), not auth error
      expect([200, 400, 500]).toContain(response.status);
      expect(response.status).not.toBe(401);
    });
  });

  describe('Promosport Routes (/api/promosport)', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      const promosportRoutes = require('../routes/promosport');
      app.use('/api/promosport', promosportRoutes);
    });

    it('should return promosport grid when available', async () => {
      const response = await request(app).get('/api/promosport');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('matches');
      expect(Array.isArray(response.body.matches)).toBe(true);
      if (response.body.matches.length > 0) {
        expect(response.body.matches[0]).toHaveProperty('home');
        expect(response.body.matches[0]).toHaveProperty('away');
        expect(response.body.matches[0]).toHaveProperty('pred');
      }
    });

    it('should include date in response', async () => {
      const response = await request(app).get('/api/promosport');
      expect(response.body).toHaveProperty('date');
    });
  });

  describe('Combos Routes (/api/combos)', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      const comboRoutes = require('../routes/combos');
      app.use('/api/combos', comboRoutes);
    });

    it('should respond to combos endpoints', async () => {
      // Verify routes load correctly
      const response = await request(app).get('/api/combos');
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('Config API (/api/config)', () => {
    let app;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      const configRoutes = require('../routes/system');
      app.use('/api', configRoutes);
    });

    it('should require authentication for config updates', async () => {
      const response = await request(app)
        .post('/api/config')
        .send({ scraperUrl: 'http://new-url' });

      expect(response.status).toBe(401);
    });

    it('should update config with valid token', async () => {
      // Mock config engine
      const configEngine = require('../core/configEngine');
      jest.spyOn(configEngine, 'save').mockResolvedValue({});

      const response = await request(app)
        .post('/api/config')
        .set('Authorization', 'Bearer Matrix22!')
        .send({ scraperUrl: 'http://new-url', thresholds: { minConfidence: 60 } });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });
});
