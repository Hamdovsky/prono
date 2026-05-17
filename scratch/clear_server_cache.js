const redis = require('../core/redisClient');

async function clearCache() {
    try {
        console.log('🧹 Clearing server cache...');
        await redis.setCache('express_cache:/api/matches/upcoming', null);
        console.log('✅ Cache cleared.');
    } catch (e) {
        console.error('Error clearing cache:', e);
    } finally {
        process.exit(0);
    }
}

clearCache();
