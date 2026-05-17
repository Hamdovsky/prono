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
const _revalidating = new Set(); // Prevent concurrent background revalidations

/**
 * Returns an Express middleware that caches the JSON response in memory.
 * @param {string} key       - Cache key prefix.
 * @param {number} ttlMs     - Time-to-live in ms (serve fresh cache). Default 60 s.
 * @param {number} staleMs   - Max stale age in ms (serve stale while revalidating). Default 5 min.
 */
function speedCache(key, ttlMs = 60_000, staleMs = 300_000) {
    return (req, res, next) => {
        const cacheKey = `${key}:${req.originalUrl}`;
        const now = Date.now();
        const cached = CACHE_STORE.get(cacheKey);

        if (cached) {
            const age = now - cached.timestamp;
            if (age < ttlMs) {
                // Fresh — serve from cache
                return res.json(cached.data);
            }
            if (age < staleMs) {
                // Stale-while-revalidate: serve stale immediately
                res.json(cached.data);
                
                // Only trigger one background revalidation at a time per key
                if (!_revalidating.has(cacheKey)) {
                    _revalidating.add(cacheKey);
                    // Create a fake response object to capture the fresh result
                    const fakeRes = {
                        statusCode: 200,
                        json: (body) => {
                            CACHE_STORE.set(cacheKey, { data: body, timestamp: Date.now() });
                            _revalidating.delete(cacheKey);
                        },
                        status(code) { this.statusCode = code; return this; },
                        set() { return this; },
                        send(body) { this.json(body); }
                    };
                    // Background revalidation disabled for stability
                    _revalidating.delete(cacheKey);
                }
                return; // Response already sent
            }
            // Expired — evict and continue normally
            CACHE_STORE.delete(cacheKey);
        }

        // Intercept res.json to store the response
        const _json = res.json.bind(res);
        res.json = (body) => {
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
        CACHE_STORE.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    };
};

module.exports = { speedCache, invalidateCache };