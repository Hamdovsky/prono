import { Request, Response, NextFunction, RequestHandler } from 'express'

interface CacheEntry {
  data: unknown
  timestamp: number
}

const CACHE_STORE = new Map<string, CacheEntry>()
const _revalidating = new Set<string>()
const MAX_CACHE_ENTRIES = 100

function setNoStore(res: Response): void {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
  } catch (_) {}
}

function evictIfNeeded(): void {
  if (CACHE_STORE.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...CACHE_STORE.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
    if (oldest) CACHE_STORE.delete(oldest[0])
  }
}

function clearCache(): void {
  CACHE_STORE.clear()
}

function speedCache(key: string, ttlMs: number = 60_000, staleMs: number = 300_000): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cacheKey = `${key}:${req.originalUrl}`
    const now = Date.now()
    const cached = CACHE_STORE.get(cacheKey)

    if (cached) {
      const age = now - cached.timestamp
      if (age < ttlMs) {
        setNoStore(res)
        res.json(cached.data)
        return
      }
      if (age < staleMs) {
        setNoStore(res)
        res.json(cached.data)
        if (!_revalidating.has(cacheKey)) {
          _revalidating.add(cacheKey)
          const route = (req as unknown as { route?: { stack: { handle?: RequestHandler }[] } }).route
          const stack = route?.stack
          const realHandler = stack && stack.length > 1 ? stack[stack.length - 1].handle : null
          if (realHandler) {
            const fakeRes = {
              statusCode: 200,
              json: (body: unknown) => {
                CACHE_STORE.set(cacheKey, { data: body, timestamp: Date.now() })
                _revalidating.delete(cacheKey)
              },
              status(_code: number) { return this },
              set() { return this },
              send(body: unknown) { this.json(body) },
              get() { return this },
              header() { return this },
            } as unknown as Response
            try {
              realHandler(req, fakeRes, () => {})
            } catch (_e) {
              _revalidating.delete(cacheKey)
            }
          } else {
            _revalidating.delete(cacheKey)
          }
        }
        return
      }
      CACHE_STORE.delete(cacheKey)
    }

    const _json = res.json.bind(res)
    res.json = ((body: unknown) => {
      setNoStore(res)
      evictIfNeeded()
      CACHE_STORE.set(cacheKey, { data: body, timestamp: Date.now() })
      return _json(body)
    }) as typeof res.json

    next()
  }
}

function invalidateCache(keyPrefix: string): void {
  for (const k of CACHE_STORE.keys()) {
    if (k.startsWith(keyPrefix)) {
      CACHE_STORE.delete(k)
    }
  }
}

speedCache.wrap = function wrap(key: string, ttlMs: number = 60_000) {
  return <T extends (...args: unknown[]) => unknown>(fn: T) =>
    async (...args: Parameters<T>): Promise<unknown> => {
      const cacheKey = args.length > 0 ? `${key}:${JSON.stringify(args)}` : key
      const now = Date.now()
      const cached = CACHE_STORE.get(cacheKey)
      if (cached && now - cached.timestamp < ttlMs) return cached.data
      const result = fn(...args)
      const data = result && typeof (result as Promise<unknown>).then === 'function' ? await (result as Promise<unknown>) : result
      evictIfNeeded()
      CACHE_STORE.set(cacheKey, { data, timestamp: Date.now() })
      return data
    }
}

speedCache.cache = {
  clear: () => CACHE_STORE.clear(),
  get size() { return CACHE_STORE.size },
  has: (k: string) => CACHE_STORE.has(k),
}

export { speedCache, invalidateCache }
