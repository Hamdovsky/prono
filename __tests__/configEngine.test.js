/**
 * Config Engine Unit Tests
 * Tests for core/configEngine.js - Configuration management
 */

const configEngine = require('../core/configEngine');

describe('ConfigEngine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('config singleton', () => {
    it('should have default configuration values', () => {
      expect(configEngine.config).toBeDefined();
      expect(typeof configEngine.config).toBe('object');
    });

    it('should have thresholds property', () => {
      expect(configEngine.config).toHaveProperty('thresholds');
      expect(configEngine.config.thresholds).toHaveProperty('min_confidence');
      expect(configEngine.config.thresholds).toHaveProperty('max_odds');
    });

    it('should have scraper configuration', () => {
      expect(configEngine.config).toHaveProperty('scraper');
      expect(configEngine.config.scraper).toHaveProperty('timeout');
      expect(configEngine.config.scraper).toHaveProperty('retries');
    });

    it('should have strategy configuration', () => {
      expect(configEngine.config).toHaveProperty('strategy');
      expect(typeof configEngine.config.strategy).toBe('string');
    });
  });

  describe('get()', () => {
    it('should return config value by key', () => {
      const strategy = configEngine.get('strategy');
      expect(strategy).toBeDefined();
      expect(typeof strategy).toBe('string');
    });

    it('should return default value if key not found', () => {
      const nonexistent = configEngine.get('nonexistent_key', 'default-value');
      expect(nonexistent).toBe('default-value');
    });

    it('should return thresholds object', () => {
      const thresholds = configEngine.get('thresholds');
      expect(thresholds).toBeDefined();
      expect(thresholds).toHaveProperty('min_confidence');
    });
  });

  describe('getStrategyParams()', () => {
    it('should return strategy parameters object', () => {
      const params = configEngine.getStrategyParams();
      expect(params).toBeDefined();
      expect(params).toHaveProperty('label');
      expect(params).toHaveProperty('oddsCap');
    });
  });

  describe('save()', () => {
    it('should save configuration without errors', async () => {
      // Implementation writes to .env or config file
      const result = await configEngine.save();
      expect(result).toBeDefined();
    });
  });

  describe('updateEnv()', () => {
    it('should update environment variables', async () => {
      const key = 'TEST_VAR';
      const value = 'test-value';
      
      await configEngine.updateEnv(key, value);
      expect(process.env[key]).toBe(value);

      // Cleanup
      delete process.env[key];
    });
  });

  describe('Configuration source', () => {
    it('config should be loaded and accessible', () => {
      // Config is loaded on module initialization
      const config = configEngine.config;
      expect(Object.keys(config).length).toBeGreaterThan(0);
    });
  });
});
