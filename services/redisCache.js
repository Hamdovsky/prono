/**
 * Redis Cache Service
 * Handles caching of matches, team history, and scraper metadata
 */

const redisConfig = require('../config/redis.config');
const { RedisMemoryServer } = require('redis-memory-server');
const logger = require('../core/logger');
const Redis = require('ioredis');

class RedisCache {
    constructor() {
        this.redis = null;
        this.fallbackCache = new Map(); // In-memory fallback if Redis unavailable
        this.suppressRedisErrors = false;
    }

    async init() {
        try {
            this.redis = await redisConfig.connect();
        } catch (e) {
            this.redis = null;
        }

        if (!this.redis) {
            logger.info('🧠 [REDIS] Local instance not found. Starting In-Memory Redis Server...');
            try {
                this.memoryServer = new RedisMemoryServer();
                const host = await this.memoryServer.getHost();
                const port = await this.memoryServer.getPort();
                
                this.redis = new Redis({
                    host: host,
                    port: port,
                    retryStrategy: (times) => Math.min(times * 100, 2000),
                    maxRetriesPerRequest: 5
                });
                
                await this.redis.ping();
                logger.info(`✅ [REDIS] Momentary Memory active at ${host}:${port}`);
            } catch (err) {
                logger.warn('⚠️ Redis Memory Server failed to start, using Map fallback:', err.message);
                this.redis = null;
            }
        }
    }

    async set(key, value, ttl = 86400) {
        if (this.redis && redisConfig.isReady()) {
            try {
                const val = typeof value === 'object' ? JSON.stringify(value) : value.toString();
                await this.redis.set(key, val, 'EX', ttl);
                return true;
            } catch (error) {
                if (!this.suppressRedisErrors) {
                    logger.error(`Redis set error (${key}):`, error.message);
                    this.suppressRedisErrors = true;
                    setTimeout(() => { this.suppressRedisErrors = false; }, 60000); // Re-enable after 1 min
                }
            }
        }
        this.fallbackCache.set(key, {
            value: typeof value === 'object' ? JSON.stringify(value) : value.toString(),
            expires: Date.now() + (ttl * 1000)
        });
        return true;
    }

    async get(key) {
        if (this.redis && redisConfig.isReady()) {
            try {
                const data = await this.redis.get(key);
                if (!data) return null;
                try {
                    return JSON.parse(data);
                } catch (e) {
                    return data;
                }
            } catch (error) {
                if (!this.suppressRedisErrors) {
                    logger.error(`Redis get error (${key}):`, error.message);
                    this.suppressRedisErrors = true;
                    setTimeout(() => { this.suppressRedisErrors = false; }, 60000); // Re-enable after 1 min
                }
            }
        }
        const cached = this.fallbackCache.get(key);
        if (cached && cached.expires > Date.now()) {
            try {
                return JSON.parse(cached.value);
            } catch (e) {
                return cached.value;
            }
        }
        return null;
    }

    /**
     * Store live matches
     */
    async setLiveMatches(matches, ttl = 300) {
        const key = 'matches:live';
        const value = JSON.stringify(matches);

        if (this.redis && redisConfig.isReady()) {
            try {
                await this.redis.setex(key, ttl, value);
                return true;
            } catch (error) {
                logger.error('Redis setLiveMatches error:', error.message);
            }
        }

        // Fallback to in-memory
        this.fallbackCache.set(key, { value, expires: Date.now() + (ttl * 1000) });
        return true;
    }

    /**
     * Get live matches
     */
    async getLiveMatches() {
        const key = 'matches:live';

        if (this.redis && redisConfig.isReady()) {
            try {
                const data = await this.redis.get(key);
                return data ? JSON.parse(data) : null;
            } catch (error) {
                logger.error('Redis getLiveMatches error:', error.message);
            }
        }

        // Fallback to in-memory
        const cached = this.fallbackCache.get(key);
        if (cached && cached.expires > Date.now()) {
            return JSON.parse(cached.value);
        }
        return null;
    }

    /**
     * Store upcoming matches
     */
    async setUpcomingMatches(matches, ttl = 3600) {
        const key = 'matches:upcoming';
        const value = JSON.stringify(matches);

        if (this.redis && redisConfig.isReady()) {
            try {
                await this.redis.setex(key, ttl, value);
                return true;
            } catch (error) {
                logger.error('Redis setUpcomingMatches error:', error.message);
            }
        }

        this.fallbackCache.set(key, { value, expires: Date.now() + (ttl * 1000) });
        return true;
    }

    /**
     * Get upcoming matches
     */
    async getUpcomingMatches() {
        const key = 'matches:upcoming';

        if (this.redis && redisConfig.isReady()) {
            try {
                const data = await this.redis.get(key);
                return data ? JSON.parse(data) : null;
            } catch (error) {
                logger.error('Redis getUpcomingMatches error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        if (cached && cached.expires > Date.now()) {
            return JSON.parse(cached.value);
        }
        return null;
    }

    /**
     * Store team history
     */
    async setTeamHistory(teamName, history, ttl = 86400) {
        const key = `team:${teamName}:history`;
        const value = JSON.stringify(history);

        if (this.redis && redisConfig.isReady()) {
            try {
                await this.redis.setex(key, ttl, value);
                return true;
            } catch (error) {
                logger.error('Redis setTeamHistory error:', error.message);
            }
        }

        this.fallbackCache.set(key, { value, expires: Date.now() + (ttl * 1000) });
        return true;
    }

    /**
     * Get team history
     */
    async getTeamHistory(teamName) {
        const key = `team:${teamName}:history`;

        if (this.redis && redisConfig.isReady()) {
            try {
                const data = await this.redis.get(key);
                return data ? JSON.parse(data) : null;
            } catch (error) {
                logger.error('Redis getTeamHistory error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        if (cached && cached.expires > Date.now()) {
            return JSON.parse(cached.value);
        }
        return null;
    }

    /**
     * Record scraper run timestamp
     */
    async setLastRun(timestamp = Date.now()) {
        const key = 'scraper:last_run';

        if (this.redis && redisConfig.isReady()) {
            try {
                await this.redis.set(key, timestamp.toString());
                return true;
            } catch (error) {
                logger.error('Redis setLastRun error:', error.message);
            }
        }

        this.fallbackCache.set(key, { value: timestamp.toString(), expires: Infinity });
        return true;
    }

    /**
     * Get last scraper run timestamp
     */
    async getLastRun() {
        const key = 'scraper:last_run';

        if (this.redis && redisConfig.isReady()) {
            try {
                const data = await this.redis.get(key);
                return data ? parseInt(data) : null;
            } catch (error) {
                logger.error('Redis getLastRun error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        return cached ? parseInt(cached.value) : null;
    }

    /**
     * Increment failure counter
     */
    async incrementFailures() {
        const key = 'scraper:failures';

        if (this.redis && redisConfig.isReady()) {
            try {
                const count = await this.redis.incr(key);
                await this.redis.expire(key, 3600); // Reset after 1 hour
                return count;
            } catch (error) {
                logger.error('Redis incrementFailures error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        const current = cached ? parseInt(cached.value) : 0;
        const newCount = current + 1;
        this.fallbackCache.set(key, { value: newCount.toString(), expires: Date.now() + 3600000 });
        return newCount;
    }

    /**
     * Reset failure counter
     */
    async resetFailures() {
        const key = 'scraper:failures';

        if (this.redis && redisConfig.isReady()) {
            try {
                await this.redis.del(key);
                return true;
            } catch (error) {
                logger.error('Redis resetFailures error:', error.message);
            }
        }

        this.fallbackCache.delete(key);
        return true;
    }

    /**
     * Get failure count
     */
    async getFailureCount() {
        const key = 'scraper:failures';

        if (this.redis && redisConfig.isReady()) {
            try {
                const count = await this.redis.get(key);
                return count ? parseInt(count) : 0;
            } catch (error) {
                logger.error('Redis getFailureCount error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        return cached ? parseInt(cached.value) : 0;
    }

    /**
     * Clear expired entries from fallback cache
     */
    clearExpired() {
        const now = Date.now();
        for (const [key, data] of this.fallbackCache.entries()) {
            if (data.expires !== Infinity && data.expires < now) {
                this.fallbackCache.delete(key);
            }
        }
    }

    /**
     * Get cache statistics
     */
    async getStats() {
        const stats = {
            redisConnected: redisConfig.isReady(),
            fallbackSize: this.fallbackCache.size,
            liveMatches: await this.getLiveMatches(),
            upcomingMatches: await this.getUpcomingMatches(),
            lastRun: await this.getLastRun(),
            failures: await this.getFailureCount()
        };

        return stats;
    }

    /**
     * Store match history snapshots for rolling tactical stats
     */
    async setMatchHistory(matchId, history, ttl = 7200) {
        const key = `match:${matchId}:history`;
        const value = JSON.stringify(history);

        if (this.redis && redisConfig.isReady()) {
            try {
                await this.redis.setex(key, ttl, value);
                return true;
            } catch (error) {
                logger.error('Redis setMatchHistory error:', error.message);
            }
        }

        this.fallbackCache.set(key, { value, expires: Date.now() + (ttl * 1000) });
        return true;
    }

    /**
     * Get match history snapshots
     */
    async getMatchHistory(matchId) {
        const key = `match:${matchId}:history`;

        if (this.redis && redisConfig.isReady()) {
            try {
                const data = await this.redis.get(key);
                return data ? JSON.parse(data) : null;
            } catch (error) {
                logger.error('Redis getMatchHistory error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        if (cached && cached.expires > Date.now()) {
            return JSON.parse(cached.value);
        }
        return null;
    }

    /**
     * Increment the daily count of scraped matches
     */
    async incrementDailyMatchCount(count = 1) {
        const key = `stats:daily_match_count:${new Date().toISOString().split('T')[0]}`;

        if (this.redis && redisConfig.isReady()) {
            try {
                const newCount = await this.redis.incrby(key, count);
                await this.redis.expire(key, 86400); // 24 hours
                return newCount;
            } catch (error) {
                logger.error('Redis incrementDailyMatchCount error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        const current = cached ? parseInt(cached.value) : 0;
        const newCount = current + count;
        this.fallbackCache.set(key, { value: newCount.toString(), expires: Date.now() + 86400000 });
        return newCount;
    }

    /**
     * Get the current daily count of scraped matches
     */
    async getDailyMatchCount() {
        const key = `stats:daily_match_count:${new Date().toISOString().split('T')[0]}`;

        if (this.redis && redisConfig.isReady()) {
            try {
                const count = await this.redis.get(key);
                return count ? parseInt(count) : 0;
            } catch (error) {
                logger.error('Redis getDailyMatchCount error:', error.message);
            }
        }

        const cached = this.fallbackCache.get(key);
        return cached ? parseInt(cached.value) : 0;
    }

    /**
     * Purge all cache (In-memory & Redis)
     */
    async purgeAll() {
        try {
            if (this.redis && redisConfig.isReady()) {
                await this.redis.flushall().catch(err => {
                    logger.error('❌ Error purging Redis:', err.message);
                });
                logger.info('🧹 Redis Cache Purged (flushall)');
            }
            this.fallbackCache.clear();
            logger.info('🧹 In-memory Fallback Cache Purged');
            return true;
        } catch (error) {
            logger.error('❌ PurgeAll Fatal Error:', error.message);
            return true; // Return true so initialization doesn't crash
        }
    }

    /**
     * Close connections
     */
    async close() {
        await redisConfig.disconnect();
        this.fallbackCache.clear();
    }
}

// Singleton instance
const redisCache = new RedisCache();

module.exports = redisCache;
