/**
 * Redis Cache Service Unit Tests
 * Tests for services/redisCache.js - High-level caching service with fallback
 */

const redisCache = require('../services/redisCache');
const { RedisMemoryServer } = require('redis-memory-server');

describe('RedisCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the singleton state
    redisCache.redis = null;
    redisCache.fallbackCache.clear();
    redisCache.suppressRedisErrors = false;
  });

  describe('init()', () => {
    it('should initialize Redis from config', async () => {
      const mockRedis = {
        ping: jest.fn().mockResolvedValue('PONG')
      };
      const redisConfig = require('../../config/redis.config');
      redisConfig.connect = jest.fn().mockResolvedValue(mockRedis);

      await redisCache.init();

      expect(redisConfig.connect).toHaveBeenCalled();
      expect(redisCache.redis).toBe(mockRedis);
    });

    it('should fall back to in-memory Redis server if config fails', async () => {
      const redisConfig = require('../../config/redis.config');
      redisConfig.connect = jest.fn().mockRejectedValue(new Error('Connection failed'));

      // Mock RedisMemoryServer
      const mockMemoryServer = {
        getHost: jest.fn().mockResolvedValue('127.0.0.1'),
        getPort: jest.fn().mockResolvedValue(6379),
        start: jest.fn().mockResolvedValue(undefined)
      };
      RedisMemoryServer.mockImplementation(() => mockMemoryServer);

      const mockRedis = { ping: jest.fn().mockResolvedValue('PONG') };
      const RealRedis = require('ioredis');
      jest.mocked(RealRedis).mockImplementation(() => mockRedis);

      await redisCache.init();

      expect(RedisMemoryServer).toHaveBeenCalled();
      expect(redisCache.redis).toBe(mockRedis);
    });

    it('should handle RedisMemoryServer failure and use Map fallback', async () => {
      const redisConfig = require('../../config/redis.config');
      redisConfig.connect = jest.fn().mockRejectedValue(new Error('Failed'));

      // Make RedisMemoryServer fail
      RedisMemoryServer.mockImplementation(() => {
        throw new Error('Cannot start memory server');
      });

      await redisCache.init();
      // Should not crash, redis stays null
      expect(redisCache.redis).toBeNull();
    });
  });

  describe('set() and get()', () => {
    beforeEach(async () => {
      // Initialize with in-memory Redis mock
      const mockRedis = {
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null)
      };
      redisCache.redis = mockRedis;
    });

    it('should store and retrieve data via Redis', async () => {
      const mockRedis = redisCache.redis;
      mockRedis.get.mockResolvedValue(JSON.stringify({ cached: true }));

      const setResult = await redisCache.set('cache-key', { cached: true }, 300);
      expect(setResult).toBe(true);

      const getResult = await redisCache.get('cache-key');
      expect(getResult).toEqual({ cached: true });
    });

    it('should fall back to memory cache when Redis get fails', async () => {
      const mockRedis = redisCache.redis;
      mockRedis.get.mockRejectedValue(new Error('Connection lost'));

      // Pre-populate fallback
      const now = Date.now();
      redisCache.fallbackCache.set('fallback-key', {
        value: JSON.stringify({ fromMemory: true }),
        expires: now + 60000
      });

      const result = await redisCache.get('fallback-key');
      expect(result).toEqual({ fromMemory: true });
    });

    it('should return null for expired memory cache entry', async () => {
      const mockRedis = redisCache.redis;
      mockRedis.get.mockRejectedValue(new Error('Redis down'));

      // Set expired entry
      redisCache.fallbackCache.set('expired-key', {
        value: JSON.stringify({ expired: true }),
        expires: Date.now() - 1000
      });

      const result = await redisCache.get('expired-key');
      expect(result).toBeNull();
    });

    it('should store in fallback when Redis set fails', async () => {
      const mockRedis = redisCache.redis;
      mockRedis.set.mockRejectedValue(new Error('Redis write error'));

      const result = await redisCache.set('fallback-store-key', { data: true }, 600);
      expect(result).toBe(true);

      const cached = redisCache.fallbackCache.get('fallback-store-key');
      expect(cached).toBeDefined();
    });
  });

  describe('Specialized methods', () => {
    beforeEach(() => {
      redisCache.redis = { setex: jest.fn().mockResolvedValue('OK'), get: jest.fn().mockResolvedValue(null) };
    });

    it('setLiveMatches() should store with correct key pattern', async () => {
      await redisCache.setLiveMatches([{ match: 1 }], 300);
      expect(redisCache.redis.setex).toHaveBeenCalledWith('matches:live', 300, '[{"match":1}]');
    });

    it('getLiveMatches() should retrieve from correct key', async () => {
      redisCache.redis.get.mockResolvedValue('[{"live":true}]');
      const result = await redisCache.getLiveMatches();
      expect(result).toEqual([{ live: true }]);
    });

    it('setUpcomingMatches() should work correctly', async () => {
      await redisCache.setUpcomingMatches([{ upcoming: true }], 3600);
      expect(redisCache.redis.setex).toHaveBeenCalledWith('matches:upcoming', 3600, '[{"upcoming":true}]');
    });

    it('getUpcomingMatches() should work correctly', async () => {
      redisCache.redis.get.mockResolvedValue('[{"upcoming":true}]');
      const result = await redisCache.getUpcomingMatches();
      expect(result).toEqual([{ upcoming: true }]);
    });

    it('setTeamHistory() should use team-specific key', async () => {
      await redisCache.setTeamHistory('Barcelona', [{ win: true }], 86400);
      expect(redisCache.redis.setex).toHaveBeenCalledWith('team:Barcelona:history', 86400, '[{"win":true}]');
    });

    it('getTeamHistory() should retrieve from team-specific key', async () => {
      redisCache.redis.get.mockResolvedValue('[{"history":true}]');
      const result = await redisCache.getTeamHistory('Real Madrid');
      expect(result).toEqual([{ history: true }]);
    });

    it('incrementDailyMatchCount() should increment counter', async () => {
      redisCache.redis.incrby = jest.fn().mockResolvedValue(5);
      const count = await redisCache.incrementDailyMatchCount(3);
      expect(count).toBe(5);
      expect(redisCache.redis.incrby).toHaveBeenCalled();
    });

    it('getDailyMatchCount() should return current count', async () => {
      redisCache.redis.get = jest.fn().mockResolvedValue('42');
      const count = await redisCache.getDailyMatchCount();
      expect(count).toBe(42);
    });

    it('purgeAll() should flush Redis and clear fallback', async () => {
      redisCache.redis = { flushall: jest.fn().mockResolvedValue('OK') };
      const result = await redisCache.purgeAll();
      expect(result).toBe(true);
      expect(redisCache.redis.flushall).toHaveBeenCalled();
      expect(redisCache.fallbackCache.size).toBe(0);
    });

    it('close() should disconnect Redis and clear fallback', async () => {
      const redisConfig = require('../../config/redis.config');
      redisConfig.disconnect = jest.fn().mockResolvedValue(undefined);
      
      await redisCache.close();
      expect(redisConfig.disconnect).toHaveBeenCalled();
      expect(redisCache.fallbackCache.size).toBe(0);
    });
  });

  describe('Error suppression', () => {
    it('should suppress repeated Redis errors', () => {
      const mockRedis = {
        set: jest.fn().mockRejectedValue(new Error('Connection error')),
        get: jest.fn().mockRejectedValue(new Error('Connection error'))
      };
      redisCache.redis = mockRedis;

      // First error should log
      await redisCache.set('key1', { test: 1 });
      expect(mockRedis.set).toHaveBeenCalledTimes(1);

      // Subsequent errors within 60 seconds should be suppressed
      await redisCache.set('key2', { test: 2 });
      await redisCache.set('key3', { test: 3 });
      // Still called but error handling suppressed
      expect(mockRedis.set).toHaveBeenCalledTimes(3);
    });
  });
});
