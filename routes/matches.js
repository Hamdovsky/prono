const express = require('express');
const router = express.Router();
const logger = require('../core/logger');
const database = require('../core/database');
const { speedCache, invalidateCache } = require('../core/speedCache');
const enrichedPredictions = require('../core/enriched_predictions');
const { sanitizeMatches } = require('../core/matchSanitizer');
const liveGoalPredictor = require('../services/LiveGoalPredictor');
const liveMatchService = require('../services/liveMatchService');
const { getSteamForMatch } = require('../services/oddsMovementService');
const ValueBetEngine = require('../src/services/ValueBetEngine');
const IntegrityService = require('../services/integrity_service');
const newsService = require('../src/services/newsService');

/**
 * GET /api/live
 * Live matches with goal prediction analysis
 */
router.get('/live', async (req, res) => {
    try {
        const matches = liveMatchService.getActiveMatches()
        const enriched = matches.map(m => {
            const prediction = liveGoalPredictor.analyzeLiveMatch(m)
            return { ...m, goalPrediction: prediction }
        })
        res.json(enriched)
    } catch (err) {
        logger.error(`[LIVE] Error: ${err.message}`)
        res.json([])
    }
});

/**
 * GET /api/live/goal-predictions
 * Expert live goal predictor endpoint
 */
/**
 * GET /api/live-lab
 * Live Lab dashboard data
 */
router.get('/live-lab', async (req, res) => {
    try {
        const matches = liveMatchService.getActiveMatches()
        const enriched = matches.map(m => {
            const prediction = liveGoalPredictor.analyzeLiveMatch(m)

            // Log snapshot for training
            if (m.minute && parseInt(m.minute) > 0) {
                database.logLivePrediction({
                    matchId: m.id,
                    homeTeam: m.homeTeam,
                    awayTeam: m.awayTeam,
                    league: m.league,
                    minute: parseInt(m.minute) || 0,
                    scoreHome: m.scoreHome ?? 0,
                    scoreAway: m.scoreAway ?? 0,
                    predNext5: prediction?.next5min ?? 0,
                    predNext10: prediction?.next10min ?? 0,
                    predNext15: prediction?.next15min ?? 0,
                    homeXg: m.home_xg || m.xg?.home || 0,
                    awayXg: m.away_xg || m.xg?.away || 0,
                    homeSot: m.shots_on_target_home || m.stats?.shotsOnTarget?.home || 0,
                    awaySot: m.shots_on_target_away || m.stats?.shotsOnTarget?.away || 0,
                    homeCorners: m.corners_home || m.stats?.corners?.home || 0,
                    awayCorners: m.corners_away || m.stats?.corners?.away || 0,
                    homePossession: m.possession_home || m.stats?.possession?.home || 50,
                    alertLevel: prediction?.alertLevel || 'NORMAL',
                    source: m.source || 'unknown'
                }).catch(e => logger.warn(`[LIVE] Log prediction failed: ${e.message}`))
            }

            return {
                ...m,
                goalPrediction: prediction,
                stats: m.stats || { dangerousAttacks: { home: 0, away: 0 }, shotsOnTarget: { home: 0, away: 0 }, xg: { home: 0, away: 0 } },
                momentum: m.momentum || { homePercent: 50, awayPercent: 50 },
                alerts: prediction?.alertLevel === 'IMMINENT' || prediction?.alertLevel === 'CRITICAL'
                    ? [{ level: prediction.alertLevel, message: prediction.alertMessage || 'Goal alert' }]
                    : [],
                recoveryRate: 50,
                xgDeviation: { home: 0, away: 0, verdict: 'Normal' },
                dnaInsight: null,
                statsbombInsight: null,
                pronostics: null
            }
        })
        res.json({
            matches: enriched,
            counts: {
                live: matches.filter(m => m.status === 'live').length,
                total: matches.length
            },
            lastUpdate: Date.now()
        })
    } catch (err) {
        logger.error(`[LIVE-LAB] Error: ${err.message}`)
        res.json({ matches: [], counts: { live: 0, total: 0 }, lastUpdate: Date.now() })
    }
});

router.get('/live/goal-predictions', async (req, res) => {
    try {
        const matches = liveMatchService.getActiveMatches()
        const predictions = matches.map(m => ({
            matchId: m.id,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            minute: m.minute,
            score: `${m.scoreHome}-${m.scoreAway}`,
            prediction: liveGoalPredictor.analyzeLiveMatch(m)
        }))
        res.json(predictions)
    } catch (err) {
        logger.error(`[LIVE] Goal prediction error: ${err.message}`)
        res.json([])
    }
});

router.get('/upcoming', speedCache('upcoming', 15000, 600000), async (req, res) => {
    try {
        // [PREMATCH ONLY] strictly filter out live/in-progress matches
        const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        let rawMatches = allMatches;
        
        const daysParam = parseInt(req.query.days) || 3;
        const maxDays = Math.min(Math.max(daysParam, 1), 14);
        const startOfToday = new Date().setHours(0, 0, 0, 0);
        const endOfRange = startOfToday + (maxDays * 24 * 60 * 60 * 1000);
        
        rawMatches = rawMatches.filter(m => {
            let rawTs = m.startTimestamp;
            
            if (!rawTs || rawTs === 0) {
                try {
                    const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData;
                    if (data && data.startTimestamp) rawTs = data.startTimestamp;
                } catch(e) {}
            }
            
            if (!rawTs || rawTs === 0) return false;
            
            let tsMs;
            if (typeof rawTs === 'string' && rawTs.includes('T')) {
                tsMs = new Date(rawTs).getTime();
            } else {
                tsMs = parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000;
            }
            
            if (isNaN(tsMs)) return false;
            
            // Show matches from the start of today up to 72h in future
            return tsMs >= startOfToday && tsMs <= endOfRange;
        });

        // If no upcoming matches, fallback to recent matches (last 7 days)
        if (rawMatches.length === 0) {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).getTime();
            const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
            rawMatches = allMatches.filter(m => {
                let rawTs = m.startTimestamp;
                if (!rawTs || rawTs === 0) {
                    try {
                        const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData;
                        if (data && data.startTimestamp) rawTs = data.startTimestamp;
                    } catch(e) {}
                }
                if (!rawTs || rawTs === 0) return false;
                let tsMs;
                if (typeof rawTs === 'string' && rawTs.includes('T')) {
                    tsMs = new Date(rawTs).getTime();
                } else {
                    tsMs = parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000;
                }
                return !isNaN(tsMs) && tsMs >= sevenDaysAgo;
            });
            if (rawMatches.length > 0) {
                logger.info(`[UPCOMING] No upcoming matches — showing ${rawMatches.length} recent matches as fallback`);
            }
        }

        // 🔁 [STRICT DEDUP] Prioritize most imminent match per team pair
        const teamPairMap = new Map();
        rawMatches.forEach(m => {
            const home = (m.homeTeam || '').toLowerCase().trim();
            const away = (m.awayTeam || '').toLowerCase().trim();
            // Sort pair alphabetically to catch reversed duplicates (ex: A vs B and B vs A)
            const pair = [home, away].sort();
            const pairKey = `${pair[0]}|${pair[1]}`;
            
            const mTs = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
            
            if (!teamPairMap.has(pairKey) || mTs < teamPairMap.get(pairKey)._ts) {
                m._ts = mTs;
                teamPairMap.set(pairKey, m);
            }
        });
        rawMatches = Array.from(teamPairMap.values());

        // 🚫 [QUALITY GATE v2] Server-side filter — élimine les matchs de mauvaise qualité AVANT enrichissement
        const RESERVE_RE = /\b(II|III|IV|B|C|U\d{2}|U-\d{2}|Reserves?|Youth|Academy|Reserve|Filial|Amateurs?|Dev(elopment)?|Juniors?)\b/i;
        const isReserve = (name) => name && RESERVE_RE.test(name);

        rawMatches = rawMatches.filter(m => {
            const home = m.homeTeam || '';
            const away = m.awayTeam || '';
            if (isReserve(home) || isReserve(away)) return false;
            if (/\s(II|III|2|3)$/i.test(home) || /\s(II|III|2|3)$/i.test(away)) return false;
            const oddsH = parseFloat(m.odds_home || 0);
            const oddsA = parseFloat(m.odds_away || 0);
            if ((oddsH > 0 && oddsH < 1.10) || (oddsA > 0 && oddsA < 1.10)) return false;
            return true;
        }).map(m => {
            m.display_odds_home = m.best_odds_home || m.odds_home
            m.display_odds_draw = m.best_odds_draw || m.odds_draw
            m.display_odds_away = m.best_odds_away || m.odds_away
            return m;
        });

        logger.info(`✅ [QUALITY GATE] ${rawMatches.length} quality matches retained.`);

        // 🧹 [DATA SANITIZER] Remove zombie/frozen/corrupted matches before enrichment
        const { sanitized, stats: sanitStats } = sanitizeMatches(rawMatches)
        rawMatches = sanitized
        if (sanitStats.rejected > 0) {
            logger.info(`🧹 [SANITIZER] ${sanitStats.rejected} zombie/corrupted matches removed. Reasons:`, sanitStats.reasons)
        }

        // 🚀 [JIT FAST PASS] Force re-enrichment for matches missing predictions or with stale buggy data
        const maxForce = Math.min(parseInt(req.query.force_count) || 5, 20)
        const needsFastPass = rawMatches.filter(m => {
            const quantMain = m.quant?.main_pick || m.prediction || ''
            const hWP = parseFloat(m.home_win_probability || 0)
            const aWP = parseFloat(m.away_win_probability || 0)
            const dWP = parseFloat(m.draw_probability || 0)
            const maxP = Math.max(hWP, aWP, dWP)
            const minP = Math.min(hWP, aWP, dWP)
            const isFlat = hWP > 0 && (maxP - minP) < 5
            return (
                !hWP || hWP === 0 || !m.expected_score ||
                quantMain === 'UNDER ANALYSIS' || quantMain === 'WAITING' ||
                (isFlat && quantMain === 'X')
            )
        });
        
        if (req.query.force === 'true') {
            const forceMatches = rawMatches.slice(0, maxForce)
            forceMatches.forEach(m => {
                if (!needsFastPass.find(n => n.id === m.id)) needsFastPass.push(m)
            })
            logger.info(`🔧 [JIT] Force re-enrichment of ${forceMatches.length} matches`)
        }
        
        if (needsFastPass.length > 0) {
            logger.info(`✨ [JIT] Batch Quant Enrichment for ${needsFastPass.length} matches (concurrency: 5)...`);
            
            const CONCURRENCY = 5
            const enrichOne = async (m) => {
                try {
                    const enriched = await enrichedPredictions.fastEnrichMatch(m);
                    const idx = rawMatches.findIndex(rm => rm.id === m.id);
                    if (idx !== -1) rawMatches[idx] = enriched;
                    database.updatePredictions(enriched.id, enriched).catch(e => logger.warn(`[JIT] Update predictions failed: ${e.message}`));
                } catch (err) {
                    logger.error(`❌ [JIT] Enrichment failed for ${m.id}: ${err.message}`);
                }
            }
            
            for (let i = 0; i < needsFastPass.length; i += CONCURRENCY) {
                const batch = needsFastPass.slice(i, i + CONCURRENCY)
                await Promise.allSettled(batch.map(enrichOne))
            }
        }

        // 🧠 [NEURAL-X FILTER] Split elite matches from fallback pool
        const elite = [];
        const fallback_pool = [];
        for (const m of rawMatches) {
            const q = m.quant || {};
            const ev = parseFloat(q.ev_score);
            const rl = q.risk_label || '';
            const hWP = parseFloat(m.home_win_probability || 0);
            const dWP = parseFloat(m.draw_probability || 0);
            const aWP = parseFloat(m.away_win_probability || 0);
            const probs = [hWP, dWP, aWP].sort((a, b) => b - a);
            const margin = probs[0] - probs[1];
            const isStable = rl === 'STABLE';
            const isEvDead = ev > 0 && Math.abs(ev - 0.32) < 0.001;
            const isLowEv = ev > 0 && ev < 0.35;
            const isFlat = margin < 5;
            if (isStable || isEvDead || isLowEv || isFlat) {
                fallback_pool.push(m);
            } else {
                elite.push(m);
            }
        }
        // Sort elite by EV descending
        elite.sort((a, b) => {
            const evA = parseFloat((a.quant || {}).ev_score || 0);
            const evB = parseFloat((b.quant || {}).ev_score || 0);
            return evB - evA;
        });
        logger.info(`📊 [UPCOMING] ${elite.length} elite + ${fallback_pool.length} fallback`);
        res.json({ elite, fallback_pool, counts: { elite: elite.length, fallback: fallback_pool.length } });

        // 💡 [OPTIMIZATION] Background enrichment trigger removed. 
        // Enrichment is now handled strictly by the Scraper and Cron jobs to prevent API-driven OOM.
    } catch (err) {
        logger.error(`💥 [API ERROR] GET /api/upcoming failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
});

/**
 * POST /api/refresh-upcoming
 */
router.post('/refresh-upcoming', async (req, res) => {
    try {
        if (typeof invalidateCache === 'function') {
            invalidateCache('upcoming');
        }
        res.json({ success: true, message: 'Cache cleared.' });
    } catch (error) {
        res.status(500).json({ error: 'Refresh failed' });
    }
});

/**
 * GET /api/odds/steam/:matchId
 */
router.get('/odds/steam/:matchId', async (req, res) => {
    try {
        const result = getSteamForMatch(req.params.matchId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/market/edge - Filter for upcoming only
 */
router.get('/market/edge', async (req, res) => {
    try {
        const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        const matches = allMatches.filter(m => m.source === 'africanobet');
        const results = [];
        for (const m of matches) {
            if (!m.home_win_probability || !m.odds_home) continue;
            const analysis = ValueBetEngine.analyzeValue({
                modelHome: m.home_win_probability * 100,
                modelDraw: m.draw_probability * 100,
                modelAway: m.away_win_probability * 100,
                homeOdds: m.odds_home,
                drawOdds: m.odds_draw,
                awayOdds: m.odds_away
            });
            if (analysis && analysis.hasValue) {
                const newsIntel = m.news_data || { headlines: [] };
                const integrity = await IntegrityService.analyzeMatch(m, m, newsIntel);
                results.push({
                    id: m.id,
                    match: `${m.homeTeam} vs ${m.awayTeam}`,
                    league: m.league,
                    time: m.time || m.timestamp,
                    analysis: analysis.best,
                    integrity: {
                        score: integrity.score,
                        status: integrity.trafficLight,
                        recommendation: integrity.recommendation,
                        tags: integrity.strategicTags
                    },
                    sharp_score: m.sharp_score || 0,
                    kelly: analysis.best.kelly
                });
            }
        }
        results.sort((a,b) => b.analysis.edge - a.analysis.edge);
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/refresh-lineups/:id
 */
router.post('/refresh-lineups/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const match = await database.getMatchById(id);
        if (!match) return res.status(404).json({ error: "Not found" });
        const intel = await newsService.getMatchIntelligence(match.id_sofa, match.homeTeam, match.awayTeam, match.startTimestamp, { forceRefresh: true });
        if (intel && intel.confirmed) {
            const updated = await enrichedPredictions.enrichMatch(match);
            res.json({ success: true, confirmed: true, match: updated });
        } else {
            res.json({ success: true, confirmed: false });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Cache invalidation endpoint (called by worker after enrich)
router.post('/invalidate-cache', (req, res) => {
    const key = req.headers['x-api-key']
    if (!key || key !== process.env.API_SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    const prefixes = req.body?.prefixes || ['upcoming', 'live', 'combos']
    for (const p of prefixes) {
        invalidateCache(p)
    }
    res.json({ invalidated: prefixes })
});



module.exports = router;
