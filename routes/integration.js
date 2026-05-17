const express = require('express');
const router = express.Router();
const logger = require('../core/logger');
const database = require('../core/database');

/**
 * POST /api/webhook/score-update
 * Real-time integration webhook for score updates.
 */
router.post('/score-update', async (req, res) => {
    try {
        const { matchId, homeScore, awayScore, league, status = 'live', minute } = req.body;
        if (!matchId || homeScore === undefined || awayScore === undefined) {
            return res.status(400).json({ error: 'Missing required payload: matchId, homeScore, awayScore' });
        }

        let existingMatch = await database.getMatchById(matchId);
        if (!existingMatch) {
            existingMatch = {
                id: matchId,
                homeTeam: req.body.homeTeam || 'Unknown',
                awayTeam: req.body.awayTeam || 'Unknown',
                league: league || 'Unknown',
                home_win_probability: 0,
                away_win_probability: 0,
                draw_probability: 0,
                xgboost_confidence: 0,
            };
        }

        existingMatch.score = { home: homeScore, away: awayScore };
        existingMatch.status = status;
        if (minute) existingMatch.minute = String(minute);

        if (req.body.stats) {
            existingMatch.stats = existingMatch.stats || { pressure: {}, totalShots: {}, possession: {}, corners: {} };
            Object.assign(existingMatch.stats, req.body.stats);
        }

        await database.insertMatch(existingMatch);
        logger.info(`⚡ [WEBHOOK] Real-time score update: ${existingMatch.homeTeam} ${homeScore}-${awayScore} ${existingMatch.awayTeam}`);

        res.json({ success: true, timestamp: Date.now() });
    } catch (error) {
        logger.error('Webhook processing failed:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
