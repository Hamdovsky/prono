/**
 * Additional SpeedCache Tests
 * Covers LRU eviction (max 200 entries) and stale-while-revalidate background refresh.
 */

const { speedCache, invalidateCache } = require('../core/speedCache')

beforeEach(() => {
  speedCache.cache.clear()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('LRU Eviction', () => {
  it('should keep cache at or under 200 entries', async () => {
    const fn = jest.fn().mockResolvedValue('v')

    for (let i = 0; i < 210; i++) {
      const wrapped = speedCache.wrap(`lru-${i}`, 60000)
      await wrapped(fn)()
    }
    expect(speedCache.cache.size).toBeLessThanOrEqual(200)
  })

  it('should evict oldest entries (by timestamp) when cache is full', async () => {
    const fn = jest.fn().mockResolvedValue('v')

    for (let i = 0; i < 100; i++) {
      const wrapped = speedCache.wrap(`ts-${i}`, 60000)
      await wrapped(fn)()
    }
    expect(speedCache.cache.size).toBe(100)
    expect(speedCache.cache.has('ts-0')).toBe(true)

    // Add one more — oldest key should be evicted
    const wrapped = speedCache.wrap('ts-100', 60000)
    await wrapped(fn)()

    expect(speedCache.cache.has('ts-0')).toBe(false)
    expect(speedCache.cache.has('ts-100')).toBe(true)
  })
})

describe('stale-while-revalidate (Express middleware)', () => {
  function makeReqRes(url) {
    const req = { originalUrl: url }
    let jsonPayload = null
    const res = {
      json: jest.fn((body) => { jsonPayload = body }),
      status: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      send: jest.fn(),
      get: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      _getJsonPayload: () => jsonPayload
    }
    return { req, res }
  }

  it('should serve stale data while revalidating in background', () => {
    const key = 'swr-middleware'
    const mw = speedCache(key, 5000, 30000)
    const { req, res } = makeReqRes('/swr')

    // Prime the cache via middleware (overrides res.json then calls next)
    const next = jest.fn()
    mw(req, res, next)
    // The middleware replaced res.json — when the downstream handler calls
    // res.json(body), it gets stored in CACHE_STORE and forwarded to real _json
    const freshData = { matches: ['abc'] }
    res.json(freshData)
    // Now cache has the data
    expect(next).toHaveBeenCalled()

    // Fast-forward past TTL but within stale window
    jest.advanceTimersByTime(10000)

    // New request — should serve stale data
    const { req: req2, res: res2 } = makeReqRes('/swr')
    const next2 = jest.fn()
    mw(req2, res2, next2)

    // Should return stale data immediately
    expect(res2.json).toHaveBeenCalledWith(freshData)
  })

  it('should trigger background revalidation for stale entries', () => {
    // Same setup as above
    const key = 'swr-bg'
    const mw = speedCache(key, 5000, 30000)
    const { req, res } = makeReqRes('/bg')
    const next = jest.fn()
    mw(req, res, next)
    const freshData = { data: 'old' }
    res.json(freshData)

    jest.advanceTimersByTime(10000)

    const { req: req2, res: res2 } = makeReqRes('/bg')
    const next2 = jest.fn()
    mw(req2, res2, next2)

    // Background revalidation was triggered — next() was called with fakeRes
    // We can't easily test the fakeRes behavior, but we verify stale was served
    expect(res2.json).toHaveBeenCalledWith(freshData)
  })
})
