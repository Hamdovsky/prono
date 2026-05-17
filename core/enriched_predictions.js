const http = require('http');
const logger = require('./logger');
const MatchAuditor = require('../services/MatchAuditor');

/**
 * Enriched Predictions Service
 * Génère des prédictions complètes (gagnant, corners, cartons, buts) pour chaque match
 */

const { spawn } = require('child_process');
const path = require('path');
const newsService = require('../src/services/newsService');
const axiosModule = require('axios');
const { getLiveOdds } = require('../src/services/oddsService');
const { detectBookmakerTrap } = require('../services/oddsMovementService');
const { analyzeValue } = require('../src/services/ValueBetEngine');
const DeepFormService = require('../services/DeepFormService');
const PlayerPropsService = require('../services/playerPropsService');
const pythonService = require('./pythonService');
const goalNewsService = require('../services/goalNewsService');
const sharpService = require('../services/SharpIntelligenceService');
const correlationEngine = require('../services/MarketCorrelationEngine');
const fpisEngine = require('../services/FPISEngine');
const motivationService = require('../services/MotivationEnrichService');
const EnvironmentalIntelligence = require('../services/EnvironmentalIntelligence');
const bankrollService = require('../services/bankrollService'); // V90
const NewsAnalysisService = require('./services/NewsAnalysisService');
const MarketIntelligenceService = require('./services/MarketIntelligenceService');
const StatisticalEngine = require('./services/StatisticalEngine');
const adaptiveLearningEngine = require('../services/adaptiveLearningEngine');
const patternService = require('../services/patternService');
const SmartOddsAnalyzer = require('../services/SmartOddsAnalyzer');
const DiagnosticTrace = require('./utils/DiagnosticTrace');
const Schemas = require('./utils/Schemas');
const QuantumQuantEngine = require('./QuantumQuantEngine');

const SOFA_API = 'https://www.sofascore.com/api/v1';
const SOFA_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.sofascore.com/',
    'Origin': 'https://www.sofascore.com'
};

const NEG_KWS = ['injured', ' out ', 'out for', 'red card', 'suspended', 'ruled out', 'doubtful', 'sidelined', 'absent', 'unavailable', 'misses', 'missing'];
const POS_KWS = ['returned', ' available ', 'fit again', 'back in training', 'recovered', 'back from injury', 'returns to squad', 'cleared to play'];
const ROLE_WEIGHTS = {
    GK: -15, // Increased impact for keeper
    ST: -12, // Critical scorer
    DF: -8,  
    MD: -6,  
    ROT: -15, // Huge impact for second team/rotation
    MGR: 8   
};

const ROLE_KWS = {
    GK: ['keeper', 'goalkeeper', 'gk', 'goal keeper', 'حارس'],
    ST: ['striker', 'forward', 'goalscorer', 'top-scorer', 'leading scorer', 'هداف'],
    DF: ['defender', 'captain', 'center-back', 'centre-back', 'full-back', 'مدافع'],
    MD: ['midfield', 'midfielder', 'playmaker', 'cam ', ' dm ', 'وسط'],
    ROT: ['second team', 'reserve team', 'rotated', 'resting players', 'bench players', 'تشكيلة ثانية', 'احتياط', 'إراحة'],
    MGR: ['manager', 'head coach', 'gaffer', 'appointed as', 'مدرب']
};

class EnrichedPredictionService {
    constructor() {
        this.pythonService = pythonService;
    }

    calculateNewsScore(headlines, confirmedInjuries = [], teamAvgRating = null) {
        return NewsAnalysisService.calculateNewsScore(headlines, confirmedInjuries, teamAvgRating);
    }

    /**
     * Génère des prédictions enrichies pour un match
     */
    async enrichMatch(match) {
        if (!match) return null;
        const trace = new DiagnosticTrace();
        
        try {
            // 0. Validate and Normalize
            match = Schemas.validateMatch(match);
            trace.step('Normalization');

            // 1. Parallel Task Execution (News, Odds, Environmental)
            trace.step('Parallel enrichment start');
            
            const configEngine = require('./configEngine');
            const newsEnabled = configEngine.get('DEEP_NEWS_ENABLED', true);
            
            const [liveOdds, newsIntel] = await Promise.all([
                getLiveOdds(match.id).catch(e => { trace.error('Odds', e.message); return null; }),
                newsEnabled 
                    ? newsService.getMatchIntelligence(match.id, match.homeTeam, match.awayTeam, match.startTimestamp, {
                        countryHint: match.category || '',
                        homeTeamId: match._homeTeamId || null,
                        awayTeamId: match._awayTeamId || null
                    }).catch(e => { trace.error('News', e.message); return null; })
                    : Promise.resolve(null)
            ]);

            if (liveOdds) {
                match.odds_home = liveOdds.home;
                match.odds_draw = liveOdds.draw;
                match.odds_away = liveOdds.away;
                trace.source('Odds', 'SUCCESS', { h: liveOdds.home, a: liveOdds.away });
                
                // 📊 [QUANT] Record Market Snapshot
                try {
                    const QuantRiskService = require('../services/quantRiskService');
                    QuantRiskService.recordMarketSnapshot(match.id, liveOdds, match.status === 'upcoming' ? 'OPENING' : 'LIVE');
                } catch(e) {}
            }

            // 2. Market Intelligence and Python Prediction
            const pythonResult = await this.getAnalyticalPrediction(match);
            trace.step('Python Prediction', { success: pythonResult?.success });

            // 3. News Impact Calculation
            let newsData = null;
            if (newsIntel) {
                const hRating = match.player_ratings_home?.avgRating || match.teamStats?.home?.avgRating || null;
                const aRating = match.player_ratings_away?.avgRating || match.teamStats?.away?.avgRating || null;

                const homeImpact = NewsAnalysisService.calculateNewsScore(newsIntel.home.headlines, newsIntel.home.injuries, hRating);
                const awayImpact = NewsAnalysisService.calculateNewsScore(newsIntel.away.headlines, newsIntel.away.injuries, aRating);

                newsData = {
                    ...newsIntel,
                    impact: {
                        home: homeImpact.score, away: awayImpact.score,
                        home_att: homeImpact.attack, home_def: homeImpact.defense,
                        away_att: awayImpact.attack, away_def: awayImpact.defense,
                        chaos: homeImpact.chaos + awayImpact.chaos,
                        critical: [...homeImpact.critical, ...awayImpact.critical]
                    }
                };
                match.news_data = newsData;
                trace.source('News', 'SUCCESS');
            }

            // 4. Market Signals
            const probs = {
                p_h: (pythonResult?.home_win_probability || 33) / 100,
                p_d: (pythonResult?.draw_probability || 33) / 100,
                p_a: (pythonResult?.away_win_probability || 33) / 100
            };
            const marketIntel = await MarketIntelligenceService.analyze(match, probs);
            match.xgboost_confidence = MarketIntelligenceService.applyMarketBoosts(match, marketIntel);
            trace.step('Market Intelligence');

            // 4.1 Neural Pattern Analysis [V30 UPGRADE]
            const patternResults = patternService.analyze(match);
            if (patternResults.match) {
                match.neural_boost = patternResults;
                if (patternResults.probability > 0.8) {
                    match.isVVIP = true; // Auto-promote to VVIP
                }
            }

            // 5. Final Assembly using Statistical Engine
            const winner = pythonResult?.home_win_probability > pythonResult?.away_win_probability ? match.homeTeam : match.awayTeam;
            const winProb = Math.max(pythonResult?.home_win_probability || 0, pythonResult?.away_win_probability || 0) / 100;

            // 6. RLM Trap Detection
            const trapData = detectBookmakerTrap(
                match.id, 
                winProb * 100, 
                winner === match.homeTeam ? 'HOME' : 'AWAY', 
                { home: match.odds_home, away: match.odds_away, draw: match.odds_draw }
            );

            if (trapData && trapData.isTrap) {
                trace.source('Trap Detector', 'ALERT', { severity: trapData.severity });
                match.tacticalLabels = match.tacticalLabels || [];
                match.tacticalLabels.push('🛑 TRAP ALERT: ' + trapData.msg);
            }

            const enrichedMatch = {
                ...match,
                trace: trace.getSummary(),
                power_score: pythonResult?.power_score || 70,
                verdict: pythonResult?.verdict || "STRONG BET",
                enriched: {
                    winner,
                    winnerProbability: winProb,
                    predictedCorners: StatisticalEngine.predictCorners(match, winProb),
                    predictedCards: StatisticalEngine.predictCards(match),
                    predictedGoals: StatisticalEngine.predictGoals(match, winProb),
                    bankroll_advice: bankrollService.calculateOptimalBet(winProb, match.odds_home || 2.0),
                    is_confirmed: (match.xgboost_confidence >= 0.85),
                    trap_alert: trapData?.isTrap || false,
                    trap_details: trapData?.msg || null,
                    master_v20: await correlationEngine.analyze({ 
                        ...match, 
                        enriched: { 
                            winner, 
                            winnerProbability: winProb,
                            home_win_probability: pythonResult?.home_win_probability || (winProb * 100),
                            away_win_probability: pythonResult?.away_win_probability || 0,
                            draw_probability: pythonResult?.draw_probability || 0
                        } 
                    })
                }
            };

            // ── [QUANT ENGINE] Apply Institutional EV+ & Kelly Math ──
            try {
                const QuantService = require('../services/quantService');
                Object.assign(enrichedMatch, QuantService.injectFinancials(enrichedMatch));
            } catch(e) {
                console.error(`❌ [QUANT] Failed to calculate EV for ${match.id}: ${e.message}`);
            }

            return enrichedMatch;
        } catch (error) {
            trace.error('Global', error.message, error.stack);
            return { ...match, trace: trace.getSummary(), under_analysis: true };
        }
    }

    /**
     * Execute local Python Engine via persistent worker
     */
    async getAnalyticalPrediction(match) {
        try {
            const league = match.league || match.tournament || 'Unknown';
            match.adaptive_weights = await adaptiveLearningEngine.getWeights(league);
            match.adaptive_confidence_adj = await adaptiveLearningEngine.getConfidenceAdjustment(league);
        } catch(e) { /* ignore adaptive errors */ }
        
        return await this.pythonService.predict(match);
    }

    /**
     * Request prediction from XGBoost Flask Bridge
     */
    getXGBoostPrediction(match, newsData = null) {
        return new Promise((resolve) => {
            const data = JSON.stringify({
                id: match.id,
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                teamStats: match.teamStats,
                newsData: newsData,
                form_context: match.form_context,
                historical_context: match.historical_context,
                league: match.tournament || match.league || '',
                tournament: match.category || '',
                startTimestamp: match.startTimestamp || 0
            });

            const options = {
                hostname: '127.0.0.1',
                port: 8000,
                path: '/predict',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: 5000
            };

            const req = http.request(options, (res) => {
                let chunks = '';
                res.on('data', (d) => { chunks += d; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(chunks));
                    } catch (e) {
                        resolve({ success: false, error: 'JSON Parse Error' });
                    }
                });
            });

            req.on('error', (e) => {
                resolve({ success: false, error: e.message });
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Fetch season statistics for one team from Sofascore
     */
    async fetchSofaTeamStats(teamId, uniqueTournamentId, seasonId) {
        try {
            const url = `${SOFA_API}/team/${teamId}/unique-tournament/${uniqueTournamentId}/season/${seasonId}/statistics/overall`;
            const res = await axiosModule.get(url, { headers: SOFA_HEADERS, timeout: 5000 });
            const s = res.data?.statistics;
            if (!s) return null;

            const mp = s.matches || s.matchesPlayed || 0;
            if (!mp || mp === 0) return null;

            return {
                avgGoalsScored: +(s.goalsScored / mp).toFixed(2),
                avgGoalsConceded: +(s.goalsConceded / mp).toFixed(2),
                avgShotsOnTarget: +(s.shotsOnTarget / mp).toFixed(2),
                avgCorners: +((s.corners || s.cornerKicks || 0) / mp).toFixed(2),
                avgBigChances: +((s.bigChances || 0) / mp).toFixed(2),
                avgPossession: +(s.averageBallPossession || 50).toFixed(1),
                matchesPlayed: mp,
            };
        } catch (e) {
            return null;
        }
    }

    getFallbackPrediction(match) {
        // [SAFETY FIX] Stop generating fake predictions based on team name length.
        // Return a clear error state so the UI knows the AI is offline.
        return {
            prediction: 'UNDER ANALYSIS',
            probability: 0,
            confidence: 'none',
            error: 'AI_OFFLINE'
        };
    }

    runBacktestSimulatorFallback(match) {
        // [SAFETY FIX] Prevent "Fortune Telling" fallback.
        return {
            success: false,
            ai_source: 'NONE',
            error: 'AI ENGINE OFFLINE',
            home_win_probability: 0,
            away_win_probability: 0,
            draw_probability: 0,
            verdict: "UNDER ANALYSIS",
            power_score: 0,
            main_predictions: []
        };
    }

    predictCorners(match, winnerPrediction) {
        return StatisticalEngine.predictCorners(match, winnerPrediction.probability);
    }

    predictCards(match) {
        return StatisticalEngine.predictCards(match);
    }

    predictGoals(match, winnerPrediction) {
        return StatisticalEngine.predictGoals(match, winnerPrediction.probability);
    }

    _poissonProb(lambda, k) {
        return StatisticalEngine.getPoissonProb(lambda, k);
    }

    _getMatchXG(m) {
        return StatisticalEngine.getMatchXG(m);
    }

    /**
     * Fast JS-only enrichment for bulk operations.
     * Uses real Poisson distribution based on match-specific xG data.
     * No Python subprocess needed.
     */
    async fastEnrichMatch(match) {
        try {
            const m = { ...match };

            // ── QUALITY GATE ──
            // Reject if missing xG or extreme low entropy data
            let { h: xgH, a: xgA } = this._getMatchXG(m);
            const dataQuality = (xgH > 0.4 && xgA > 0.4) ? 'HIGH' : 'LOW';
            
            // If quality is LOW and no brain data exists, return WAITING state
            if (dataQuality === 'LOW' && (!m.ai_source || !m.ai_source.includes('XGB'))) {
                m.insufficient_data = 1;
                return this._buildOfflineState(m);
            }

            // ── 1. QUANTUM QUANT ANALYSIS ──
            const quantResult = QuantumQuantEngine.analyze(m, xgH, xgA);

            // ── 2. FINAL ASSEMBLY ──
            const resultData = {
                ...m,
                success: true,
                ai_source: 'TITANIUM_QUANT_V4',  // V4 = Edge Hunter Intelligence
                expected_score: quantResult.expected_score,
                home_win_probability: (quantResult.markets.match_result['1'].prob * 100),
                draw_probability: (quantResult.markets.match_result['X'].prob * 100),
                away_win_probability: (quantResult.markets.match_result['2'].prob * 100),
                btts_prob: quantResult.probs.btts,
                ou_25_prob: quantResult.probs.over25,
                ht_goal_prob: quantResult.probs.ht_goal,
                
                // Professional Quant Metrics
                quant: quantResult,
                edge_score: quantResult.edge_score,
                massive_edge: quantResult.massive_edge,
                signal_strength: quantResult.signal_strength,

                confidence: quantResult.confidence,
                risk_score: 100 - quantResult.confidence,
                verdict: quantResult.risk_label,
                
                // UI Predictions Array (for MatchRow)
                predictions: [
                    { label: '🎯 MAIN', val: quantResult.main_pick, ev: quantResult.ev_score },
                    { 
                        label: quantResult.massive_edge ? '🔥 MASSIVE EDGE' : '🧠 EDGE', 
                        val: quantResult.edge_score, 
                        color: quantResult.massive_edge ? '#fbbf24' : (parseFloat(quantResult.edge_score) > 0.05 ? '#f59e0b' : '#6b7280'),
                        pulse: quantResult.massive_edge ? true : false
                    },
                    { label: '📈 2ND', val: quantResult.secondary_pick },
                    { label: '🛡️ RISK', val: quantResult.risk_label }
                ],
                
                enriched: {
                    ...m.enriched,
                    winner: quantResult.main_pick,
                    confidence: quantResult.confidence,
                    is_confirmed: quantResult.confidence > 80,
                    verdict: quantResult.risk_label,
                    main_predictions: quantResult.all_picks.map(p => ({ 
                        label: p.label, 
                        val: `${(p.prob*100).toFixed(0)}% (EV: ${p.ev.toFixed(2)})` 
                    }))
                }
            };

            return resultData;
        } catch (err) {
            logger.error(`[Quant Engine] Overhaul Error: ${err.message}`);
            return this._buildOfflineState(match);
        }
    }

    _buildOfflineState(m) {
        return {
            ...m,
            success: false,
            ai_source: 'WAITING_DATA',
            home_win_probability: 0,
            away_win_probability: 0,
            draw_probability: 0,
            expected_score: 'N/A',
            verdict: "UNDER ANALYSIS",
            power_score: 0,
            quant: { 
                main_pick: 'UNDER ANALYSIS', 
                secondary_pick: 'WAITING DATA',
                ev_score: '0.00', 
                risk_label: 'WAITING',
                market_strength: 'NORMAL'
            },
            predictions: [{ label: 'STATUS', val: 'WAITING DATA' }]
        };
    }

    /**
     * Enrichit une liste de matchs — synchronous fast path, no Python.
     * Python is reserved for single on-demand enrichMatch() calls.
     */
    async enrichMatches(matches, options = {}) {
        const { fastMode = true, backgroundDeepEnrich = true } = options;
        
        // ✅ NE PAS RÉENRICHIR LES MATCHS DÉJÀ ENRICHIS
        // Évite 95% des calculs inutiles au redémarrage
        const needsEnrichment = matches.filter(m => 
            !m.home_win_probability || 
            m.home_win_probability === 0 || 
            !m.expected_score || 
            !m.expected_score
        );
        
        const alreadyEnriched = matches.filter(m => !needsEnrichment.includes(m));
        
        logger.info(`⚡ [ENRICH] ${alreadyEnriched.length} matchs déjà enrichis, ${needsEnrichment.length} à traiter`);
        
        // MODE RAPIDE PAR DÉFAUT: Rendu instantané < 100ms
        const fastResults = await Promise.all(needsEnrichment.map(async m => {
            try {
                return await this.fastEnrichMatch(m);
            } catch (err) {
                logger.error(`❌ [ENRICH] Fast path failed for ${m.homeTeam}:`, err.message);
                return m;
            }
        }));
        
        // 💡 [OPTIMIZATION] Recursive background enrichment removed.
        // Single-pass fast enrichment is sufficient for bulk operations.
        // Deep enrichment (Python/News) is now reserved for on-demand single match calls.
        
        return [...alreadyEnriched, ...fastResults];
    }
    
    /**
     * Version pour dashboard: Ultra rapide, rendu en < 50ms
     */
    async enrichMatchesDashboard(matches) {
        // PAS D'ATTENTE, PAS DE PYTHON, RENDU INSTANTANÉ
        return Promise.all(matches.map(m => this.fastEnrichMatch(m)));
    }

    /**
     * [NEW] Strategic Reasoning Engine v2.1 (Ultra Precision)
     * Generates a "Who & Why" narrative in Arabic with real player names and headlines
     */
    generateStrategicReasoning(match, newsData) {
        let reasons = [];
        const impact = newsData?.impact || {};
        const score = impact.home - impact.away;
        
        // 1. Sentiment & Media Momentum
        if (score >= 8) reasons.push("زخم إعلامي هائل وتغطية إيجابية لصالح صاحب الأرض");
        else if (score <= -8) reasons.push("تغطية إعلامية سلبية جداً وتوتر في معسكر الفريق المضيف");
        else if (score > 3) reasons.push("استقرار فني وأخبار مشجعة ترفع معنويات الفريق المضيف");
        else if (score < -3) reasons.push("أفضلية معنوية واضحة للضيوف بناءً على آخر التقارير");

        // 2. REAL INFO: Specific Absences & Player Names
        const critical = impact.critical || [];
        const playerOuts = critical.filter(c => c.includes('OUT')).map(c => c.replace(' OUT', '').replace(' (Official)', '').replace(' (TM)', ''));
        
        if (playerOuts.length > 0) {
            const names = playerOuts.slice(0, 2).join(' و ');
            reasons.push(`غيابات هامة تتضمن ${names} مما يقلل الكفاءة التشغيلية`);
        }

        // 3. [V75] Referee & Pitch Intelligence
        if (match.referee_yellow_avg > 0 || match.referee_id) {
            const refProfile = EnvironmentalIntelligence.profileReferee({
                yellow_avg: match.referee_yellow_avg,
                red_avg: match.referee_red_avg,
                penalties_avg: match.referee_penalties_avg
            });
            reasons.push(refProfile.description_ar);
        }

        if (match.weather_temp || match.weather_desc) {
            const wImpact = EnvironmentalIntelligence.analyzeWeather({
                temp: match.weather_temp,
                desc: match.weather_desc
            });
            if (wImpact.labels_ar && wImpact.labels_ar.length > 0) {
                reasons.push(wImpact.labels_ar[0]);
            }
        }

        if (critical.some(c => c.includes('LATE FITNESS TEST'))) {
            reasons.push("غموض حول جاهزية بعض النجوم الأساسيين مما يزيد من عامل المخاطرة");
        }

        // 4. Specific Tactical Logic
        if (critical.some(c => c.includes('GK'))) reasons.push("هناك قلق بشأن حراسة المرمى قد يستغله الخصم");
        if (critical.some(c => c.includes('ST'))) reasons.push("نقص في الحلول الهجومية لغياب صانع اللعب أو الهداف");

        // 5. Momentum & Fatigue
        if (match.home_attack_impact > 1.1) reasons.push("تحسن ملحوظ في الفاعلية الهجومية مؤخراً");
        if (match.fatigue_h < 0.9 || match.fatigue_a < 0.9) reasons.push("عامل الإرهاق البدني قد يلعب دوراً حاسماً في الدقائق الأخيرة");

        // 6. [V85] Market Intelligence (Steam & RLM)
        if (match.market_signals && match.market_signals.length > 0) {
            match.market_signals.forEach(sig => {
                reasons.push(sig.msg);
            });
        }

        const weatherAnalysis = EnvironmentalIntelligence.analyzeWeather({
            temp: match.weather_temp,
            desc: match.weather_desc,
            humidity: match.weather_humidity
        });
        if (weatherAnalysis.labels_ar.length > 0) {
            reasons.push(weatherAnalysis.labels_ar[0]);
        }

        if (reasons.length === 0) {
            return "تحليل فني متزن بناءً على معطيات القوة التاريخية والحالية للفريقين.";
        }

        // Return a clean combination of top 3-4 insights
        return reasons.slice(0, 4).join(' + ');
    }

    /**
     * [V52-Titanium] Validates the feature vector shape (115 features required)
     */
    validateVector(vector) {
        if (!Array.isArray(vector)) {
            console.error("❌ [V52-Validation] Vector is not an array!");
            return false;
        }
        if (vector.length !== 115) {
            console.warn(`⚠️ [V52-Validation] Shape Mismatch! Expected 115, got ${vector.length}. This will cause XGBoost failure.`);
            return false;
        }
        // Check for NaN or Nulls in the vector
        const invalidIdx = vector.findIndex(v => v === null || v === undefined || isNaN(v));
        if (invalidIdx !== -1) {
            console.warn(`⚠️ [V52-Validation] Type Error! Found invalid value at index ${invalidIdx}: ${vector[invalidIdx]}`);
            return false;
        }
        return true;
    }

}

module.exports = new EnrichedPredictionService();
