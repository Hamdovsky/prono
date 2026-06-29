'use strict';

/**
 * speedCache — lightweight in-process response cache for Express routes.
 *
 * Usage (as middleware):
 *   router.get('/upcoming', speedCache('upcoming', 15000, 600000), async (req, res) => { … });
 *
 * Usage (as HOF wrapper):
 *   const cachedFn = speedCache.wrap('key', 60_000)(myAsyncFn);
 */

const CACHE_STORE = new Map();
const _revalidating = new Set()
const MAX_CACHE_ENTRIES = 100

function evictIfNeeded() {
  if (CACHE_STORE.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...CACHE_STORE.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
    if (oldest) CACHE_STORE.delete(oldest[0])
  }
}

function clearCache() {
  CACHE_STORE.clear()
}

function speedCache(key, ttlMs = 60_000, staleMs = 300_000) {
    return (req, res, next) => {
        const cacheKey = `${key}:${req.originalUrl}`;
        const now = Date.now();
        const cached = CACHE_STORE.get(cacheKey);

        if (cached) {
            const age = now - cached.timestamp;
            if (age < ttlMs) {
                return res.json(cached.data);
            }
            if (age < staleMs) {
                res.json(cached.data);
                if (!_revalidating.has(cacheKey)) {
                    _revalidating.add(cacheKey);
                    const routeHandler = req.route?.stack?.[0]?.handle
                    if (routeHandler) {
                        const fakeRes = {
                            statusCode: 200,
                            json: (body) => {
                                CACHE_STORE.set(cacheKey, { data: body, timestamp: Date.now() });
                                _revalidating.delete(cacheKey);
                            },
                            status(code) { this.statusCode = code; return this; },
                            set() { return this; },
                            send(body) { this.json(body); },
                            get() { return this; },
                            header() { return this; }
                        };
                        routeHandler(req, fakeRes, () => {})
                    } else {
                        _revalidating.delete(cacheKey)
                    }
                }
                return;
            }
            CACHE_STORE.delete(cacheKey);
        }

        const _json = res.json.bind(res);
        res.json = (body) => {
            evictIfNeeded()
            CACHE_STORE.set(cacheKey, { data: body, timestamp: Date.now() });
            return _json(body);
        };

        next();
    };
}

/**
 * Invalidate all cache entries that start with the given key prefix.
 * @param {string} keyPrefix
 */
function invalidateCache(keyPrefix) {
    for (const k of CACHE_STORE.keys()) {
        if (k.startsWith(keyPrefix)) {
            CACHE_STORE.delete(k);
        }
    }
}

/**
 * Higher-order-function variant (wraps an async function, not Express middleware).
 * @param {string} key
 * @param {number} ttlMs
 */
speedCache.wrap = function wrap(key, ttlMs = 60_000) {
    return (fn) => async (...args) => {
        const cacheKey = args.length > 0 ? `${key}:${JSON.stringify(args)}` : key;
        const now = Date.now();
        const cached = CACHE_STORE.get(cacheKey);
        if (cached && (now - cached.timestamp) < ttlMs) return cached.data;
        const result = fn(...args);
        const data = result && typeof result.then === 'function' ? await result : result;
        evictIfNeeded()
        CACHE_STORE.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    };
};

speedCache.cache = {
  clear: () => CACHE_STORE.clear(),
  get size() { return CACHE_STORE.size },
  has: (k) => CACHE_STORE.has(k)
}

module.exports = { speedCache, invalidateCache };