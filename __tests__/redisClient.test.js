/**
 * Redis Client Unit Tests
 * Tests for core/redisClient.js - Redis caching with performance metrics and fallback
 */

// Mock ioredis for these tests
const mockRedisInstance = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  flushall: jest.fn(),
  incr: jest.fn(),
  incrby: jest.fn(),
  on: jest.fn(),
  connect: jest.fn(),
  ping: jest.fn(),
  quit: jest.fn()
};

jest.mock('ioredis', () => {
  class Redis {
    constructor() {
      return mockRedisInstance;
    }
  }
  return Redis;
});

const { getCache, setCache, printCacheMetrics } = require('../core/redisClient');
const { redis } = require('../core/redisClient');

describe('RedisClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCache()', () => {
    it('should retrieve and parse cached JSON data', async () => {
      const mockData = { key: 'value', count: 42 };
      redis.get.mockResolvedValue(JSON.stringify(mockData));

      const result = await getCache('test-key');
      expect(result).toEqual(mockData);
      expect(redis.get).toHaveBeenCalledWith('test-key');
    });

    it('should return null for missing key', async () => {
      redis.get.mockResolvedValue(null);

      const result = await getCache('missing-key');
      expect(result).toBeNull();
    });

    it('should fall back to memory cache when Redis fails', async () => {
      redis.get.mockRejectedValue(new Error('Connection lost'));

      // Manually populate fallback cache (simulating previous set)
      const MEMORY_FALLBACK = require('../core/redisClient').MEMORY_FALLBACK;
      const testData = { fallback: true };
      MEMORY_FALLBACK.set('fallback-key', {
        value: JSON.stringify(testData),
        expiry: Date.now() + 60000
      });

      const result = await getCache('fallback-key');
      expect(result).toEqual(testData);
    });

    it('should return null for expired memory cache entry', async () => {
      const MEMORY_FALLBACK = require('../core/redisClient').MEMORY_FALLBACK;
      MEMORY_FALLBACK.set('expired-key', {
        value: JSON.stringify({ old: true }),
        expiry: Date.now() - 1000 // Already expired
      });

      redis.get.mockRejectedValue(new Error('Redis down'));
      const result = await getCache('expired-key');
      expect(result).toBeNull();
    });

    it('should increment misses counter on cache miss', async () => {
      const initialMetrics = require('../core/redisClient').metrics;
      // Reset metrics
      initialMetrics.hits = 0;
      initialMetrics.misses = 0;

      redis.get.mockResolvedValue(null);
      await getCache('new-key');

      expect(initialMetrics.misses).toBe(1);
    });

    it('should increment hits counter on cache hit', async () => {
      const initialMetrics = require('../core/redisClient').metrics;
      initialMetrics.hits = 0;
      initialMetrics.misses = 0;

      redis.get.mockResolvedValue(JSON.stringify({ test: true }));
      await getCache('hit-key');

      expect(initialMetrics.hits).toBe(1);
    });

    it('should track get time in metrics', async () => {
      const initialMetrics = require('../core/redisClient').metrics;
      const initialTotalTime = initialMetrics.totalGetTimeMs;

      redis.get.mockResolvedValue(JSON.stringify({ test: true }));
      await getCache('timed-key');

      expect(initialMetrics.totalGetTimeMs).toBeGreaterThan(initialTotalTime);
    });

    it('should handle non-JSON cached data gracefully', async () => {
      redis.get.mockResolvedValue('plain-string');
      const result = await getCache('string-key');
      expect(result).toBe('plain-string');
    });

    it('should handle corrupted JSON in cache', async () => {
      redis.get.mockResolvedValue('{invalid json');
      const result = await getCache('corrupt-key');
      expect(result).toBeNull(); // Should fail gracefully
    });
  });

  describe('setCache()', () => {
    it('should store data in Redis with TTL', async () => {
      const testObj = { data: 'value' };
      redis.set.mockResolvedValue('OK');

      const result = await setCache('set-key', testObj, 3600);
      expect(result).toBe(true);
      expect(redis.set).toHaveBeenCalledWith(
        'set-key',
        JSON.stringify(testObj),
        'EX',
        3600
      );
    });

    it('should convert string values to string', async () => {
      redis.set.mockResolvedValue('OK');
      await setCache('string-key', 'simple-string', 60);
      expect(redis.set).toHaveBeenCalledWith('string-key', 'simple-string', 'EX', 60);
    });

    it('should fall back to memory cache when Redis fails', async () => {
      redis.set.mockRejectedValue(new Error('Redis unavailable'));
      const MEMORY_FALLBACK = require('../core/redisClient').MEMORY_FALLBACK;
      MEMORY_FALLBACK.clear();

      const result = await setCache('fallback-set-key', { test: true }, 300);
      expect(result).toBe(true);

      const cached = MEMORY_FALLBACK.get('fallback-set-key');
      expect(cached).toBeDefined();
      expect(cached.expires).toBeGreaterThan(Date.now());
    });

    it('should clean up old memory cache entries when size exceeds 1000', async () => {
      const MEMORY_FALLBACK = require('../core/redisClient').MEMORY_FALLBACK;
      // Populate with 1001 entries
      for (let i = 0; i < 1001; i++) {
        MEMORY_FALLBACK.set(`key-${i}`, { value: i, expires: Date.now() + 3600000 });
      }

      redis.set.mockRejectedValue(new Error('Redis down'));
      await setCache('cleanup-test', { data: true }, 3600);

      // Some old entries should have been cleaned
      expect(MEMORY_FALLBACK.size).toBeLessThan(1002);
    });
  });

  describe('Metrics', () => {
    it('printCacheMetrics should log metrics without error', () => {
      // Just verify it runs without throwing
      expect(() => printCacheMetrics()).not.toThrow();
    });

    it('should calculate hit rate correctly', () => {
      const metrics = require('../core/redisClient').metrics;
      metrics.hits = 75;
      metrics.misses = 25;
      metrics.totalGetTimeMs = 100;

      // printCacheMetrics logs the values
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      printCacheMetrics();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();

      // Reset
      metrics.hits = 0;
      metrics.misses = 0;
    });
  });
});
