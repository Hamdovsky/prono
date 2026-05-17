const express = require('express');
const router = express.Router();
const logger = require('../core/logger');
const database = require('../core/database');
const adaptiveLearning = require('../services/adaptiveLearningEngine');

/**
 * POST /api/learn
 * Feed a completed match to the self-learning engine.
 */
router.post('/', async (req, res) => {
    try {
        const input = req.body;
        if (!input.matchId || !input.league || !input.actualResult) {
            return res.status(400).json({ error: 'matchId, league, and actualResult are required.' });
        }
        const report = await adaptiveLearning.learn(input);
        res.json({ success: true, report });
    } catch (err) {
        logger.error(`[LEARN API] Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/learn/batch
 * Feed an array of completed matches for bulk learning.
 */
router.post('/batch', async (req, res) => {
    try {
        const { matches = [] } = req.body;
        if (!Array.isArray(matches) || matches.length === 0) {
            return res.status(400).json({ error: 'matches array is required and must not be empty.' });
        }
        const results = await adaptiveLearning.processBatch(matches);
        res.json({ success: true, processed: results.length, results });
    } catch (err) {
        logger.error(`[LEARN BATCH API] Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/learn/report/:league
 */
router.get('/report/:league', async (req, res) => {
    try {
        const league = decodeURIComponent(req.params.league);
        const dateFilter = req.query.date || null;
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const report = await adaptiveLearning.getLeagueReport(league, dateFilter);
        res.json({ success: true, report });
    } catch (err) {
        logger.error(`[LEARN REPORT API] Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/learn/leagues
 */
router.get('/leagues', async (req, res) => {
    try {
        const rows = database.db.prepare('SELECT DISTINCT TRIM(league) as league FROM learning_memory WHERE league IS NOT NULL AND league != "" ORDER BY league ASC').all();
        const leagues = rows.map(r => r.league);
        res.json({ success: true, leagues: ['ALL', ...leagues] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/learn/weights/:league
 */
router.get('/weights/:league', async (req, res) => {
    try {
        const league = decodeURIComponent(req.params.league);
        const [weights, confAdj] = await Promise.all([
            adaptiveLearning.getWeights(league),
            adaptiveLearning.getConfidenceAdjustment(league),
        ]);
        res.json({ success: true, league, weights, confidenceAdjustment: confAdj });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/learn/auto-process
 */
router.get('/auto-process', async (req, res) => {
    try {
        const db = database.db;
        let rows = [];
        try {
            rows = db.prepare(`
                SELECT m.id, m.homeTeam, m.awayTeam, m.league,
                       m.scoreHome, m.scoreAway, m.prediction, m.confidence,
                       m.fullData
                FROM matches m
                WHERE m.status IN ('FT','Finished','finished','FINISHED')
                  AND m.id NOT IN (SELECT match_id FROM learning_memory)
                LIMIT 50
            `).all();
        } catch (_) {}

        if (rows.length === 0) {
            return res.json({ success: true, message: 'No new matches to process.', processed: 0 });
        }

        const inputs = rows.map(r => {
            let fullData = {};
            try { fullData = JSON.parse(r.fullData || '{}'); } catch (_) {}
            const scoreH = parseInt(r.scoreHome) || 0;
            const scoreA = parseInt(r.scoreAway) || 0;
            const actualResult = scoreH > scoreA ? 'H' : scoreH < scoreA ? 'A' : 'D';
            return {
                matchId:      r.id,
                league:       r.league || 'Unknown',
                homeTeam:     r.homeTeam,
                awayTeam:     r.awayTeam,
                prediction:   r.prediction || fullData.verdict || '',
                confidence:   r.confidence || fullData.xgboost_confidence * 100 || 50,
                oddsData:     { home: r.odds_home, draw: r.odds_draw, away: r.odds_away },
                featuresList: fullData.features_used || [],
                actualResult,
                matchStats:   {
                    xg_home:              fullData.xg_home || 0,
                    xg_away:              fullData.xg_away || 0,
                    possession_home:      r.possession_home || 0,
                    shots_on_target_home: r.shots_on_target_home || 0,
                    shots_on_target_away: r.shots_on_target_away || 0,
                    red_cards_home:       fullData.red_cards_home || 0,
                    red_cards_away:       fullData.red_cards_away || 0,
                },
                scoreHome: scoreH,
                scoreAway: scoreA,
            };
        });

        setImmediate(async () => {
            try {
                await adaptiveLearning.processBatch(inputs);
                logger.info(`✅ [LEARN AUTO] Processed ${inputs.length} finished matches.`);
            } catch (e) {
                logger.error(`[LEARN AUTO] Batch error: ${e.message}`);
            }
        });

        res.json({ success: true, message: `Processing ${inputs.length} matches in background.`, queued: inputs.length });
    } catch (err) {
        logger.error(`[LEARN AUTO API] Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
