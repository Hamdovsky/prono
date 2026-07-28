// NOTE: Il y a DEUX implémentations Redis (celle-ci + config/redis.config.js).
// Celle-ci est utilisée par le cache de l'API ; l'autre par la config centralisée.
// À terme, fusionner dans une seule. Pour l'instant les deux coexistent.
const CircuitBreaker = require('./circuitBreaker')
const redisBreaker = require('./circuitBreaker').breakers.redis
const Redis = require('ioredis')
const { performance } = require('perf_hooks')
const logger = require('./logger')

// Redis client instance
let redis = null
try {
  const redisUrl = process.env.REDIS_URL
  const opts = redisUrl
    ? {
        retryStrategy: (t) => Math.min(t * 200, 3000),
        maxRetriesPerRequest: 5,
        enableReadyCheck: true,
        lazyConnect: true,
        enableOfflineQueue: true,
      }
    : {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        retryStrategy: (t) => Math.min(t * 200, 3000),
        maxRetriesPerRequest: 5,
        enableReadyCheck: true,
        lazyConnect: true,
        enableOfflineQueue: true,
      }
  redis = redisUrl ? new Redis(redisUrl, opts) : new Redis(opts)
  logger.info('[REDIS] Client created')

  redis.on('error', () => {})
} catch (e) {
  logger.warn(`[REDIS] Init failed: ${e.message}`)
  redis = null
}

// Metrics tracking
const metrics = {
  hits: 0,
  misses: 0,
  totalGetTimeMs: 0,
}

// In-memory fallback cache
const MEMORY_FALLBACK = new Map()

async function getCache(key) {
  const start = performance.now()
  if (!redis) {
    const local = MEMORY_FALLBACK.get(key)
    if (local && local.expiry > Date.now()) {
      metrics.hits++
      return local.value
    }
    metrics.misses++
    return null
  }
  try {
    const data = await redisBreaker.call(async () => {
      return await redis.get(key)
    })
    const latency = performance.now() - start
    metrics.totalGetTimeMs += latency

    if (data) {
      metrics.hits++
      return JSON.parse(data)
    }
  } catch (e) {
    const local = MEMORY_FALLBACK.get(key)
    if (local && local.expiry > Date.now()) {
      metrics.hits++
      return local.value
    }
  }
  metrics.misses++
  return null
}

async function setCache(key, value, ttlInSeconds = 1800) {
  if (!redis) {
    MEMORY_FALLBACK.set(key, {
      value,
      expiry: Date.now() + ttlInSeconds * 1000,
    })
    if (MEMORY_FALLBACK.size > 300) {
      const now = Date.now()
      for (const [k, v] of MEMORY_FALLBACK.entries()) {
        if (v.expiry < now) MEMORY_FALLBACK.delete(k)
      }
      if (MEMORY_FALLBACK.size > 300) {
        const sorted = [...MEMORY_FALLBACK.entries()].sort((a, b) => a[1].expiry - b[1].expiry)
        for (const [k] of sorted.slice(0, sorted.length - 200)) MEMORY_FALLBACK.delete(k)
      }
    }
    return
  }
  await redisBreaker
    .call(async () => {
      const strValue = JSON.stringify(value)
      await redis.set(key, strValue, 'EX', ttlInSeconds)
    })
    .catch(() => {
      MEMORY_FALLBACK.set(key, {
        value,
        expiry: Date.now() + ttlInSeconds * 1000,
      })
      if (MEMORY_FALLBACK.size > 300) {
        const now = Date.now()
        for (const [k, v] of MEMORY_FALLBACK.entries()) {
          if (v.expiry < now) MEMORY_FALLBACK.delete(k)
        }
        if (MEMORY_FALLBACK.size > 300) {
          const sorted = [...MEMORY_FALLBACK.entries()].sort((a, b) => a[1].expiry - b[1].expiry)
          for (const [k] of sorted.slice(0, sorted.length - 200)) MEMORY_FALLBACK.delete(k)
        }
      }
    })
}

function printCacheMetrics() {
  const total = metrics.hits + metrics.misses
  const hitRate = total > 0 ? ((metrics.hits / total) * 100).toFixed(2) : 0
  const avgLatency = metrics.hits > 0 ? (metrics.totalGetTimeMs / metrics.hits).toFixed(2) : 0
  console.log('--- [CACHE METRICS] ---')
  console.log(`  Hits:       ${metrics.hits}`)
  console.log(`  Misses:     ${metrics.misses}`)
  console.log(`  Hit Rate:   ${hitRate}%`)
  console.log(`  Avg Latency: ${avgLatency}ms`)
  console.log(`  Mem Cache:  ${MEMORY_FALLBACK.size} entries`)
  console.log('--- [/CACHE METRICS] ---')
}

module.exports = {
  redis,
  getCache,
  setCache,
  printCacheMetrics,
  metrics,
  MEMORY_FALLBACK,
}
