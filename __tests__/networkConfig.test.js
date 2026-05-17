/**
 * Network Config Unit Tests
 * Tests for core/networkConfig.js - HTTP pooling and retry configuration
 */

const { pooledConfig } = require('../core/networkConfig');

describe('NetworkConfig', () => {
  describe('pooledConfig', () => {
    it('should have agent configuration for HTTP/HTTPS', () => {
      expect(pooledConfig).toBeDefined();
      expect(pooledConfig).toHaveProperty('httpAgent');
      expect(pooledConfig).toHaveProperty('httpsAgent');
    });

    it('should have timeout configuration', () => {
      expect(pooledConfig).toHaveProperty('timeout');
      expect(typeof pooledConfig.timeout).toBe('number');
      expect(pooledConfig.timeout).toBeGreaterThan(0);
    });

    it('should have keepAlive enabled', () => {
      expect(pooledConfig.keepAlive).toBe(true);
    });

    it('should have maxSockets configured', () => {
      expect(pooledConfig).toHaveProperty('maxSockets');
      expect(pooledConfig.maxSockets).toBeGreaterThan(0);
    });

    it('should have retry configuration', () => {
      expect(pooledConfig).toHaveProperty('retries');
      expect(pooledConfig).toHaveProperty('retryDelay');
    });

    it('should have reasonable default timeout', () => {
      // Typical timeout is 10000ms (10s)
      expect(pooledConfig.timeout).toBe(10000);
    });
  });

  describe('Agent configuration', () => {
    it('should create valid httpAgent', () => {
      const { httpAgent } = pooledConfig;
      expect(httpAgent).toBeDefined();
      expect(httpAgent.keepAlive).toBe(true);
    });

    it('should create valid httpsAgent', () => {
      const { httpsAgent } = pooledConfig;
      expect(httpsAgent).toBeDefined();
      expect(httpsAgent.keepAlive).toBe(true);
    });
  });
});
