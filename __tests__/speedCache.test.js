/**
 * Speed Cache Unit Tests
 * Tests for core/speedCache.js - In-memory caching with TTL
 */

const { speedCache, invalidateCache } = require('../core/speedCache')

describe('SpeedCache', () => {
  beforeEach(() => {
    // Clear cache between tests
    speedCache.cache.clear()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('speedCache.wrap()', () => {
    it('should cache function results with TTL', async () => {
      const mockFn = jest.fn().mockResolvedValue('cached-value')

      const cachedFn = speedCache.wrap('test-key', 10000)(mockFn)

      // First call - execute function
      const result1 = await cachedFn()
      expect(result1).toBe('cached-value')
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Second call before TTL - should return cached
      const result2 = await cachedFn()
      expect(result2).toBe('cached-value')
      expect(mockFn).toHaveBeenCalledTimes(1) // Still 1
    })

    it('should re-execute function after TTL expires', async () => {
      const mockFn = jest.fn().mockResolvedValue('fresh-value')

      const cachedFn = speedCache.wrap('ttl-test', 5000)(mockFn)

      // First call
      await cachedFn()
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Fast-forward past TTL
      jest.advanceTimersByTime(11000)

      // Next call should re-execute
      await cachedFn()
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should invalidate cache when requested', async () => {
      const mockFn = jest.fn().mockResolvedValue('value')

      const cachedFn = speedCache.wrap('invalidate-test', 10000)(mockFn)
      await cachedFn()
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Invalidate cache
      invalidateCache('invalidate-test')

      // Next call should re-execute
      await cachedFn()
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should accept args and use them in cache key', async () => {
      const mockFn = jest.fn().mockImplementation((x) => x * 2)

      const cachedFn = speedCache.wrap('with-args', 10000)(mockFn)

      const result1 = await cachedFn(5)
      expect(result1).toBe(10)
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Different args should execute again (different cache key)
      const result2 = await cachedFn(10)
      expect(result2).toBe(20)
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should handle synchronous functions', async () => {
      const mockFn = jest.fn().mockReturnValue(42)

      const cachedFn = speedCache.wrap('sync-test', 10000)(mockFn)
      const result = await cachedFn()

      expect(result).toBe(42)
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Call again
      const result2 = await cachedFn()
      expect(result2).toBe(42)
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should handle errors in wrapped function', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('failed'))

      // Wrap doesn't cache errors — each call re-executes
      const cachedFn = speedCache.wrap('error-test', 10000)(mockFn)
      await expect(cachedFn()).rejects.toThrow('failed')
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Error does not cache — second call should retry
      await expect(cachedFn()).rejects.toThrow()
      expect(mockFn).toHaveBeenCalledTimes(2)
    })
  })

  describe('invalidateCache()', () => {
    it('should clear specific cache key', async () => {
      const mockFn1 = jest.fn().mockResolvedValue('value1')
      const mockFn2 = jest.fn().mockResolvedValue('value2')

      await speedCache.wrap('key1', 10000)(mockFn1)()
      await speedCache.wrap('key2', 10000)(mockFn2)()

      expect(mockFn1).toHaveBeenCalledTimes(1)
      expect(mockFn2).toHaveBeenCalledTimes(1)

      // Invalidate only key1
      invalidateCache('key1')

      // key1 cache cleared, key2 still intact
      await speedCache.wrap('key1', 10000)(mockFn1)()
      expect(mockFn1).toHaveBeenCalledTimes(2)

      await speedCache.wrap('key2', 10000)(mockFn2)()
      expect(mockFn2).toHaveBeenCalledTimes(1) // Still cached
    })

    it('should be safe to call with non-existent key', () => {
      expect(() => invalidateCache('nonexistent')).not.toThrow()
    })
  })

  describe('Cache statistics', () => {
    it('should maintain cache size', () => {
      const fn = () => 1
      speedCache.wrap('stat-key-1', 10000)(fn)()
      speedCache.wrap('stat-key-2', 10000)(fn)()

      expect(speedCache.cache.size).toBe(2)
    })

    it('should automatically evict expired entries on access', async () => {
      const mockFn = jest.fn().mockResolvedValue('expire-test')

      const cachedFn = speedCache.wrap('expire-key', 5000)(mockFn)
      await cachedFn()

      // Fast-forward past TTL
      jest.advanceTimersByTime(15000)

      // Access should re-execute
      await cachedFn()
      expect(mockFn).toHaveBeenCalledTimes(2)
    })
  })
})
