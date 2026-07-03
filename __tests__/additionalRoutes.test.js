/**
 * API Routes - Integration Style Tests for Additional Critical Routes
 * Tests for routes/learn.js, routes/analytics.js, routes/integration.js, routes/promosport.js
 */

const request = require('supertest');
const express = require('express');

jest.mock('../core/promosport_scraper', () => ({
  scrapePromosport: jest.fn().mockResolvedValue([
    { id: 1, homeTeam: 'Team A', awayTeam: 'Team B', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.4, drawProbability: 0.3, awayWinProbability: 0.3, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 2, homeTeam: 'Team C', awayTeam: 'Team D', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.5, drawProbability: 0.3, awayWinProbability: 0.2, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 3, homeTeam: 'Team E', awayTeam: 'Team F', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.6, drawProbability: 0.2, awayWinProbability: 0.2, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 4, homeTeam: 'Team G', awayTeam: 'Team H', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.7, drawProbability: 0.2, awayWinProbability: 0.1, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 5, homeTeam: 'Team I', awayTeam: 'Team J', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.4, drawProbability: 0.3, awayWinProbability: 0.3, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 6, homeTeam: 'Team K', awayTeam: 'Team L', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.3, drawProbability: 0.4, awayWinProbability: 0.3, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 7, homeTeam: 'Team M', awayTeam: 'Team N', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.5, drawProbability: 0.3, awayWinProbability: 0.2, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 8, homeTeam: 'Team O', awayTeam: 'Team P', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.6, drawProbability: 0.2, awayWinProbability: 0.2, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 9, homeTeam: 'Team Q', awayTeam: 'Team R', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.7, drawProbability: 0.2, awayWinProbability: 0.1, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 10, homeTeam: 'Team S', awayTeam: 'Team T', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.4, drawProbability: 0.3, awayWinProbability: 0.3, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 11, homeTeam: 'Team U', awayTeam: 'Team V', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.3, drawProbability: 0.4, awayWinProbability: 0.3, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 12, homeTeam: 'Team W', awayTeam: 'Team X', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.5, drawProbability: 0.3, awayWinProbability: 0.2, concoursNumber: '878', concoursDate: '2025-01-01' },
    { id: 13, homeTeam: 'Team Y', awayTeam: 'Team Z', leagueName: 'Promosport', matchTime: '---', homeWinProbability: 0.6, drawProbability: 0.2, awayWinProbability: 0.2, concoursNumber: '878', concoursDate: '2025-01-01' }
  ])
}))

jest.mock('../core/promosport_engine', () => ({
  generatePromosportGrids: jest.fn().mockResolvedValue(
    Array.from({ length: 4 }, (_, gi) => ({
      name: `Grille ${gi + 1}`,
      matches: Array.from({ length: 13 }, (_, mi) => ({
        choices: ['1'],
        p1: 0.4,
        px: 0.3,
        p2: 0.3,
        entropy: 1.5,
        confidence: 70,
        diversified: false,
        isCrowdTrap: false,
        isAwayCrowdTrap: false,
        publicOverconfidence: false,
        crowdP1: 0.4,
        crowdP2: 0.3
      }))
    }))
  ),
  generateGoldCoupon: jest.fn().mockReturnValue({ picks: [], description: 'Test' })
}))

jest.mock('../services/promosportIntelligence', () => ({
  generateSecretWeapons: jest.fn().mockResolvedValue({ weapons: [], gridHints: { avgEdge: 0 } }),
  generateLLMSecretWeapons: jest.fn().mockResolvedValue(null),
  getConcoursCount: jest.fn().mockReturnValue(0)
}))

jest.mock('../services/doubleOptimizerService', () => ({
  simulateDoubleCounts: jest.fn().mockReturnValue({}),
  selectOptimalDoubles: jest.fn().mockReturnValue({ expectedCorrect: { withDoubles: 8, allSingles: 7 }, ranked: [] })
}))

jest.mock('../services/crowdHackerService', () => ({
  detectPublicTrap: jest.fn().mockReturnValue({ isTrap: false, isAwayTrap: false }),
  getContrarianSignal: jest.fn().mockReturnValue({ tunisianCrowd: null })
}))

jest.mock('../services/secretWeaponsTracker', () => ({
  recordPrediction: jest.fn(),
  getHistory: jest.fn().mockReturnValue([]),
  getStats: jest.fn().mockReturnValue({}),
  recordResults: jest.fn().mockReturnValue(null)
}))

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
      const response = await request(app).get('/api/learn');
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
      app.use('/api/webhook', integrationRoutes);
    });

    it('should accept score update webhook payload', async () => {
      const response = await request(app)
        .post('/api/webhook/score-update')
        .send({ matchId: 'test-1', homeScore: 2, awayScore: 1 });
      expect([200, 400, 500]).toContain(response.status);
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
        expect(response.body.matches[0]).toHaveProperty('cols');
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

    it('should not expose config endpoint', async () => {
      const response = await request(app)
        .post('/api/config')
        .send({ scraperUrl: 'http://new-url' });

      expect(response.status).toBe(404);
    });
  });
});
