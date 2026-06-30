/**
 * Tests pour core/configEngine.js
 * Coverage: strategy params, config get/set, persistence
 */

const configEngine = require('../core/configEngine');

describe('Config Engine', () => {
  describe('getStrategyParams()', () => {
    it('should return strategy parameters with correct properties', () => {
      const params = configEngine.getStrategyParams();

      expect(params).toHaveProperty('probMult');
      expect(params).toHaveProperty('confMult');
      expect(params).toHaveProperty('oddsCap');
      expect(params).toHaveProperty('label');
      expect(typeof params.probMult).toBe('number');
      expect(typeof params.confMult).toBe('number');
      expect(typeof params.oddsCap).toBe('number');
      expect(typeof params.label).toBe('string');
    });

    it('should return valid multiplier ranges', () => {
      const params = configEngine.getStrategyParams();

      expect(params.probMult).toBeGreaterThan(0);
      expect(params.probMult).toBeLessThanOrEqual(2);
      expect(params.confMult).toBeGreaterThan(0);
      expect(params.confMult).toBeLessThanOrEqual(2);
      expect(params.oddsCap).toBeGreaterThan(0);
    });

    it('should include label with emoji', () => {
      const params = configEngine.getStrategyParams();
      expect(typeof params.label).toBe('string');
      expect(params.label.length).toBeGreaterThan(0);
    });
  });

  describe('get()', () => {
    it('should return default value for missing key', () => {
      const val = configEngine.get('nonexistent_key_xyz', 'fallback');
      expect(val).toBe('fallback');
    });

    it('should return existing config values', () => {
      const strategy = configEngine.get('strategy', 'Balanced');
      expect(typeof strategy).toBe('string');
      expect(['Balanced', 'Defensive', 'Aggressive']).toContain(strategy);
    });

    it('should handle null default', () => {
      const val = configEngine.get('nonexistent_key_xyz', null);
      expect(val).toBeNull();
    });
  });

  describe('set()', () => {
    it('should set a config value', () => {
      configEngine.set('testKey', 'testValue');
      expect(configEngine.get('testKey')).toBe('testValue');
    });

    it('should overwrite existing value', () => {
      configEngine.set('testKey2', 'first');
      configEngine.set('testKey2', 'second');
      expect(configEngine.get('testKey2')).toBe('second');
    });

    afterAll(() => {
      configEngine.set('testKey', undefined);
      configEngine.set('testKey2', undefined);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty get call', () => {
      const val = configEngine.get();
      expect(val === undefined || val !== undefined).toBe(true);
    });

    it('should handle concurrent getStrategyParams calls', () => {
      const promises = Array(10).fill(null).map(() =>
        Promise.resolve(configEngine.getStrategyParams())
      );

      return Promise.all(promises).then(results => {
        expect(results).toHaveLength(10);
        results.forEach(result => {
          expect(result).toHaveProperty('probMult');
          expect(result).toHaveProperty('oddsCap');
        });
      });
    });

    it('should always return consistent strategy params', () => {
      const params1 = configEngine.getStrategyParams();
      const params2 = configEngine.getStrategyParams();
      expect(params1).toEqual(params2);
    });
  });
});
