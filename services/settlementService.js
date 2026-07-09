/**
 * settlementService.js — Automated Match Settlement Engine
 *
 * Periodically settles finished matches:
 * 1. Fetches missing scores from SofaAPI for finished matches
 * 2. Compares actual result with stored prediction (1/X/2, O/U)
 * 3. Writes WON/LOST to matches.result + prediction_history
 */

const db = require('../core/database');
const logger = require('../core/logger');
const confidenceScorer = require('../core/confidenceScorer');

const SofaAPI = (() => {
    try { return require('../SofascoreScraping/src/apiClient').SofaAPI; } catch { return null; }
})();

// ── Market evaluation ─────────────────────────────────────────────

function evaluatePrediction(prediction, scoreHome, scoreAway, ou25Prob) {
    if (!prediction || prediction === 'UNDER ANALYSIS' || prediction === 'PENDING') return null;
    if (scoreHome === null || scoreHome === undefined || scoreHome < 0) return null;
    if (scoreAway === null || scoreAway === undefined || scoreAway < 0) return null;

    const total = scoreHome + scoreAway;

    // O/U 2.5
    if (prediction.toUpperCase().startsWith('OVER') || prediction.toUpperCase().startsWith('O/U')) {
        const isOver = total > 2.5;
        const isUnder = total < 2.5;
        if (prediction.toUpperCase().includes('OVER')) return isOver ? 'WON' : 'LOST';
        if (prediction.toUpperCase().includes('UNDER')) return isUnder ? 'WON' : 'LOST';
        // Fallback using ou25Prob
        if (ou25Prob !== undefined && ou25Prob !== null) {
            return ou25Prob >= 50 ? isOver ? 'WON' : 'LOST' : isUnder ? 'WON' : 'LOST';
        }
        return null;
    }

    // BTTS (Both Teams To Score)
    if (prediction.toUpperCase().startsWith('BTTS') || prediction.toUpperCase().startsWith('GG')) {
        const bothScored = scoreHome > 0 && scoreAway > 0;
        if (prediction.toUpperCase().includes('YES') || prediction.toUpperCase().includes('OUI')) return bothScored ? 'WON' : 'LOST';
        if (prediction.toUpperCase().includes('NO') || prediction.toUpperCase().includes('NON')) return bothScored ? 'LOST' : 'WON';
        return bothScored ? 'WON' : 'LOST';
    }

    // 1X2
    const isHome = prediction === '1';
    const isDraw = prediction === 'X';
    const isAway = prediction === '2';
    if (isHome) return scoreHome > scoreAway ? 'WON' : 'LOST';
    if (isDraw) return scoreHome === scoreAway ? 'WON' : 'LOST';
    if (isAway) return scoreHome < scoreAway ? 'WON' : 'LOST';

    // Double chance
    if (prediction === '1X') return (scoreHome > scoreAway || scoreHome === scoreAway) ? 'WON' : 'LOST';
    if (prediction === '12') return (scoreHome > scoreAway || scoreHome < scoreAway) ? 'WON' : 'LOST';
    if (prediction === 'X2') return (scoreHome === scoreAway || scoreHome < scoreAway) ? 'WON' : 'LOST';

    // Handicap
    const hcpMatch = prediction.match(/^([+-]?\d+(?:\.\d+)?)\s*(1|X|2)$/);
    if (hcpMatch) {
        const hcp = parseFloat(hcpMatch[1]);
        const side = hcpMatch[2];
        const adjHome = scoreHome + hcp;
        if (side === '1') return adjHome > scoreAway ? 'WON' : 'LOST';
        if (side === 'X') return adjHome === scoreAway ? 'WON' : 'LOST';
        if (side === '2') return adjHome < scoreAway ? 'WON' : 'LOST';
    }

    return null;
}

function classifyMarket(prediction) {
    if (!prediction) return 'UNKNOWN';
    const p = prediction.toUpperCase();
    if (p === '1' || p === 'X' || p === '2') return '1X2';
    if (p === '1X' || p === '12' || p === 'X2') return 'DC';
    if (p.startsWith('OVER') || p.startsWith('UNDER') || p.startsWith('O/U')) return 'OU';
    if (p.startsWith('BTTS') || p.startsWith('GG')) return 'BTTS';
    if (p.match(/^[+-]?\d+(?:\.\d+)?\s*(1|X|2)$/)) return 'HCP';
    return 'OTHER';
}

// ── Core settlement ───────────────────────────────────────────────

async function settleFinishedMatches() {
    logger.info('[SETTLEMENT] Checking for finished matches to settle...');

    const results = { settled: 0, total: 0, skipped: 0 };

    try {
        // Get finished matches with scores that are NOT yet settled
        const rows = db.prepare(`
            SELECT id, "homeTeam", "awayTeam", "scoreHome", "scoreAway", 
                   prediction, league, "ou_25_prob", "home_win_probability", "draw_probability", "away_win_probability",
                   status, "insufficient_data"
            FROM matches
            WHERE status IN ('FT', 'finished', 'Finished', 'Ended')
              AND "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL
              AND ("result" IS NULL OR "result" = '')
            ORDER BY "last_updated" DESC
            LIMIT 200
        `).all();

        if (rows.length === 0) {
            logger.info('[SETTLEMENT] No matches to settle.');
            return { settled: 0, total: 0 };
        }

        logger.info(`[SETTLEMENT] Found ${rows.length} matches to settle.`);
        results.total = rows.length;

        const now = Date.now();

        for (const row of rows) {
            try {
                const scoreHome = parseInt(row.scoreHome) || 0;
                const scoreAway = parseInt(row.scoreAway) || 0;

                // Evaluate the primary prediction
                let result = evaluatePrediction(row.prediction, scoreHome, scoreAway, row.ou_25_prob);

                // If no primary prediction, try to infer from probabilities
                if (!result) {
                    const hProb = parseFloat(row.home_win_probability) || 0;
                    const dProb = parseFloat(row.draw_probability) || 0;
                    const aProb = parseFloat(row.away_win_probability) || 0;
                    const maxProb = Math.max(hProb, dProb, aProb);
                    let inferredPick = null;
                    if (maxProb === hProb) inferredPick = '1';
                    else if (maxProb === dProb) inferredPick = 'X';
                    else if (maxProb === aProb) inferredPick = '2';
                    if (inferredPick) result = evaluatePrediction(inferredPick, scoreHome, scoreAway, row.ou_25_prob);
                }

                if (!result) {
                    results.skipped++;
                    continue;
                }

                // Update matches table
                db.prepare(`
                    UPDATE matches SET "result" = ?, "settled_at" = ? WHERE id = ?
                `).run(result, now, row.id);

                // Update prediction_history
                const histResult = result === 'WON' ? 'won' : 'lost';
                db.prepare(`
                    UPDATE prediction_history 
                    SET status = 'finished', result = ? 
                    WHERE match_id = ? AND status = 'pending'
                `).run(histResult, row.id);

                results.settled++;

                // Feed back into confidence history for league+market calibration
                try {
                    const marketType = ['1X', 'X2', '12'].includes((row.prediction || '').toUpperCase()) ? 'DC' : '1X2';
                    confidenceScorer.recordSettlement(row.league || 'Unknown', marketType, result === 'WON');
                } catch (_) {}

                logger.info(`[SETTLEMENT] ${row.homeTeam} ${scoreHome}-${scoreAway} ${row.awayTeam} → ${result} (prediction: ${row.prediction})`);
            } catch (e) {
                logger.error(`[SETTLEMENT] Error settling ${row.id}: ${e.message}`);
            }
        }

        logger.info(`[SETTLEMENT] Done: ${results.settled} settled, ${results.skipped} skipped`);
    } catch (e) {
        logger.error(`[SETTLEMENT] Global error: ${e.message}`);
    }

    return results;
}

// ── Fetch missing scores for finished matches ─────────────────────

async function fetchMissingScores() {
    logger.info('[SETTLEMENT] Fetching missing scores for finished matches...');

    if (!SofaAPI) {
        logger.warn('[SETTLEMENT] SofaAPI not available — cannot fetch missing scores.');
        return { fetched: 0 };
    }

    let fetched = 0;

    try {
        // Find matches that should be finished but have no scores
        const rows = db.prepare(`
            SELECT m.id, m."homeTeam", m."awayTeam", m."fullData"
            FROM matches m
            WHERE m.status IN ('FT', 'finished', 'Finished', 'Ended')
              AND (m."scoreHome" IS NULL OR m."scoreHome" < 0 OR m."scoreAway" IS NULL OR m."scoreAway" < 0)
              AND ("result" IS NULL OR "result" = '')
            ORDER BY m."last_updated" DESC
            LIMIT 50
        `).all();

        if (rows.length === 0) return { fetched: 0 };

        logger.info(`[SETTLEMENT] Found ${rows.length} matches with missing scores.`);

        for (const row of rows) {
            try {
                const details = await SofaAPI.getMatchDetails(row.id);
                if (!details || !details.event) continue;

                const event = details.event;
                if (event.status?.type !== 'finished' && event.status?.code !== 100) continue;

                const homeScore = event.homeScore?.current ?? event.homeScore?.normaltime ?? null;
                const awayScore = event.awayScore?.current ?? event.awayScore?.normaltime ?? null;

                if (homeScore === null || awayScore === null) continue;

                const currentFullData = JSON.parse(row.fullData || '{}');
                currentFullData.status = 'finished';
                currentFullData.score = { home: homeScore, away: awayScore };

                db.prepare(`
                    UPDATE matches 
                    SET "scoreHome" = ?, "scoreAway" = ?, "fullData" = ?
                    WHERE id = ?
                `).run(homeScore, awayScore, JSON.stringify(currentFullData), row.id);

                logger.info(`[SETTLEMENT] Fetched score: ${row.homeTeam} ${homeScore}-${awayScore} ${row.awayTeam}`);
                fetched++;

                await new Promise(r => setTimeout(r, 1200));
            } catch (e) {
                logger.debug(`[SETTLEMENT] SofaAPI error for ${row.id}: ${e.message}`);
            }
        }
    } catch (e) {
        logger.error(`[SETTLEMENT] fetchMissingScores error: ${e.message}`);
    }

    return { fetched };
}

// ── Analytics ─────────────────────────────────────────────────────

function getPerformance() {
    const settled = db.prepare(`
        SELECT "result", prediction, "ou_25_prob", "home_win_probability", "scoreHome", "scoreAway",
               "fullData"
        FROM matches
        WHERE "result" IN ('WON', 'LOST')
    `).all();

    const total = settled.length;
    const won = settled.filter(r => r.result === 'WON').length;
    const lost = settled.filter(r => r.result === 'LOST').length;
    const winRate = total > 0 ? Math.round(won / total * 1000) / 10 : 0;

    // ROI computation (flat stake 1 unit, average odds 2.0 for simplicity)
    const profitUnits = settled.reduce((sum, r) => {
        return sum + (r.result === 'WON' ? 0.85 : -1);
    }, 0);
    const roiPercent = total > 0 ? Math.round(profitUnits / total * 1000) / 10 : 0;

    // By confidence bracket (from home_win_probability or ou_25_prob)
    const brackets = { '0-50%': { won: 0, lost: 0 }, '50-60%': { won: 0, lost: 0 }, '60-70%': { won: 0, lost: 0 }, '70-80%': { won: 0, lost: 0 }, '80-90%': { won: 0, lost: 0 }, '90%+': { won: 0, lost: 0 } };
    for (const r of settled) {
        const prob = parseFloat(r.home_win_probability) || parseFloat(r.ou_25_prob) || 50;
        const bracket = prob < 50 ? '0-50%' : prob < 60 ? '50-60%' : prob < 70 ? '60-70%' : prob < 80 ? '70-80%' : prob < 90 ? '80-90%' : '90%+';
        if (r.result === 'WON') brackets[bracket].won++;
        else brackets[bracket].lost++;
    }
    const byConfidence = {};
    for (const [bracket, counts] of Object.entries(brackets)) {
        const bTotal = counts.won + counts.lost;
        byConfidence[bracket] = { won: counts.won, lost: counts.lost, total: bTotal, win_rate: bTotal > 0 ? Math.round(counts.won / bTotal * 1000) / 10 : 0 };
    }

    // By market
    const markets = {};
    for (const r of settled) {
        const marketType = classifyMarket(r.prediction);
        if (!markets[marketType]) markets[marketType] = { won: 0, lost: 0 };
        if (r.result === 'WON') markets[marketType].won++;
        else markets[marketType].lost++;
    }
    const byMarket = {};
    for (const [market, counts] of Object.entries(markets)) {
        const mTotal = counts.won + counts.lost;
        byMarket[market] = { won: counts.won, lost: counts.lost, total: mTotal, win_rate: mTotal > 0 ? Math.round(counts.won / mTotal * 1000) / 10 : 0 };
    }

    // Weekly trend (last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const weeklyData = db.prepare(`
        SELECT "result", "settled_at" FROM matches
        WHERE "result" IN ('WON', 'LOST') AND "settled_at" >= ?
        ORDER BY "settled_at" ASC
    `).all(sevenDaysAgo);

    const dailyMap = {};
    for (const r of weeklyData) {
        const day = new Date(r.settled_at).toISOString().split('T')[0];
        if (!dailyMap[day]) dailyMap[day] = { won: 0, lost: 0 };
        if (r.result === 'WON') dailyMap[day].won++;
        else dailyMap[day].lost++;
    }
    const trend = [];
    for (const [day, counts] of Object.entries(dailyMap).sort()) {
        const dTotal = counts.won + counts.lost;
        trend.push({ date: day, won: counts.won, lost: counts.lost, total: dTotal, win_rate: dTotal > 0 ? Math.round(counts.won / dTotal * 1000) / 10 : 0 });
    }

    // Confidence breakdown aggregation (from fullData._confidence_breakdown)
    const breakdownAcc = { baseScore: 0, dominanceScore: 0, drawAdjust: 0, bsmScore: 0, dataScore: 0, historyBonus: 0, count: 0 };
    for (const r of settled) {
        try {
            const fd = typeof r.fullData === 'string' ? JSON.parse(r.fullData) : (r.fullData || {});
            const bd = fd._confidence_breakdown;
            if (bd && typeof bd.baseScore === 'number') {
                breakdownAcc.baseScore += bd.baseScore;
                breakdownAcc.dominanceScore += bd.dominanceScore;
                breakdownAcc.drawAdjust += bd.drawAdjust;
                breakdownAcc.bsmScore += bd.bsmScore;
                breakdownAcc.dataScore += bd.dataScore;
                breakdownAcc.historyBonus += bd.historyBonus;
                breakdownAcc.count++;
            }
        } catch (_) {}
    }
    const c = breakdownAcc.count;
    const confidenceBreakdown = c > 0 ? {
        base_prob:      Math.round(breakdownAcc.baseScore / c),
        dominance_margin: Math.round(breakdownAcc.dominanceScore / c),
        draw_bias:      Math.round(breakdownAcc.drawAdjust / c),
        bsm_quality:    Math.round(breakdownAcc.bsmScore / c),
        data_quality:   Math.round(breakdownAcc.dataScore / c),
        history_bonus:  Math.round(breakdownAcc.historyBonus / c),
    } : null;

    return {
        total_settled: total,
        won,
        lost,
        win_rate: winRate,
        roi_percent: roiPercent,
        profit_units: Math.round(profitUnits * 100) / 100,
        by_confidence: byConfidence,
        by_market: byMarket,
        trend,
        confidence_breakdown: confidenceBreakdown,
    };
}

module.exports = { settleFinishedMatches, fetchMissingScores, getPerformance, evaluatePrediction };
