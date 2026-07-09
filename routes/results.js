const express = require('express');
const router = express.Router();
const database = require('../core/database');
const logger = require('../core/logger');

function pickWon(pick, sh, sa) {
    const p = (pick || '').toString().trim().toUpperCase();
    if (p === '1' || p === 'HOME') return sh > sa;
    if (p === '2' || p === 'AWAY') return sa > sh;
    if (p === 'X' || p === 'DRAW') return sh === sa;
    if (p === '1X') return sh >= sa;
    if (p === 'X2') return sa >= sh;
    if (p === '12') return sh !== sa;
    return false;
}

function getOddsForPick(match, pick) {
    const p = (pick || '').toString().trim().toUpperCase();
    if (p === '1' || p === 'HOME') return parseFloat(match.odds_home || match.best_odds_home || match.display_odds_home || 0);
    if (p === '2' || p === 'AWAY') return parseFloat(match.odds_away || match.best_odds_away || match.display_odds_away || 0);
    if (p === 'X' || p === 'DRAW') return parseFloat(match.odds_draw || 0);
    if (p === '1X' || p === 'X2' || p === '12') {
        const h = parseFloat(match.odds_home || match.best_odds_home || match.display_odds_home || 2) || 2;
        const a = parseFloat(match.odds_away || match.best_odds_away || match.display_odds_away || 2) || 2;
        const d = parseFloat(match.odds_draw || 3) || 3;
        if (p === '1X') {
            const prob = (1/h + 1/d);
            return prob > 0 ? 1 / prob : 0;
        }
        if (p === 'X2') {
            const prob = (1/a + 1/d);
            return prob > 0 ? 1 / prob : 0;
        }
        if (p === '12') {
            const prob = (1/h + 1/a);
            return prob > 0 ? 1 / prob : 0;
        }
    }
    return 0;
}

router.get('/elite-tracker', async (req, res) => {
    try {
        const db = database.db;
        const rows = db.prepare(
            "SELECT * FROM historical_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL ORDER BY archived_at DESC LIMIT 100"
        ).all();

        const matches = [];

        for (const row of rows) {
            let fullData = null;
            try { fullData = JSON.parse(row.fullData || '{}'); } catch (_) { continue; }
            const quant = fullData.quant || fullData.enriched?.quant || {};
            const pick = quant.main_pick || fullData.main_pick || fullData.pick;
            if (!pick) continue;

            const ev = parseFloat(quant.ev_score || fullData.ev_score || 0);
            const bsm = parseFloat(fullData.base_solid_margin || 0);
            const dvb = fullData.draw_value_bet === true || fullData.draw_value_bet === 'True' || fullData.draw_value_bet === 1;

            const odds = getOddsForPick(fullData, pick);
            if (odds <= 0) continue;

            const won = pickWon(pick, row.scoreHome, row.scoreAway);
            const profit = won ? (odds - 1) : -1;

            let signal = 'DYNAMIC';
            if (bsm > 0 && bsm >= 25) signal = 'SOLID';
            else if (dvb) signal = 'VALUE BET';

            matches.push({
                id: row.id,
                homeTeam: row.homeTeam,
                awayTeam: row.awayTeam,
                league: row.league || fullData.league || '',
                score: `${row.scoreHome}-${row.scoreAway}`,
                pick,
                odds: Math.round(odds * 100) / 100,
                ev: Math.round(ev * 100) / 100,
                signal,
                result: won ? 'won' : 'lost',
                profit: Math.round(profit * 100) / 100
            });
        }

        const totalBets = matches.length;
        const won = matches.filter(m => m.result === 'won').length;
        const lost = totalBets - won;
        const totalStaked = totalBets;
        const totalReturned = matches.reduce((s, m) => m.result === 'won' ? s + m.odds : s, 0);
        const netProfit = totalReturned - totalStaked;
        const roi = totalStaked > 0 ? Math.round((netProfit / totalStaked) * 10000) / 100 : 0;
        const winRate = totalBets > 0 ? Math.round((won / totalBets) * 10000) / 100 : 0;

        const solidMatches = matches.filter(m => m.signal === 'SOLID');
        const vbMatches = matches.filter(m => m.signal === 'VALUE BET');
        const solidROI = solidMatches.length > 0
            ? Math.round(((solidMatches.reduce((s, m) => m.result === 'won' ? s + m.odds : s, 0) - solidMatches.length) / solidMatches.length) * 10000) / 100
            : 0;
        const vbROI = vbMatches.length > 0
            ? Math.round(((vbMatches.reduce((s, m) => m.result === 'won' ? s + m.odds : s, 0) - vbMatches.length) / vbMatches.length) * 10000) / 100
            : 0;

        res.json({
            success: true,
            roi,
            net_profit: Math.round(netProfit * 100) / 100,
            total_bets: totalBets,
            won,
            lost,
            win_rate: winRate,
            total_staked: totalStaked,
            total_returned: Math.round(totalReturned * 100) / 100,
            by_signal: {
                solid: { count: solidMatches.length, roi: solidROI },
                value_bet: { count: vbMatches.length, roi: vbROI },
                dynamic: { count: matches.filter(m => m.signal === 'DYNAMIC').length }
            },
            matches
        });
    } catch (e) {
        logger.error(`[RESULTS] elite-tracker error: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
