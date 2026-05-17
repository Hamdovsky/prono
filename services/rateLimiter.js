/**
 * Rate Limiter Service
 * Uses Bottleneck for intelligent rate limiting and request queuing
 */

const Bottleneck = require('bottleneck');
const logger = require('../core/logger');

class RateLimiter {
    constructor() {
        // Configure bottleneck for Flashscore scraping
        this.limiter = new Bottleneck({
            maxConcurrent: 2, // Max 2 concurrent requests
            minTime: 6000, // Minimum 6 seconds between requests
            reservoir: 20, // Start with 20 requests
            reservoirRefreshAmount: 10, // Refill 10 requests
            reservoirRefreshInterval: 60 * 1000, // Every 60 seconds

            // Retry configuration
            retryLimit: 3,
            retryDelay: (retryCount) => {
                return Math.min(1000 * Math.pow(2, retryCount), 30000);
            }
        });

        // Event listeners
        this.limiter.on('failed', async (error, jobInfo) => {
            const id = jobInfo.options.id;
            logger.warn(`⚠️ Rate limiter job ${id} failed: ${error.message}`);

            // Retry on timeout or network errors
            if (error.message.includes('Timeout') || error.message.includes('ECONNREFUSED')) {
                logger.info(`🔄 Retrying job ${id} (attempt ${jobInfo.retryCount + 1})`);
                return 5000; // Retry after 5 seconds
            }

            return null; // Don't retry
        });

        this.limiter.on('retry', (error, jobInfo) => {
            logger.info(`🔄 Retrying job ${jobInfo.options.id} after error: ${error.message}`);
        });

        this.limiter.on('done', (info) => {
            logger.info(`✅ Rate limiter job completed: ${info.options.id}`);
        });

        this.limiter.on('depleted', () => {
            logger.warn('⚠️ Rate limiter reservoir depleted, waiting for refill...');
        });
    }

    /**
     * Schedule a scraping task
     */
    async schedule(fn, options = {}) {
        const jobId = options.id || `job_${Date.now()}`;

        try {
            return await this.limiter.schedule({ id: jobId }, fn);
        } catch (error) {
            // Ignore "Job with same id" error specifically if it slips through (race condition)
            if (error.message && error.message.includes('same id')) {
                // Use info instead of debug as debug might not be implemented
                logger.info(`⚠️ Job ${jobId} already running, skipping duplicate scheduling`);
                return null;
            }

            const errorMsg = error?.message || error?.toString() || 'Unknown error';
            logger.error(`Rate limiter error for ${jobId}:`, errorMsg);
            throw error;
        }
    }

    /**
     * Wrap a function with rate limiting
     */
    wrap(fn) {
        return this.limiter.wrap(fn);
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            running: this.limiter.counts().RUNNING,
            queued: this.limiter.counts().QUEUED,
            reservoir: this.limiter.reservoir
        };
    }

    /**
     * Clear queue
     */
    async clearQueue() {
        await this.limiter.stop({ dropWaitingJobs: true });
        logger.info('🗑️ Rate limiter queue cleared');
    }

    /**
     * Pause rate limiter
     */
    async pause() {
        await this.limiter.stop();
        logger.info('⏸️ Rate limiter paused');
    }

    /**
     * Resume rate limiter
     */
    resume() {
        this.limiter.start();
        logger.info('▶️ Rate limiter resumed');
    }
}

// Singleton instance
const rateLimiter = new RateLimiter();

module.exports = rateLimiter;
