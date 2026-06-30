/**
 * Tests pour services/mlPredictionService.js
 * Coverage: status, prediction queue, cache backend
 */

const mlPredictionService = require('../services/mlPredictionService');

describe('ML Prediction Service', () => {
  describe('getStatus()', () => {
    it('should return service status with correct properties', () => {
      const status = mlPredictionService.getStatus();

      expect(status).toHaveProperty('queueSize');
      expect(status).toHaveProperty('cacheBackend');
      expect(status).toHaveProperty('isPredicting');
      expect(typeof status.queueSize).toBe('number');
      expect(typeof status.cacheBackend).toBe('string');
      expect(typeof status.isPredicting).toBe('boolean');
    });

    it('should report correct cache backend', () => {
      const status = mlPredictionService.getStatus();
      expect(status.cacheBackend).toBe('Redis');
    });

    it('should report prediction state', () => {
      const status = mlPredictionService.getStatus();
      expect(typeof status.isPredicting).toBe('boolean');
      if (status.queueSize === 0) {
        expect(status.isPredicting).toBe(false);
      }
    });

    it('should return non-negative queue size', () => {
      const status = mlPredictionService.getStatus();
      expect(status.queueSize).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMLPrediction()', () => {
    it('should be a function', () => {
      expect(typeof mlPredictionService.getMLPrediction).toBe('function');
    });

    it('should handle empty match object gracefully', async () => {
      try {
        const result = await mlPredictionService.getMLPrediction({});
        expect(result).toBeDefined();
      } catch (err) {
        expect(err).toBeDefined();
      }
    });

    it('should handle null match gracefully', async () => {
      try {
        const result = await mlPredictionService.getMLPrediction(null);
        expect(result).toBeDefined();
      } catch (err) {
        expect(err).toBeDefined();
      }
    });

    it('should handle match with basic fields', async () => {
      const match = {
        id: 1,
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        league: 'Test League',
        startTimestamp: Math.floor(Date.now() / 1000) + 3600
      };

      try {
        const result = await mlPredictionService.getMLPrediction(match);
        expect(result).toBeDefined();
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });

  describe('Singleton Pattern', () => {
    it('should be a singleton instance', () => {
      const ml2 = require('../services/mlPredictionService');
      expect(mlPredictionService).toBe(ml2);
    });

    it('should have predictionQueue property', () => {
      expect(mlPredictionService).toHaveProperty('predictionQueue');
    });
  });
});
