const express = require('express');
const router = express.Router();
const database = require('../core/database');
const shieldEngine = require('../core/shieldEngine');
const mlPredictionService = require('../services/mlPredictionService');
const configEngine = require('../core/configEngine');
const securityEngine = require('../core/securityEngine');
const { speedCache } = require('../core/speedCache');
const { readScraperProgress } = require('../core/utils');
const logger = require('../core/logger');

/**
 * GET /api/ping - Diagnostic ping
 */
router.get('/ping', (req, res) => res.send('API_PONG'));

/**
 * GET /api/system/intel - High-precision telemetry for Command Center
 */
router.get('/system/intel', async (req, res) => {
    try {
        const stats = shieldEngine.getStatus();
        const mlStatus = mlPredictionService.getStatus();
        const strategyParams = configEngine.getStrategyParams();
        
        // Use database.get which is the proper async-wrapped method if available, 
        // or just use prepare().get() synchronously without await if it's sync.
        const lastSyncRow = database.prepare("SELECT last_updated as lastSync FROM matches WHERE source = 'africanobet' ORDER BY last_updated DESC LIMIT 1").get();
        const totalMatchesRow = database.prepare("SELECT COUNT(*) as count FROM matches WHERE source = 'africanobet'").get();

        res.json({
            telemetry: {
                latency: stats.avgLatency || 0,
                shieldActive: stats.shieldLevel > 0,
                activeProxy: stats.currentProxy || 'DIRECT',
                level: stats.shieldLevel || 0
            },
            ai_workers: {
                queue: mlStatus.queueSize || 0,
                busy: mlStatus.isPredicting || false,
                cacheHits: mlStatus.cacheCount || 0
            },
            strategy: {
                active: configEngine.get('strategy') || 'default',
                label: strategyParams.label || 'Standard',
                oddsCap: strategyParams.oddsCap || 0
            },
            database: {
                totalMatches: totalMatchesRow?.count || 0,
                lastSync: lastSyncRow?.lastSync || 0
            },
            uptime: process.uptime(),
            memory: process.memoryUsage().heapUsed
        });
    } catch (error) {
        logger.error('[API] /system/intel failure', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

/**
 * GET /api/system/status
 */
router.get('/status', async (req, res) => {
    try {
        const lastSyncRow = database.prepare("SELECT last_updated as lastSync FROM matches WHERE source = 'africanobet' ORDER BY last_updated DESC LIMIT 1").get();
        const totalMatchesRow = database.prepare("SELECT COUNT(*) as count FROM matches WHERE source = 'africanobet'").get();
        const liveMatchesRow = database.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'live' AND source = 'africanobet'").get();
        
        res.json({
            status: 'ONLINE',
            lastSync: lastSyncRow?.lastSync || 0,
            totalMatches: totalMatchesRow?.count || 0,
            liveMatchesCount: liveMatchesRow?.count || 0,
            uptime: process.uptime(),
            memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
        });
    } catch (error) {
        logger.error('[API] /status failure', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

router.get('/health', async (req, res) => {
    try {
        res.json({
            status: 'ONLINE',
            diagnostic: 'Simplified Response Active',
            uptime: process.uptime(),
            memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
        });
    } catch (fatalErr) {
        logger.error('CRITICAL ERROR in /api/health route', fatalErr);
        res.status(500).json({ status: 'error', message: fatalErr.message });
    }
});

/**
 * POST /api/predict - High-speed prediction gateway
 * 🛡️ Localhost (scraper process) is always trusted — no token required for 127.0.0.1 / ::1
 */
const localOnlyOrAuth = (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || '';
    const isLocalhost = ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1';
    if (isLocalhost) return next(); // Internal scraper — trusted
    return securityEngine.authenticate(req, res, next); // External — require token
};

router.post('/predict', localOnlyOrAuth, async (req, res) => {
    try {
        const result = await mlPredictionService.getMLPrediction(req.body);
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`[AI Gateway] Prediction Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/sentiment - High-speed sentiment gateway
 * 🛡️ Localhost is always trusted (same as /predict)
 */
router.post('/sentiment', localOnlyOrAuth, async (req, res) => {
    try {
        const pythonService = require('../core/pythonService');
        const result = await pythonService.predict({ ...req.body, task: 'SENTIMENT' });
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error(`[AI Gateway] Sentiment Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/system/clear-cache', localOnlyOrAuth, async (req, res) => {
    try {
        const { invalidateCache } = require('../core/speedCache');
        invalidateCache('upcoming');
        res.json({ success: true, message: 'Cache invalidated' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/db-stats — Diagnose DB state from Render logs
 */
router.get('/db-stats', async (req, res) => {
    try {
        const db = database.db;
        const total = db.prepare('SELECT COUNT(*) as cnt FROM matches').get();
        const byStatus = db.prepare('SELECT status, COUNT(*) as cnt FROM matches GROUP BY status').all();
        const today = new Date().toISOString().split('T')[0];
        const todayStart = Math.floor(new Date(today + 'T00:00:00Z').getTime() / 1000);
        const todayEnd = todayStart + 86400;
        const todayCount = db.prepare('SELECT COUNT(*) as cnt FROM matches WHERE startTimestamp >= ? AND startTimestamp < ?').get(todayStart, todayEnd);
        const sample = db.prepare('SELECT id, homeTeam, awayTeam, league, status, startTimestamp FROM matches ORDER BY startTimestamp DESC LIMIT 5').all();
        res.json({
            total: total?.cnt || 0,
            today: todayCount?.cnt || 0,
            todayRange: { from: new Date(todayStart * 1000).toISOString(), to: new Date(todayEnd * 1000).toISOString() },
            byStatus,
            sample,
            serverTime: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/seed — Manually trigger cloud seed (for Render deployments)
 */
router.post('/seed', async (req, res) => {
    try {
        const { runCloudSeed } = require('../core/cloudSeed');
        res.json({ success: true, message: 'Seed started in background. Check /api/db-stats in ~2 min.' });
        // Run after response is sent
        setImmediate(() => {
            runCloudSeed().catch(e => console.error('[SEED] Error:', e.message));
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/test-seed — Diagnostic test to make a direct Sofascore API call
 */
router.get('/test-seed', async (req, res) => {
    try {
        const axios = require('axios');
        const today = new Date().toISOString().split('T')[0];
        const url = `https://www.sofascore.com/api/v1/sport/football/scheduled-events/${today}`;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.sofascore.com',
            'Referer': 'https://www.sofascore.com/',
            'x-requested-with': 'XMLHttpRequest',
        };
        const response = await axios.get(url, { headers, timeout: 10000 });
        res.json({
            success: true,
            status: response.status,
            eventsCount: response.data?.events?.length || 0,
            sampleEvent: response.data?.events?.[0] ? {
                id: response.data.events[0].id,
                home: response.data.events[0].homeTeam?.name,
                away: response.data.events[0].awayTeam?.name
            } : null
        });
    } catch (e) {
        res.json({
            success: false,
            message: e.message,
            responseStatus: e.response?.status,
            responseData: e.response?.data ? String(e.response.data).substring(0, 500) : null
        });
    }
});

/**
 * POST /api/sync-matches
 * Secure cloud synchronization webhook to receive matches pushed from local environments.
 */
router.post('/sync-matches', express.json({ limit: '50mb' }), async (req, res) => {
    try {
        const { matches } = req.body;
        if (!Array.isArray(matches)) {
            return res.status(400).json({ error: "Invalid payload: 'matches' array is required." });
        }

        const db = database.db;
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO matches (
                id, homeTeam, awayTeam, league, scoreHome, scoreAway, minute, status,
                prediction, confidence, fullData, timestamp, startTimestamp,
                possession_home, possession_away, dangerous_attacks_home, dangerous_attacks_away,
                shots_on_target_home, shots_on_target_away, corners_home, corners_away,
                source, last_updated, home_win_probability, draw_probability, away_win_probability,
                insufficient_data, odds_home, odds_draw, odds_away
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?
            )
        `);

        // Perform transaction for maximum speed
        const transaction = db.transaction((list) => {
            let count = 0;
            for (const m of list) {
                if (!m.id) continue;
                insertStmt.run(
                    String(m.id),
                    m.homeTeam || m.home || 'Home',
                    m.awayTeam || m.away || 'Away',
                    m.league || 'Unknown',
                    parseInt(m.scoreHome || m.goalsHome || 0),
                    parseInt(m.scoreAway || m.goalsAway || 0),
                    String(m.minute || ''),
                    String(m.status || 'scheduled'),
                    m.prediction || null,
                    parseFloat(m.confidence || 50),
                    m.fullData ? (typeof m.fullData === 'string' ? m.fullData : JSON.stringify(m.fullData)) : JSON.stringify(m),
                    m.timestamp || new Date().toISOString(),
                    parseInt(m.startTimestamp || Math.floor(Date.now() / 1000)),
                    parseInt(m.possession_home || 0),
                    parseInt(m.possession_away || 0),
                    parseInt(m.dangerous_attacks_home || 0),
                    parseInt(m.dangerous_attacks_away || 0),
                    parseInt(m.shots_on_target_home || 0),
                    parseInt(m.shots_on_target_away || 0),
                    parseInt(m.corners_home || 0),
                    parseInt(m.corners_away || 0),
                    m.source || 'sofascore',
                    parseInt(m.last_updated || Date.now()),
                    parseFloat(m.home_win_probability || 0),
                    parseFloat(m.draw_probability || 0),
                    parseFloat(m.away_win_probability || 0),
                    parseInt(m.insufficient_data || 0),
                    parseFloat(m.odds_home || 0),
                    parseFloat(m.odds_draw || 0),
                    parseFloat(m.odds_away || 0)
                );
                count++;
            }
            return count;
        });

        const inserted = transaction(matches);
        logger.info(`⚡ [SYNC API] Successfully synchronized ${inserted} matches from local client.`);
        res.json({ success: true, count: inserted });
    } catch (e) {
        logger.error(`❌ [SYNC API] Transaction failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
