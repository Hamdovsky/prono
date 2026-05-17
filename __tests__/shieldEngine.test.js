/**
 * Shield Engine Unit Tests
 * Tests for core/shieldEngine.js - System health and proxy rotation
 */

const shieldEngine = require('../core/shieldEngine');
const logger = require('../core/logger');

describe('ShieldEngine', () => {
  beforeEach(() => {
    // Reset state between tests
    shieldEngine.systemHealth = {
      latency: 45,
      memory: '128MB',
      shieldActive: false,
      activeProxy: 'DIRECT',
      uptime: 0
    };
    jest.clearAllMocks();
  });

  describe('updateStatus()', () => {
    it('should update latency without activating shield when latency is normal', () => {
      const result = shieldEngine.updateStatus(500);
      expect(result.latency).toBe(500);
      expect(result.shieldActive).toBe(false);
      expect(result.activeProxy).toBe('DIRECT');
    });

    it('should activate shield when latency exceeds 1500ms with real proxies', () => {
      // Simulate having real proxies configured
      process.env.PROXY_1 = 'http://proxy1.example.com:8080';
      
      const result = shieldEngine.updateStatus(2000);
      expect(result.shieldActive).toBe(true);
      // Should rotate to first proxy
      expect(result.activeProxy).toBe('http://proxy1.example.com:8080');

      delete process.env.PROXY_1;
    });

    it('should not activate shield without real proxies even if latency high', () => {
      // No PROXY_* env vars
      const result = shieldEngine.updateStatus(2000);
      expect(result.shieldActive).toBe(false);
      expect(result.activeProxy).toBe('DIRECT');
    });

    it('should rotate through proxy list on multiple high-latency events', () => {
      process.env.PROXY_1 = 'http://proxy1:8080';
      process.env.PROXY_2 = 'http://proxy2:8080';
      process.env.PROXY_3 = 'http://proxy3:8080';

      // High latency call 1
      shieldEngine.updateStatus(2000);
      expect(shieldEngine.systemHealth.activeProxy).toBe('http://proxy1:8080');

      // High latency call 2 - call updateStatus enough times to trigger rotation
      // Shield is already active, so on next call with high latency it will rotate
      shieldEngine.updateStatus(2000); // Still high, should rotate
      // The code rotates on every call when shieldActive is true and latency > 1500
      expect(shieldEngine.systemHealth.activeProxy).toBe('http://proxy2:8080');

      delete process.env.PROXY_1;
      delete process.env.PROXY_2;
      delete process.env.PROXY_3;
    });

    it('should reset to DIRECT when latency recovers below 800ms', () => {
      // First, activate shield
      process.env.PROXY_1 = 'http://proxy1:8080';
      shieldEngine.updateStatus(2000);
      expect(shieldEngine.systemHealth.activeProxy).not.toBe('DIRECT');

      // Recover
      shieldEngine.updateStatus(500);
      expect(shieldEngine.systemHealth.shieldActive).toBe(false);
      expect(shieldEngine.systemHealth.activeProxy).toBe('DIRECT');

      delete process.env.PROXY_1;
    });
  });

  describe('getStats()', () => {
    it('should return accurate stats object', () => {
      shieldEngine.systemHealth.latency = 100;
      shieldEngine.systemHealth.shieldActive = true;
      shieldEngine.systemHealth.activeProxy = 'http://proxy1:8080';

      const stats = shieldEngine.getStats();
      expect(stats).toHaveProperty('avgLatency', 100);
      expect(stats).toHaveProperty('shieldLevel', 1);
      expect(stats).toHaveProperty('currentProxy', 'http://proxy1:8080');
      expect(stats).toHaveProperty('shieldActive', true);
    });
  });

  describe('getStatus()', () => {
    it('should return system health object', () => {
      const status = shieldEngine.getStatus();
      expect(status).toHaveProperty('latency');
      expect(status).toHaveProperty('memory');
      expect(status).toHaveProperty('shieldActive');
      expect(status).toHaveProperty('activeProxy');
    });
  });

  describe('getProxy()', () => {
    it('should return current active proxy', () => {
      expect(shieldEngine.getProxy()).toBe('DIRECT');
      
      shieldEngine.systemHealth.activeProxy = 'http://proxy1:8080';
      expect(shieldEngine.getProxy()).toBe('http://proxy1:8080');
    });
  });

  describe('Initial state', () => {
    it('should have correct default values', () => {
      const freshInstance = require('../core/shieldEngine');
      expect(freshInstance.systemHealth.latency).toBe(45);
      expect(freshInstance.systemHealth.memory).toBe('128MB');
      expect(freshInstance.systemHealth.shieldActive).toBe(false);
      expect(freshInstance.systemHealth.activeProxy).toBe('DIRECT');
    });
  });
});
