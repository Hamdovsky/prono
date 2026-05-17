const fs = require('fs');
const path = require('path');
const Workflow = require('./src/Workflow');
const redisCache = require('../services/redisCache');

const leaguesJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../leagues_ids.json'), 'utf8'));
const leagues = leaguesJson.map(l => ({
    country: l.category_name.toLowerCase().replace(/\s+/g, '-'),
    league: l.tournament_name.toLowerCase().replace(/\s+/g, '-')
}));

const titaniumWorkflow = new Workflow(leagues);

async function runCycle() {
    // 🔒 [LOCK] Prevent multiple cycles if started by different triggers
    try {
        const isLocked = await redisCache.get('scraper:lock');
        if (isLocked) {
            console.log('🚫 [SCRAPER] Another instance is already active. Retrying in 1 minute...');
            setTimeout(runCycle, 60000);
            return;
        }
        await redisCache.set('scraper:lock', 'locked', 3600);
    } catch (e) {
        console.warn('⚠️ [SCRAPER] Lock system warning:', e.message);
    }

    try {
        await titaniumWorkflow.start();
    } catch (err) {
        console.error('❌ [MAIN] Cycle error:', err.message);
    } finally {
        await redisCache.redis?.del('scraper:lock').catch(() => {});
    }

    const nextWait = 5 * 60 * 1000; // ✅ 5 minutes cycle
    console.log(`📡 [SLEEP] Next scan in ${nextWait / 1000 / 60}min...`);
    setTimeout(runCycle, nextWait);
}

console.log('--- TITANIUM FUSION: PROFESSIONAL SCRAPER ENGINE v3.0 ---');
// [V51] Delayed start to allow API Workers to initialize properly
console.log('⏳ [WAIT] Warming up Titanium AI Gateway (2s)...');
// Ensure Redis is ready before starting
setTimeout(async () => {
    await redisCache.init().catch(() => {});
    try {
        if (redisCache.redis) {
            await redisCache.redis.del('scraper:lock');
            console.log('🔓 [STARTUP] Scraper lock cleared from previous session.');
        }
    } catch (e) {
        console.warn('⚠️ [STARTUP] Could not clear scraper lock:', e.message);
    }
    runCycle();
}, 2000);
