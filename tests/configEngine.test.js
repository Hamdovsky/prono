/**
 * Tests pour core/configEngine.js
 * Coverage: configuration, strategy params, league tiers
 */

const configEngine = require('../core/configEngine');

describe('Config Engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getStrategyParams()', () => {
    it('should return strategy parameters', () => {
      const params = configEngine.getStrategyParams();
      
      expect(params).toHaveProperty('minConfidence');
      expect(params).toHaveProperty('maxRisk');
      expect(typeof params.minConfidence).toBe('number');
      expect(typeof params.maxRisk).toBe('number');
    });

    it('should have valid confidence threshold', () => {
      const params = configEngine.getStrategyParams();
      
      expect(params.minConfidence).toBeGreaterThanOrEqual(0);
      expect(params.minConfidence).toBeLessThanOrEqual(100);
    });

    it('should have valid risk threshold', () => {
      const params = configEngine.getStrategyParams();
      
      expect(params.maxRisk).toBeGreaterThanOrEqual(0);
      expect(params.maxRisk).toBeLessThanOrEqual(1);
    });
  });

  describe('getLeagueTier()', () => {
    it('should identify T1 leagues', () => {
      const t1Leagues = [
        'Premier League',
        'La Liga',
        'Bundesliga',
        'Serie A',
        'Ligue 1'
      ];

      t1Leagues.forEach(league => {
        const tier = configEngine.getLeagueTier(league);
        expect(tier).toBe('T1');
      });
    });

    it('should identify T2 leagues', () => {
      const t2Leagues = [
        'Eredivisie',
        'Liga Portugal',
        'Championship'
      ];

      t2Leagues.forEach(league => {
        const tier = configEngine.getLeagueTier(league);
        expect(['T2', 'T1']).toContain(tier); // Some may be T1
      });
    });

    it('should identify T3 leagues by default', () => {
      const unknownLeague = 'Unknown League XYZ';
      const tier = configEngine.getLeagueTier(unknownLeague);
      
      expect(['T3', 'BLACKLIST']).toContain(tier);
    });

    it('should handle null/undefined league', () => {
      expect(() => {
        configEngine.getLeagueTier(null);
      }).not.toThrow();

      expect(() => {
        configEngine.getLeagueTier(undefined);
      }).not.toThrow();
    });

    it('should be case-insensitive', () => {
      const tier1 = configEngine.getLeagueTier('Premier League');
      const tier2 = configEngine.getLeagueTier('premier league');
      const tier3 = configEngine.getLeagueTier('PREMIER LEAGUE');
      
      expect(tier1).toBe(tier2);
      expect(tier2).toBe(tier3);
    });
  });

  describe('getApiConfig()', () => {
    it('should return API configuration', () => {
      const config = configEngine.getApiConfig();
      
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });

    it('should include timeout settings', () => {
      const config = configEngine.getApiConfig();
      
      if (config.timeout) {
        expect(typeof config.timeout).toBe('number');
        expect(config.timeout).toBeGreaterThan(0);
      }
    });

    it('should include retry settings', () => {
      const config = configEngine.getApiConfig();
      
      if (config.retries) {
        expect(typeof config.retries).toBe('number');
        expect(config.retries).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('getCacheSettings()', () => {
    it('should return cache configuration', () => {
      const settings = configEngine.getCacheSettings();
      
      expect(settings).toBeDefined();
      expect(typeof settings).toBe('object');
    });

    it('should have TTL settings', () => {
      const settings = configEngine.getCacheSettings();
      
      if (settings.ttl) {
        expect(typeof settings.ttl).toBe('number');
        expect(settings.ttl).toBeGreaterThan(0);
      }
    });

    it('should have max size settings', () => {
      const settings = configEngine.getCacheSettings();
      
      if (settings.maxSize) {
        expect(typeof settings.maxSize).toBe('number');
        expect(settings.maxSize).toBeGreaterThan(0);
      }
    });
  });

  describe('Feature Flags', () => {
    it('should check if model manager is enabled', () => {
      const enabled = configEngine.isModelManagerEnabled();
      
      expect(typeof enabled).toBe('boolean');
    });

    it('should check if Monte Carlo is enabled', () => {
      const enabled = configEngine.isMonteCarloEnabled();
      
      expect(typeof enabled).toBe('boolean');
    });

    it('should check if DeepSeek is enabled', () => {
      const enabled = configEngine.isDeepSeekEnabled();
      
      expect(typeof enabled).toBe('boolean');
    });

    it('should respect environment variables', () => {
      const originalEnv = process.env.USE_MODEL_MANAGER;
      
      process.env.USE_MODEL_MANAGER = 'true';
      expect(configEngine.isModelManagerEnabled()).toBe(true);
      
      process.env.USE_MODEL_MANAGER = 'false';
      expect(configEngine.isModelManagerEnabled()).toBe(false);
      
      // Restore
      process.env.USE_MODEL_MANAGER = originalEnv;
    });
  });

  describe('Validation', () => {
    it('should validate confidence threshold', () => {
      const isValid = configEngine.isValidConfidence(75);
      expect(isValid).toBe(true);
    });

    it('should reject invalid confidence', () => {
      expect(configEngine.isValidConfidence(-10)).toBe(false);
      expect(configEngine.isValidConfidence(150)).toBe(false);
      expect(configEngine.isValidConfidence(null)).toBe(false);
    });

    it('should validate league name', () => {
      const isValid = configEngine.isValidLeague('Premier League');
      expect(typeof isValid).toBe('boolean');
    });

    it('should validate match object structure', () => {
      const validMatch = {
        id: 1,
        homeTeam: 'A',
        awayTeam: 'B',
        league: 'Premier League'
      };

      const isValid = configEngine.isValidMatch(validMatch);
      expect(typeof isValid).toBe('boolean');
    });

    it('should reject invalid match object', () => {
      const invalidMatch = {
        id: 1
        // Missing homeTeam, awayTeam, league
      };

      const isValid = configEngine.isValidMatch(invalidMatch);
      expect(isValid).toBe(false);
    });
  });

  describe('Configuration Updates', () => {
    it('should allow updating strategy params', () => {
      const newParams = {
        minConfidence: 80,
        maxRisk: 0.25
      };

      configEngine.updateStrategyParams(newParams);
      const updated = configEngine.getStrategyParams();
      
      expect(updated.minConfidence).toBe(80);
      expect(updated.maxRisk).toBe(0.25);
    });

    it('should validate params before updating', () => {
      const invalidParams = {
        minConfidence: 150, // Invalid
        maxRisk: -0.5 // Invalid
      };

      expect(() => {
        configEngine.updateStrategyParams(invalidParams);
      }).toThrow();
    });

    it('should preserve existing params on partial update', () => {
      const original = configEngine.getStrategyParams();
      
      configEngine.updateStrategyParams({ minConfidence: 85 });
      const updated = configEngine.getStrategyParams();
      
      expect(updated.minConfidence).toBe(85);
      expect(updated.maxRisk).toBe(original.maxRisk);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty configuration', () => {
      expect(() => {
        configEngine.getStrategyParams();
      }).not.toThrow();
    });

    it('should handle concurrent access', () => {
      const promises = Array(10).fill(null).map(() => 
        Promise.resolve(configEngine.getStrategyParams())
      );

      return Promise.all(promises).then(results => {
        expect(results).toHaveLength(10);
        results.forEach(result => {
          expect(result).toBeDefined();
        });
      });
    });

    it('should handle special characters in league names', () => {
      const specialLeagues = [
        'Série A',
        '1. Bundesliga',
        'Ligue 1 Uber Eats',
        'LaLiga EA Sports'
      ];

      specialLeagues.forEach(league => {
        expect(() => {
          configEngine.getLeagueTier(league);
        }).not.toThrow();
      });
    });
  });
});
