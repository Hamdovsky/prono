/**
 * Redis Configuration
 * Centralized Redis connection and configuration
 */

const Redis = require('ioredis');
const logger = require('../core/logger');

class RedisConfig {
    constructor() {
        this.client = null;
        this.isConnected = false;
    }

    /**
     * Initialize Redis connection
     */
    async connect() {
        try {
            this.client = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: process.env.REDIS_PORT || 6379,
                password: process.env.REDIS_PASSWORD || undefined,
                retryStrategy: (times) => {
                    // Stop retrying after 2 attempts if Redis is not available
                    if (times > 2) {
                        return null; // Stop retrying
                    }
                    return Math.min(times * 50, 2000);
                },
                maxRetriesPerRequest: 2,
                enableReadyCheck: true,
                lazyConnect: true, // Don't connect immediately
                enableOfflineQueue: false // Don't queue commands when offline
            });

            this.client.on('connect', () => {
                logger.info('✅ Redis connected successfully');
                this.isConnected = true;
            });

            this.client.on('error', (err) => {
                // Only log first error, not spam
                if (this.isConnected) {
                    logger.error('❌ Redis connection error:', err.message || 'Connection failed');
                }
                this.isConnected = false;
            });

            this.client.on('close', () => {
                if (this.isConnected) {
                    logger.warn('⚠️ Redis connection closed');
                }
                this.isConnected = false;
            });

            // Try to connect
            await this.client.connect();
            await this.client.ping();
            return this.client;
        } catch (error) {
            logger.warn('⚠️ Redis not available - using in-memory cache fallback');
            this.client = null;
            return null;
        }
    }

    /**
     * Get Redis client
     */
    getClient() {
        return this.client;
    }

    /**
     * Check if Redis is connected
     */
    isReady() {
        return this.isConnected && this.client !== null;
    }

    /**
     * Close Redis connection
     */
    async disconnect() {
        if (this.client) {
            await this.client.quit();
            this.isConnected = false;
            logger.info('Redis disconnected');
        }
    }
}

// Singleton instance
const redisConfig = new RedisConfig();

module.exports = redisConfig;
