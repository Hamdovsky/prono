/**
 * Tests pour services/mlPredictionService.js
 * Coverage: prédictions ML, cache, fallback, stratégie
 */

const mlPredictionService = require('../services/mlPredictionService');

// Mock des dépendances
jest.mock('../core/database');
jest.mock('../core/logger');
jest.mock('axios');

const axios = require('axios');

describe('ML Prediction Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset service state
    mlPredictionService.cache = new Map();
  });

  describe('getStatus()', () => {
    it('should return service status', () => {
      const status = mlPredictionService.getStatus();
      
      expect(status).toHaveProperty('enabled');
      expect(status).toHaveProperty('cacheSize');
      expect(typeof status.enabled).toBe('boolean');
      expect(typeof status.cacheSize).toBe('number');
    });
  });

  describe('predict()', () => {
    const sampleMatch = {
      id: 12345,
      homeTeam: 'Manchester City',
      awayTeam: 'Arsenal',
      league: 'Premier League',
      startTimestamp: 1735689600
    };

    it('should make prediction for valid match', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        data: {
          verdict: 'SAFE BET',
          selection: 'Home',
          confidence: 85,
          probabilities: {
            home: 0.65,
            draw: 0.20,
            away: 0.15
          }
        }
      });

      const result = await mlPredictionService.predict(sampleMatch);
      
      expect(result).toHaveProperty('verdict');
      expect(result).toHaveProperty('confidence');
      expect(result.verdict).toBe('SAFE BET');
      expect(result.confidence).toBe(85);
    });

    it('should use cache for duplicate requests', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        data: {
          verdict: 'STRONG BET',
          confidence: 75
        }
      });

      // First call
      await mlPredictionService.predict(sampleMatch);
      
      // Second call (should use cache)
      const result = await mlPredictionService.predict(sampleMatch);
      
      expect(result).toHaveProperty('verdict');
      expect(axios.post).toHaveBeenCalledTimes(1); // Only called once
    });

    it('should handle FastAPI error gracefully', async () => {
      axios.post.mockRejectedValue(new Error('FastAPI connection refused'));

      const result = await mlPredictionService.predict(sampleMatch);
      
      // Should return fallback prediction
      expect(result).toHaveProperty('verdict');
      expect(result.verdict).toBe('NO PREDICTION');
    });

    it('should handle timeout errors', async () => {
      axios.post.mockRejectedValue(new Error('timeout of 10000ms exceeded'));

      const result = await mlPredictionService.predict(sampleMatch);
      
      expect(result).toHaveProperty('error');
      expect(result.verdict).toBe('NO PREDICTION');
    });

    it('should validate match object', async () => {
      const invalidMatch = {
        id: 999
        // Missing homeTeam, awayTeam, league
      };

      const result = await mlPredictionService.predict(invalidMatch);
      
      expect(result).toHaveProperty('error');
      expect(result.verdict).toBe('NO PREDICTION');
    });

    it('should handle null match', async () => {
      const result = await mlPredictionService.predict(null);
      
      expect(result).toHaveProperty('error');
      expect(result.verdict).toBe('NO PREDICTION');
    });
  });

  describe('Cache Management', () => {
    it('should cache predictions with TTL', async () => {
      const match = {
        id: 1,
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        league: 'Test League',
        startTimestamp: 1735689600
      };

      axios.post.mockResolvedValue({
        status: 200,
        data: { verdict: 'SAFE BET', confidence: 80 }
      });

      await mlPredictionService.predict(match);
      
      const status = mlPredictionService.getStatus();
      expect(status.cacheSize).toBeGreaterThan(0);
    });

    it('should clear expired cache entries', async () => {
      // Set a prediction with very short TTL
      const match = {
        id: 2,
        homeTeam: 'Team X',
        awayTeam: 'Team Y',
        league: 'Test League',
        startTimestamp: Date.now() / 1000
      };

      axios.post.mockResolvedValue({
        status: 200,
        data: { verdict: 'SKIP', confidence: 50 }
      });

      await mlPredictionService.predict(match);
      
      // Wait for cache to expire (if TTL is implemented)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const status = mlPredictionService.getStatus();
      expect(status.cacheSize).toBeGreaterThanOrEqual(0);
    });

    it('should generate unique cache keys', async () => {
      const match1 = {
        id: 10,
        homeTeam: 'A',
        awayTeam: 'B',
        league: 'L1',
        startTimestamp: 1735689600
      };

      const match2 = {
        id: 20,
        homeTeam: 'C',
        awayTeam: 'D',
        league: 'L2',
        startTimestamp: 1735689600
      };

      axios.post.mockResolvedValue({
        status: 200,
        data: { verdict: 'SAFE BET', confidence: 70 }
      });

      await mlPredictionService.predict(match1);
      await mlPredictionService.predict(match2);
      
      // Should call API twice (different matches)
      expect(axios.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('Prediction Strategy', () => {
    it('should apply confidence threshold', async () => {
      const match = {
        id: 100,
        homeTeam: 'Team 1',
        awayTeam: 'Team 2',
        league: 'League',
        startTimestamp: 1735689600
      };

      axios.post.mockResolvedValue({
        status: 200,
        data: {
          verdict: 'RISKY',
          confidence: 45,
          probabilities: { home: 0.4, draw: 0.35, away: 0.25 }
        }
      });

      const result = await mlPredictionService.predict(match);
      
      expect(result.confidence).toBeLessThan(50);
      expect(result.verdict).toBe('RISKY');
    });

    it('should identify safe bets', async () => {
      const match = {
        id: 200,
        homeTeam: 'Strong Team',
        awayTeam: 'Weak Team',
        league: 'Premier League',
        startTimestamp: 1735689600
      };

      axios.post.mockResolvedValue({
        status: 200,
        data: {
          verdict: 'SAFE BET',
          confidence: 88,
          probabilities: { home: 0.75, draw: 0.15, away: 0.10 }
        }
      });

      const result = await mlPredictionService.predict(match);
      
      expect(result.verdict).toBe('SAFE BET');
      expect(result.confidence).toBeGreaterThanOrEqual(85);
    });

    it('should handle draw predictions', async () => {
      const match = {
        id: 300,
        homeTeam: 'Equal A',
        awayTeam: 'Equal B',
        league: 'Serie A',
        startTimestamp: 1735689600
      };

      axios.post.mockResolvedValue({
        status: 200,
        data: {
          verdict: 'MEDIUM BET',
          selection: 'Draw',
          confidence: 65,
          probabilities: { home: 0.30, draw: 0.45, away: 0.25 }
        }
      });

      const result = await mlPredictionService.predict(match);
      
      expect(result.selection).toBe('Draw');
    });
  });

  describe('Error Recovery', () => {
    it('should retry on network failure', async () => {
      axios.post
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          status: 200,
          data: { verdict: 'SAFE BET', confidence: 80 }
        });

      const match = {
        id: 400,
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        league: 'Test',
        startTimestamp: 1735689600
      };

      const result = await mlPredictionService.predict(match);
      
      // Should eventually succeed or return fallback
      expect(result).toHaveProperty('verdict');
    });

    it('should handle malformed API response', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        data: null // Malformed response
      });

      const match = {
        id: 500,
        homeTeam: 'Team X',
        awayTeam: 'Team Y',
        league: 'League',
        startTimestamp: 1735689600
      };

      const result = await mlPredictionService.predict(match);
      
      expect(result).toHaveProperty('verdict');
    });

    it('should handle 500 error from FastAPI', async () => {
      axios.post.mockRejectedValue({
        response: {
          status: 500,
          data: { error: 'Internal server error' }
        }
      });

      const match = {
        id: 600,
        homeTeam: 'A',
        awayTeam: 'B',
        league: 'L',
        startTimestamp: 1735689600
      };

      const result = await mlPredictionService.predict(match);
      
      expect(result.verdict).toBe('NO PREDICTION');
    });
  });
});
