/**
 * Speed Cache Unit Tests
 * Tests for core/speedCache.js - In-memory caching with TTL
 */

const { speedCache, invalidateCache } = require('../core/speedCache');

describe('SpeedCache', () => {
  beforeEach(() => {
    // Clear cache between tests
    speedCache.cache.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('speedCache()', () => {
    it('should cache function results with TTL', async () => {
      const mockFn = jest.fn().mockResolvedValue('cached-value');
      
      // First call - execute function
      const result1 = await speedCache('test-key', 5000, 10000)(mockFn)();
      expect(result1).toBe('cached-value');
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Second call before TTL - should return cached
      const result2 = await speedCache('test-key', 5000, 10000)(mockFn)();
      expect(result2).toBe('cached-value');
      expect(mockFn).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should re-execute function after TTL expires', async () => {
      const mockFn = jest.fn().mockResolvedValue('fresh-value');

      const cachedFn = speedCache('ttl-test', 5000, 10000);
      
      // First call
      await cachedFn(mockFn)();
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Fast-forward past TTL
      jest.advanceTimersByTime(11000);

      // Next call should re-execute
      await cachedFn(mockFn)();
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should invalidate cache when requested', async () => {
      const mockFn = jest.fn().mockResolvedValue('value');

      const cachedFn = speedCache('invalidate-test', 5000, 10000);
      await cachedFn(mockFn)();
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Invalidate cache
      invalidateCache('invalidate-test');

      // Next call should re-execute
      await cachedFn(mockFn)();
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should accept args and use them in cache key', async () => {
      const mockFn = jest.fn().mockImplementation((x) => x * 2);

      const cachedFn = speedCache('with-args', 5000, 10000);
      
      const result1 = await cachedFn(mockFn)(5);
      expect(result1).toBe(10);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Different args should execute again (different cache key)
      const result2 = await cachedFn(mockFn)(10);
      expect(result2).toBe(20);
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should handle synchronous functions', () => {
      const mockFn = jest.fn().mockReturnValue(42);

      const cachedFn = speedCache('sync-test', 5000, 10000);
      const result = cachedFn(mockFn)();

      expect(result).toBe(42);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Call again
      const result2 = cachedFn(mockFn)();
      expect(result2).toBe(42);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should handle errors in wrapped function', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('failed'));

      const cachedFn = speedCache('error-test', 5000, 10000);
      await expect(cachedFn(mockFn)()).rejects.toThrow('failed');
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Error does not cache (or does it? depending on implementation, errors typically not cached)
      // Second call should retry
      await expect(cachedFn(mockFn)()).rejects.toThrow();
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateCache()', () => {
    it('should clear specific cache key', async () => {
      const mockFn1 = jest.fn().mockResolvedValue('value1');
      const mockFn2 = jest.fn().mockResolvedValue('value2');

      await speedCache('key1', 5000, 10000)(mockFn1)();
      await speedCache('key2', 5000, 10000)(mockFn2)();

      expect(mockFn1).toHaveBeenCalledTimes(1);
      expect(mockFn2).toHaveBeenCalledTimes(1);

      // Invalidate only key1
      invalidateCache('key1');

      // key1 cache cleared, key2 still intact
      await speedCache('key1', 5000, 10000)(mockFn1)();
      expect(mockFn1).toHaveBeenCalledTimes(2);

      await speedCache('key2', 5000, 10000)(mockFn2)();
      expect(mockFn2).toHaveBeenCalledTimes(1); // Still cached
    });

    it('should be safe to call with non-existent key', () => {
      expect(() => invalidateCache('nonexistent')).not.toThrow();
    });
  });

  describe('Cache statistics', () => {
    it('should maintain cache size', () => {
      // speedCache uses a Map internally; verify it stores items
      const fn = () => 1;
      speedCache('stat-key-1', 5000, 10000)(fn)();
      speedCache('stat-key-2', 5000, 10000)(fn)();

      expect(speedCache.cache.size).toBe(2);
    });

    it('should automatically evict expired entries on access', async () => {
      const mockFn = jest.fn().mockResolvedValue('expire-test');

      const cachedFn = speedCache('expire-key', 5000, 10000);
      await cachedFn(mockFn)();

      // Fast-forward past both TTL and stale TTL
      jest.advanceTimersByTime(15000);

      // Access should clean up expired entry
      await cachedFn(mockFn)();
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });
});
