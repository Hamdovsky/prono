const express = require('express');
const router = express.Router();
const logger = require('../core/logger');
const database = require('../core/database');
const { speedCache, invalidateCache } = require('../core/speedCache');
const newsService = require('../src/services/newsService');
const enrichedPredictions = require('../core/enriched_predictions');
const ValueBetEngine = require('../src/services/ValueBetEngine');
const IntegrityService = require('../services/integrity_service');
const { getSteamForMatch } = require('../services/oddsMovementService');
const liveGoalPredictor = require('../services/LiveGoalPredictor');

/**
 * GET /api/live
 * Live matches with goal prediction analysis (DISABLED)
 */
router.get('/live', async (req, res) => {
    logger.info('[LIVE API] Live module is disabled.');
    res.json([]);
});

/**
 * GET /api/live/goal-predictions
 * Expert live goal predictor endpoint (DISABLED)
 */
router.get('/live/goal-predictions', async (req, res) => {
    logger.info('[GOAL PREDICTOR API] Live module is disabled.');
    res.json([]);
});

router.get('/upcoming', speedCache('upcoming', 15000, 600000), async (req, res) => {
    try {
        // [PREMATCH ONLY] strictly filter out live/in-progress matches
        const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        // [USER REQUEST] Show top 50 matches from Sofascore/all sources, not just africanobet.
        let rawMatches = allMatches;
        
        // 🧹 [DATA QUALITY] Show ONLY matches for Today, Tomorrow, and Day After
        const nowTs = Date.now();
        const startOfToday = new Date().setHours(0, 0, 0, 0);
        const endOfRange = startOfToday + (72 * 60 * 60 * 1000); // 72h (Today + 2 Days)
        
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

        // 🔁 [STRICT DEDUP] Prioritize most imminent match per team pair
        const teamPairMap = new Map();
        rawMatches.forEach(m => {
            const home = (m.homeTeam || '').toLowerCase().trim();
            const away = (m.awayTeam || '').toLowerCase().trim();
            const pairKey = `${home}|${away}`;
            
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
        });

        logger.info(`✅ [QUALITY GATE] ${rawMatches.length} quality matches retained.`);

        // 🚀 [JIT FAST PASS V4] Force re-enrichment for all pre-V4 matches
        // V4 = Edge Hunter Intelligence (Beating the bookmaker)
        const needsFastPass = rawMatches.filter(m => 
            m.ai_source !== 'TITANIUM_QUANT_V4' || 
            !m.home_win_probability ||
            m.home_win_probability === 0 ||
            !m.expected_score
        );
        
        if (needsFastPass.length > 0) {
            logger.info(`✨ [JIT] Synchronous Quant Enrichment for ${needsFastPass.length} matches...`);
            
            for (const m of needsFastPass) {
                try {
                    const enriched = await enrichedPredictions.fastEnrichMatch(m);
                    const idx = rawMatches.findIndex(rm => rm.id === m.id);
                    if (idx !== -1) rawMatches[idx] = enriched;
                    
                    // Persist to DB so it doesn't need fast enrichment next time
                    database.updatePredictions(enriched.id, enriched).catch(e => {
                        logger.debug(`[JIT-SAVE] Failed to save ${m.id}: ${e.message}`);
                    });
                } catch (err) {
                    logger.error(`❌ [JIT] Enrichment failed for ${m.id}: ${err.message}`);
                }
            }
        }

        // 🌟 [ELITE 500] Serving Top 500 best predicted matches
        rawMatches.sort((a, b) => {
            const getBestProb = (m) => Math.max(
                parseFloat(m.home_win_probability || 0), 
                parseFloat(m.draw_probability || 0), 
                parseFloat(m.away_win_probability || 0)
            );
            return getBestProb(b) - getBestProb(a);
        });
        rawMatches = rawMatches.slice(0, 500);

        logger.info(`📊 [UPCOMING] Serving Top 500 Elite matches.`);
        res.json(rawMatches);

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

/**
 * POST /api/matches/sync
 * Secure cloud synchronization webhook to receive enriched matches pushed from local environments.
 */
router.post('/sync', express.json({ limit: '50mb' }), async (req, res) => {
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
                insufficient_data, odds_home, odds_draw, odds_away, sharp_score
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?
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
                    parseFloat(m.odds_away || 0),
                    parseFloat(m.sharp_score || 0)
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
