/**
 * Shield Engine Unit Tests
 * Tests for core/shieldEngine.js - System health and proxy rotation
 */

const fs = require('fs');
const path = require('path');

// Mock fs to simulate proxies.txt
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    readFileSync: jest.fn((filePath, encoding) => {
      if (filePath.includes('proxies.txt')) {
        return 'http://proxy1:8080\nhttp://proxy2:8080\nhttp://proxy3:8080\n';
      }
      return actualFs.readFileSync(filePath, encoding);
    }),
    existsSync: jest.fn((filePath) => {
      if (filePath.includes('proxies.txt')) return true;
      return actualFs.existsSync(filePath);
    })
  };
});

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
      proxyCount: 4
    };
    shieldEngine.healthyProxies = ['DIRECT', 'http://proxy1:8080', 'http://proxy2:8080', 'http://proxy3:8080'];
    shieldEngine.currentIndex = 0;
    jest.clearAllMocks();
  });

  describe('updateStatus()', () => {
    it('should update latency without activating shield when latency is normal', () => {
      const result = shieldEngine.updateStatus(500);
      expect(result.latency).toBe(500);
      expect(result.shieldActive).toBe(false);
      expect(result.activeProxy).toBe('DIRECT');
    });

    it('should activate shield when latency exceeds 2000ms with real proxies', () => {
      const result = shieldEngine.updateStatus(2500);
      expect(result.shieldActive).toBe(true);
      expect(result.activeProxy).toBe('http://proxy1:8080');
    });

    it('should not activate shield without real proxies even if latency high', () => {
      shieldEngine.healthyProxies = ['DIRECT'];
      const result = shieldEngine.updateStatus(2500);
      expect(result.shieldActive).toBe(false);
      expect(result.activeProxy).toBe('DIRECT');
    });

    it('should rotate through proxy list on multiple high-latency events', () => {
      // High latency call 1: rotates to proxy1
      shieldEngine.updateStatus(2500);
      expect(shieldEngine.systemHealth.activeProxy).toBe('http://proxy1:8080');

      // High latency call 2: rotates to proxy2
      shieldEngine.updateStatus(2500);
      expect(shieldEngine.systemHealth.activeProxy).toBe('http://proxy2:8080');
    });

    it('should not reset to DIRECT when latency recovers (code only rotates on high latency)', () => {
      // First, activate shield
      shieldEngine.updateStatus(2500);
      expect(shieldEngine.systemHealth.activeProxy).not.toBe('DIRECT');

      // Recover — code does NOT auto-reset to DIRECT (it only rotates up)
      shieldEngine.updateStatus(500);
      expect(shieldEngine.systemHealth.activeProxy).not.toBe('DIRECT');
    });
  });

  describe('getStatus()', () => {
    it('should return system health object', () => {
      const status = shieldEngine.getStatus();
      expect(status).toHaveProperty('latency');
      expect(status).toHaveProperty('proxyCount');
      expect(status).toHaveProperty('shieldActive');
      expect(status).toHaveProperty('activeProxy');
    });

    it('should return accurate status with current values', () => {
      shieldEngine.systemHealth.latency = 100;
      shieldEngine.systemHealth.shieldActive = true;
      shieldEngine.systemHealth.activeProxy = 'http://proxy1:8080';

      const status = shieldEngine.getStatus();
      expect(status).toHaveProperty('latency', 100);
      expect(status).toHaveProperty('activeProxy', 'http://proxy1:8080');
      expect(status).toHaveProperty('shieldActive', true);
    });
  });

  describe('getProxy()', () => {
    it('should return current active proxy', () => {
      expect(shieldEngine.getProxy()).toBe('DIRECT');
      
      shieldEngine.systemHealth.activeProxy = 'http://proxy1:8080';
      expect(shieldEngine.getProxy()).toBe('http://proxy1:8080');
    });
  });
});
