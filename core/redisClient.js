const CircuitBreaker = require('./circuitBreaker');
const redisBreaker = require('./circuitBreaker').breakers.redis;
const Redis = require('ioredis');
const { performance } = require('perf_hooks');
console.log('Redis type:', typeof Redis, 'keys:', Object.keys(Redis || {}));


// Redis client instance
let redis = null;
try {
  console.log('Creating new Redis with opts...');
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times) => {
      // Keep reconnecting, cap delay at 3 seconds
      return Math.min(times * 200, 3000);
    },
    maxRetriesPerRequest: 5,
    enableReadyCheck: true,
    lazyConnect: true,
    enableOfflineQueue: true
  });
  console.log('Redis instance created:', !!redis, redis && typeof redis);

  redis.on('error', () => {});
} catch (e) {
  console.error('Redis init error:', e.message);
  redis = null;
}

// Metrics tracking
const metrics = {
  hits: 0,
  misses: 0,
  totalGetTimeMs: 0
};

// In-memory fallback cache
const MEMORY_FALLBACK = new Map();

async function getCache(key) {
  const start = performance.now();
  try {
    const data = await redisBreaker.call(async () => {
      return await redis.get(key);
    });
    const latency = performance.now() - start;
    metrics.totalGetTimeMs += latency;
    
    if (data) {
      metrics.hits++;
      return JSON.parse(data);
    }
  } catch (e) {
    const local = MEMORY_FALLBACK.get(key);
    if (local && local.expiry > Date.now()) {
      metrics.hits++;
      return local.value;
    }
  }
  metrics.misses++;
  return null;
}

async function setCache(key, value, ttlInSeconds = 3600) {
  await redisBreaker.call(async () => {
    const strValue = JSON.stringify(value);
    await redis.set(key, strValue, 'EX', ttlInSeconds);
  }).catch(() => {
    MEMORY_FALLBACK.set(key, {
      value,
      expiry: Date.now() + (ttlInSeconds * 1000)
    });
    if (MEMORY_FALLBACK.size > 1000) {
      const now = Date.now();
      for (const [k, v] of MEMORY_FALLBACK.entries()) {
        if (v.expiry < now) MEMORY_FALLBACK.delete(k);
      }
    }
  });
}

function printCacheMetrics() {
  const total = metrics.hits + metrics.misses;
  const hitRate = total > 0 ? ((metrics.hits / total) * 100).toFixed(2) : 0;
  const avgLatency = metrics.hits > 0 ? (metrics.totalGetTimeMs / metrics.hits).toFixed(2) : 0;
  console.log('--- [CACHE METRICS] ---');
  console.log(`  Hits:       ${metrics.hits}`);
  console.log(`  Misses:     ${metrics.misses}`);
  console.log(`  Hit Rate:   ${hitRate}%`);
  console.log(`  Avg Latency: ${avgLatency}ms`);
  console.log(`  Mem Cache:  ${MEMORY_FALLBACK.size} entries`);
  console.log('--- [/CACHE METRICS] ---');
}

module.exports = {
  redis,
  getCache,
  setCache,
  printCacheMetrics,
  metrics,
  MEMORY_FALLBACK
};
