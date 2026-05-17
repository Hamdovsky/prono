const express = require('express');
const router = express.Router();
const logger = require('../core/logger');
const { loadAccuracyLog, runAnalysis } = require('../scripts/today_analysis');
const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');
const { LEAGUE_MAP } = require('../config/leagueRegistry');

/**
 * GET /api/autopsy/report
 */
router.get('/autopsy/report', async (req, res) => {
    try {
        const autopsyService = require('../services/autopsyService');
        const report = await autopsyService.generateAutopsyReport();
        res.json(report);
    } catch (err) {
        logger.error(`[Autopsy] API Error: ${err.message}`);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/accuracy
 */
router.get('/accuracy', async (req, res) => {
    try {
        const log = loadAccuracyLog();
        res.json(log);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/accuracy/run
 */
router.post('/api/accuracy/run', async (req, res) => {
    try {
        const date = req.body?.date || new Date().toISOString().split('T')[0];
        const result = await runAnalysis(date);
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/draws/daily
 * أفضل 6 تعادلات مضمونة من خوارزمية التعلم
 */
router.get('/draws/daily', (req, res) => {
    try {
        const { getDailyDraws } = require('../scripts/daily_draws');
        const candidates = getDailyDraws();
        res.json({
            success: true,
            count: candidates.length,
            generatedAt: new Date().toISOString(),
            draws: candidates.map(m => ({
                id: m.id,
                home: m.homeTeam,
                away: m.awayTeam,
                league: m.league,
                time: m.timestamp ? (isNaN(m.timestamp) ? new Date(m.timestamp).toISOString() : new Date(parseInt(m.timestamp) > 1e11 ? parseInt(m.timestamp) : parseInt(m.timestamp) * 1000).toISOString()) : null,
                drawScore: m.drawScore,
                drawProbability: m.draw_probability,
                odds_home: m.odds_home,
                oddsX: m.odds_draw,
                odds_away: m.odds_away,
                expectedScore: m.expected_score,
                reasons: m.drawReasons
            }))
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/high-scoring
 * Sélection des matchs à haut potentiel offensif (Over 2.5)
 */
    router.get('/high-scoring', async (req, res) => {
    try {
        const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        const matches = allMatches.filter(m => m.source === 'africanobet');
        
        // Filter by date (TODAY + TOMORROW - 48h window)
        const now = Date.now();
        const future48h = now + (48 * 60 * 60 * 1000);
        
        const candidates = matches.filter(m => {
            // Handle both timestamp formats
            let ts;
            if (m.startTimestamp) {
                ts = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
            } else if (m.timestamp) {
                ts = new Date(m.timestamp).getTime();
            } else {
                return false;
            }
            
            if (isNaN(ts)) return false;

            // prematch buffer reduced to 1 minute
            const isFuture = ts > (now + 60000);
            const isWithin48h = ts < future48h;
            
            return isFuture && isWithin48h;
        });

        // ── QUALITY-FIRST SORTING ──
        // Prioritize Elite/Tier 1 leagues over chronological order to ensure high-quality picks
        const sortedCandidates = candidates.sort((a, b) => {
            const tierOrder = { 'ELITE': 1, 'TIER1': 2, 'TIER2': 3, 'TIER3': 4 };
            const tierA = a.league_tier || (Object.values(LEAGUE_MAP).find(l => l.name === a.league)?.tier) || 'TIER3';
            const tierB = b.league_tier || (Object.values(LEAGUE_MAP).find(l => l.name === b.league)?.tier) || 'TIER3';
            
            if (tierA !== tierB) return (tierOrder[tierA] || 5) - (tierOrder[tierB] || 5);
            
            // Fallback to chronological if tiers are same
            return (a.startTimestamp || 0) - (b.startTimestamp || 0);
        });

        // Enrichment loop - expanded pool for better coverage
        const enriched = [];
        const limit = 300; 
        const subset = sortedCandidates.slice(0, limit);
        
        logger.info(`[HighScoring] Processing ${subset.length} candidates out of ${candidates.length}`);

        for (const m of subset) {
            try {
                const hasExistingPred = (m.ou_2_5_prob && m.ou_2_5_prob > 0) || (m.ou_25_prob && m.ou_25_prob > 0);
                if (!hasExistingPred) {
                    const enrichedMatch = await enrichedPredictions.fastEnrichMatch(m);
                    enriched.push(enrichedMatch);
                } else {
                    enriched.push(m);
                }
            } catch (err) {
                logger.warn(`[HighScoring] Skipping match ${m.homeTeam}: ${err.message}`);
                enriched.push(m);
            }
        }

        // Filter and Sort
        const picks = enriched
            .filter(m => {
                const ouProb = m.ou_2_5_prob || m.ou_25_prob || 0;
                const bttsProb = m.btts_prob || 0;
                const oddsH = parseFloat(m.odds_home) || 2.0;
                const oddsA = parseFloat(m.odds_away) || 2.0;
                
                const bestOdds = (oddsH && oddsA) ? Math.min(oddsH, oddsA) : null;
                const hasGoodOdds = !bestOdds || (bestOdds >= 1.20 && bestOdds <= 3.50);
                
                // ELITE RULE: High Over 2.5 or Good Over 2.5 + BTTS intensity
                const isHighIntensity = ouProb >= 65 || (ouProb >= 52 && bttsProb >= 40);
                
                return isHighIntensity && hasGoodOdds;
            })
            .sort((a, b) => (b.ou_2_5_prob || 0) - (a.ou_2_5_prob || 0))
            .slice(0, 12);

        res.json({
            success: true,
            count: picks.length,
            generatedAt: new Date().toISOString(),
            picks: picks.map(m => ({
                id: m.id,
                home: m.homeTeam,
                away: m.awayTeam,
                league: m.league,
                time: m.timestamp ? new Date(m.timestamp).toISOString() : null,
                ouProb: m.ou_2_5_prob || m.ou_25_prob || 0,
                bttsProb: m.btts_prob || 0,
                expectedScore: m.expected_score || '1 - 1',
                odds: { home: m.odds_home, draw: m.odds_draw, away: m.odds_away },
                intensity: Math.round(((m.ou_2_5_prob || m.ou_25_prob || 0) + (m.btts_prob || 0)) / 2)
            }))
        });
    } catch (e) {
        logger.error(`[HighScoring] API Error: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/golden-coupon
 * Returns a premium selection of 10 matches with Base Win, Goals, and Correct Score picks.
 */
router.get('/golden-coupon', async (req, res) => {
    try {
        const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        const matches = allMatches.filter(m => m.source === 'africanobet');
        
        // 1. Initial Filtering: Next 48h
        const now = Date.now();
        const future48h = now + (48 * 60 * 60 * 1000);
        const candidates = matches.filter(m => {
            const ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
            return ts > now && ts < future48h;
        });

        // 2. Rank candidates by "Strategic Priority" (XGBoost + Tier)
        const rankedCandidates = candidates
            .map(m => {
                const leagueConfig = LEAGUE_MAP[m.league_id] || Object.values(LEAGUE_MAP).find(l => l.name === m.league) || {};
                const tierWeight = { 'ELITE': 120, 'TIER1': 80, 'TIER2': 40 }[leagueConfig.tier] || 10;
                const baseQuality = m.xgboost_confidence ? m.xgboost_confidence * 100 : (m.v22_success_rate || 50);
                return { ...m, qualityScore: tierWeight + baseQuality, tier: leagueConfig.tier };
            })
            .sort((a,b) => b.qualityScore - a.qualityScore)
            .slice(0, 40);

        // 3. Deep Enrichment
        const enriched = await Promise.all(rankedCandidates.map(m => enrichedPredictions.fastEnrichMatch(m)));

        // 4. Advanced Intelligence Refinement
        const picks = enriched
            .filter(m => {
                // INTELLIGENT FILTER: No Traps for Golden Coupon
                if (m.enriched?.isTrap || m.isTrap) return false;
                
                const winProb = Math.max(m.home_win_probability || 0, m.away_win_probability || 0);
                const confidence = m.enriched?.confidence || 0;
                
                // Only High confidence or VVIP patterns
                return winProb >= 48 || confidence >= 65 || m.neural_boost;
            })
            .sort((a,b) => {
                // Intelligence Ranking: Neural Boost > XGBoost > Prob
                const aBoost = a.neural_boost ? 0.25 : 0;
                const bBoost = b.neural_boost ? 0.25 : 0;
                const aScore = (a.enriched?.winnerProbability || 0) + (a.xgboost_confidence || 0) + aBoost;
                const bScore = (b.enriched?.winnerProbability || 0) + (b.xgboost_confidence || 0) + bBoost;
                return bScore - aScore;
            })
            .slice(0, 10)
            .map(m => {
                const h = m.home_win_probability || 0;
                const a = m.away_win_probability || 0;
                const d = m.draw_probability || 0;
                
                let base = "X";
                if (h > d && h > a) base = "1";
                else if (a > d && a > h) base = "2";

                // [LOGIC ENFORCEMENT] Ensure Score matches the Base and Goals
                let finalScore = m.expected_score || "1 - 1";
                const [sH, sA] = finalScore.split('-').map(s => parseInt(s.trim()));
                let hG = isNaN(sH) ? 1 : sH;
                let aG = isNaN(sA) ? 1 : sA;

                // 1. Align Score with Base
                if (base === '1' && hG <= aG) hG = aG + 1;
                if (base === '2' && aG <= hG) aG = hG + 1;
                if (base === 'X') aG = hG;

                // 2. Align Score with Goals
                const isOverRequested = m.ou_2_5_prob > 55;
                if (isOverRequested && (hG + aG) < 3) {
                    // Boost score to meet Over 2.5
                    if (base === '1') hG += (3 - (hG + aG));
                    else if (base === '2') aG += (3 - (hG + aG));
                    else { hG = 2; aG = 2; } // Draw 2-2
                } else if (!isOverRequested && (hG + aG) >= 3) {
                    // Reduce score to meet Under 2.5
                    if (hG + aG > 0) {
                        const ratio = hG / (hG + aG || 1);
                        hG = Math.round(2 * ratio);
                        aG = 2 - hG;
                        // Re-check base after reduction
                        if (base === '1' && hG <= aG) { hG = 1; aG = 0; }
                        if (base === '2' && aG <= hG) { aG = 1; hG = 0; }
                        if (base === 'X') { hG = 1; aG = 1; }
                    }
                }

                finalScore = `${hG} - ${aG}`;

                const total = (h + a + d) || 100;
                const winningProb = base === '1' ? h : base === '2' ? a : d;
                const realConfidence = Math.round((winningProb / total) * 100);

                return {
                    id: m.id,
                    time: m.timestamp,
                    league: m.league,
                    home: m.homeTeam,
                    away: m.awayTeam,
                    base: base,
                    goals: (hG + aG) >= 3 ? "Over 2.5" : "Under 3.5",
                    correctScore: finalScore,
                    confidence: realConfidence,
                    ai_verified: !!(m.neural_boost || (m.xgboost_confidence || 0) >= 0.65),
                    odds: { h: m.odds_home || 1.8, d: m.odds_draw || 3.3, a: m.odds_away || 4.2 }
                };
            });

        res.json({
            success: true,
            couponId: 'GOLDEN-' + Date.now().toString(36).toUpperCase(),
            count: picks.length,
            picks: picks,
            generatedAt: new Date().toISOString()
        });
    } catch (err) {
        logger.error(`[GoldenCoupon] API Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/safe-ticket
 * Generates multiple "Intelligent" Safe tickets (3-4) with 1X2 or Double Chance picks.
 */
router.get('/safe-ticket', async (req, res) => {
    try {
        const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        const matches = allMatches.filter(m => m.source === 'africanobet');
        
        // 1. Precise Filter & Preliminary Selection
        const now = Date.now();
        const future72h = now + (72 * 60 * 60 * 1000);
        const candidates = matches
            .filter(m => {
                const ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
                return ts > now && ts < future72h;
            })
            // Sort by AI performance first to pick the best candidates for live update
            .sort((a,b) => (parseFloat(b.v22_success_rate) || 0) - (parseFloat(a.v22_success_rate) || 0))
            .slice(0, 40);

        // 2. LIVE SOFASCORE SYNC (Just-In-Time) with DB Fallback
        const oddsService = require('../src/services/oddsService');
        const enrichedPool = await Promise.all(candidates.map(async m => {
            let live = await oddsService.getLiveOdds(m.id);
            
            // 🛡️ [OMNISCIENCE FALLBACK] If live sync fails, use DB odds captured by universal scraper
            if (!live && m.odds_home && m.odds_away) {
                live = { home: m.odds_home, draw: m.odds_draw, away: m.odds_away };
            }
            
            if (!live || !live.home || !live.away) return null;

            const h = parseFloat(m.home_win_probability) || 50;
            const a = parseFloat(m.away_win_probability) || 50;
            const d = parseFloat(m.draw_probability) || 20;

            let pick = h > a ? '1' : '2';
            let prob = Math.max(h, a);
            let odd = h > a ? live.home : live.away;

            // DC Logic based on Real Odds
            if (odd > 1.55 && live.draw) {
                const oddDC = 1 / ((1/odd) + (1/live.draw));
                if (oddDC >= 1.15) {
                    pick = (pick === '1' ? '1X' : 'X2');
                    prob = Math.min(98, prob + d);
                    odd = oddDC;
                }
            }

            // [VALUE-BASED SCORING] Use Expected Value formula: (prob * odd - 1)
            // This naturally rewards high-probability + high-value bets over just low odds.
            const impliedProb = 1 / odd;
            const ev = (prob / 100) - impliedProb; // Positive EV = value bet
            const score = (prob / 100) * odd * 10 + ev * 50; // Weighted composite

            if (odd > 1.85) return null; // Safety Threshold

            return {
                id: m.id, home: m.homeTeam, away: m.awayTeam, league: m.league,
                pick, odd, prob,
                odds_home: live.home || m.odds_home,
                odds_draw: live.draw || m.odds_draw,
                odds_away: live.away || m.odds_away,
                score: score
            };
        }));

        const pool = enrichedPool.filter(p => p !== null).sort((a,b) => b.score - a.score);

        // 3. Assemble Exactly 4 Tickets
        const tickets = [];
        for (let t = 0; t < 4; t++) {
            if (pool.length < 2) break;
            const picks = pool.splice(0, 3).map(p => ({ 
                ...p, 
                odd: p.odd.toFixed(2), 
                prob: Math.round(p.prob),
                odds_home: p.odds_home,
                odds_draw: p.odds_draw,
                odds_away: p.odds_away
            }));
            const totalOdd = picks.reduce((acc, p) => acc * parseFloat(p.odd), 1);
            tickets.push({
                id: 'SAFE-' + (t+1) + '-' + Date.now().toString(36).toUpperCase(),
                picks,
                totalOdd: totalOdd.toFixed(2),
                generatedAt: new Date().toISOString()
            });
        }

        res.json({ success: true, count: tickets.length, tickets, generatedAt: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
module.exports = router;
