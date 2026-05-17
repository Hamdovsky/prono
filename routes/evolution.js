const express = require('express');
const router = express.Router();
const db = require('../core/database');
const MarketSensorService = require('../services/MarketSensorService');

/**
 * 📊 TITANIUM RESEARCH & QUANT API
 * Provides deep insights into failure patterns and model performance.
 */

router.get('/intelligence', async (req, res) => {
    try {
        const topFailures = await db.prepare(`
            SELECT failure_type, SUM(frequency) as total 
            FROM failure_intelligence 
            GROUP BY failure_type 
            ORDER BY total DESC
        `).all();

        const leaguePatterns = await db.prepare(`
            SELECT league, failure_type, frequency 
            FROM failure_intelligence 
            WHERE team = 'GLOBAL'
            ORDER BY frequency DESC
            LIMIT 20
        `).all();

        res.json({
            success: true,
            topFailures,
            leaguePatterns,
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/performance-metrics', async (req, res) => {
    try {
        const metrics = await db.prepare(`
            SELECT 
                league,
                COUNT(*) as total_matches,
                AVG(clv_value) as avg_clv,
                AVG(confidence) as avg_confidence
            FROM matches
            WHERE status IN ('FT', 'Finished')
            GROUP BY league
            HAVING total_matches > 5
            ORDER BY avg_clv DESC
        `).all();

        res.json({ success: true, metrics });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/sensors', async (req, res) => {
    try {
        const signals = await MarketSensorService.getMarketSignals(req.query.days || 2);
        res.json({ success: true, signals });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
