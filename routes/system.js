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

module.exports = router;
