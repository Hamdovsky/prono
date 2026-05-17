// VERSION : 5.0.0 — Adversarial Tactical Autopsy
// CHANGES  : DNA Similarity Mapping | Turnpoint Detection | 
//            Arabic Insight Generator | Bayesian Momentum |
//            Sister League Regularization

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║     TITANIUM ADAPTIVE LEARNING ENGINE  —  V2.0.0                ║
 * ║     Self-correcting · Error taxonomy · League DNA weights        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

const DNA_SIMILARITY_MAP = {
    'Premier League':    ['Bundesliga', 'Serie A', 'Ligue 1', 'Eredivisie'],
    'Championship':      ['Ligue 2', '2. Bundesliga', 'Serie B'],
    'League One':        ['National League', 'League Two'],
    'National League':   ['National League North', 'National League South'],
    'Botola Pro':        ['Ligue 1', 'MLS', 'Saudi Pro League'],
    'Saudi Pro League':  ['MLS', 'Botola Pro', 'Super Lig'],
    'Copa Libertadores': ['Liga MX', 'Serie A (Brazil)'],
    'Champions League':  ['Europa League', 'Conference League'],
};

const ARABIC_LABELS = {
    WRONG_OUTCOME:       'خطأ في النتيجة النهائية',
    WRONG_GOAL_PRED:     'خطأ في توقع الأهداف',
    UNDERESTIMATED_FACTOR: 'تقليل من شأن قوة الهجوم/الدفاع',
    OVERESTIMATED_FACTOR:  'تقدير مبالغ فيه للفريق المفضل',
    RED_CARD_IGNORED:    'لم يتم احتساب أثر الطرد',
    XG_ANOMALY:          'شذوذ في الأهداف المتوقعة (إهدار فرص)',
    ODDS_MOVEMENT_MISREAD: 'قراءة خاطئة لحركة الاحتمالات',
    LATE_GOAL_DISRUPTION: 'هدف متأخر غير المجرى',
    GK_MASTERCLASS:      'تألق غير عادي للحارس',
    STRUCTURAL_TEAM_WEAKNESS: 'ضعف هيكلي متكرر في الفريق',
    ODDS_TRAP:           'فخ المراهنات (Favorite Trap)',
};

const database = require('../core/database');
const eventBus = require('./eventBus');
const logger   = require('../core/logger');
const autopsyService = require('./autopsyService');
const lineupService = require('./LineupService');
const SmartOddsAnalyzer = require('./SmartOddsAnalyzer');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ERROR_TYPES = {
    WRONG_OUTCOME:       'WRONG_OUTCOME',
    WRONG_GOAL_PRED:     'WRONG_GOAL_PRED',
    UNDERESTIMATED:      'UNDERESTIMATED_FACTOR',
    OVERESTIMATED:       'OVERESTIMATED_FACTOR',
    CORRECT:             'CORRECT',
};

const ROOT_CAUSES = {
    RED_CARD:            'RED_CARD_IGNORED',
    XG_ANOMALY:          'XG_ANOMALY',
    ODDS_MISREAD:        'ODDS_MOVEMENT_MISREAD',
    INJURY_IGNORED:      'INJURY_IGNORED',
    LATE_GOAL:           'LATE_GOAL_DISRUPTION',
    EARLY_GOAL:          'EARLY_GOAL_DISRUPTION',
    DEFENSIVE_COLLAPSE:  'DEFENSIVE_COLLAPSE',
    GK_MASTERCLASS:      'GK_MASTERCLASS',
    BIG_CHANCE_WASTE:    'BIG_CHANCE_WASTE',
    POSSESSION_TRAP:     'POSSESSION_TRAP',
    FATIGUE:             'FATIGUE_FACTOR',
    DERBY_PRESSURE:      'DERBY_OR_HIGH_PRESSURE',
    TACTICAL_SHIFT:      'TACTICAL_SHIFT',
    DATA_POVERTY:        'DATA_POVERTY',
    VARIANCE:            'NORMAL_VARIANCE',
    STRUCTURAL_WEAKNESS: 'STRUCTURAL_TEAM_WEAKNESS'
};

const MEMORY_TAGS = {
    UPSET:               'unexpected_upset',
    RED_CARD_FLIP:       'red_card_impact',
    OVERRATED_FAV:       'overestimated_favorite',
    XG_WASTE:            'xg_waste',
    LATE_DRAMA:          'late_goal_drama',
    GK_HERO:             'gk_hero',
    LOW_ODDS_TRAP:       'low_odds_trap',
    CORRECT_CALL:        'correct_prediction',
    FRIENDLY_NOISE:      'friendly_match_noise',
    STRUCTURAL_CRISIS:   'recurring_structural_weakness',
};

const DEFAULT_WEIGHTS = {
    form:             0.22,
    xg:               0.18,
    odds:             0.15,
    red_card:         0.10,
    injuries:         0.08,
    possession:       0.07,
    home_advantage:   0.07,
    h2h:              0.06,
    elo:              0.05,
    late_goal_risk:   0.02,
};

const CONFIDENCE_CALIBRATION = {
    overconfident_penalty:  -0.08,
    underconfident_bonus:   +0.05,
    repeat_error_decay:     -0.03,
};

// ─── SCHEMA BOOTSTRAP ────────────────────────────────────────────────────────

// ─── ADAPTIVE LEARNING ENGINE ─────────────────────────────────────────────────

class AdaptiveLearningEngine {
    constructor() {
        this._weightCache    = new Map();
        this._schemaReady    = false;
        this._pendingMatches = [];
        this._ensureSchema(); // [V3] Immediate health check
    }

    // ─── SCHEMA BOOTSTRAP ────────────────────────────────────────────────────────
    
    _ensureSchema() {
        if (this._schemaReady) return;
        const db = database.db;
        db.exec(`
            CREATE TABLE IF NOT EXISTS learning_memory (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id    TEXT    NOT NULL,
                league      TEXT    NOT NULL,
                home_team   TEXT,
                away_team   TEXT,
                score       TEXT,
                prediction  TEXT,
                confidence  REAL,
                actual      TEXT,
                error_type  TEXT,
                root_cause  TEXT,
                context     TEXT,
                tags        TEXT,
                adjustments TEXT,
                new_rule    TEXT,
                match_date  DATETIME,
                root_causes_stack TEXT,
                processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(match_id)
            );

            CREATE TABLE IF NOT EXISTS league_weights (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                league        TEXT    NOT NULL UNIQUE,
                weights       TEXT    NOT NULL,
                confidence_adj REAL   DEFAULT 0.0,
                total_cases   INTEGER DEFAULT 0,
                accuracy      REAL    DEFAULT 0.5,
                last_updated  DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS learning_rules (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                league      TEXT,
                rule_type   TEXT,
                condition   TEXT,
                action      TEXT,
                confidence  REAL,
                hit_count   INTEGER DEFAULT 1,
                last_fired  DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(league, rule_type, condition)
            );

            CREATE TABLE IF NOT EXISTS league_xg_conversion (
                league         TEXT PRIMARY KEY,
                avg_conv_rate  REAL    DEFAULT 0.72,
                sample_size    INTEGER DEFAULT 0,
                variance       REAL    DEFAULT 0.12,
                last_updated   DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS team_momentum (
                team_name     TEXT PRIMARY KEY,
                current_form  REAL    DEFAULT 0.0,
                streak_type   TEXT    DEFAULT 'NEUTRAL',
                last_turnpoint DATE,
                volatility    REAL    DEFAULT 0.1,
                last_updated  DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS league_challenger_weights (
                league        TEXT PRIMARY KEY,
                weights       TEXT NOT NULL,
                accuracy      REAL DEFAULT 0.0,
                total_cases   INTEGER DEFAULT 0,
                last_updated  DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS league_performance_tracking (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                league        TEXT NOT NULL,
                match_id      TEXT NOT NULL,
                champ_result  TEXT,
                chall_result  TEXT,
                timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(league, match_id)
            );
        `);
        
        // Attempt column migrations via try/catch in case they don't exist
        try { db.exec(`ALTER TABLE learning_memory ADD COLUMN match_date DATETIME;`); } catch (_) {}
        try { db.exec(`ALTER TABLE learning_memory ADD COLUMN root_causes_stack TEXT;`); } catch (_) {}
        
        this._schemaReady = true;
    }

    // ─── PUBLIC API ───────────────────────────────────────────────────────────

    async learn(input) {
        try {
            this._ensureSchema();

            const {
                matchId, league, homeTeam, awayTeam,
                prediction, confidence, oddsData = {},
                featuresList = [], actualResult,
                matchStats = {}, scoreHome = 0, scoreAway = 0, matchDate = null
            } = input;

            logger.info(`🧠 [LEARN V2] Processing: ${homeTeam} vs ${awayTeam} — ${league}`);

            // ── STEP 1: Error Analysis ────────────────────────────────────────
            const errorAnalysis  = this._analyzeError(
                prediction, actualResult, scoreHome, scoreAway, matchStats
            );

            // ── UPDATE XG CONVERSION AVG
            this._updateXgConvRate(league, scoreHome + scoreAway, matchStats);

            // ── STEP 2: Root Cause (Priority Stacked + Pattern Memory) ────────
            const { rootCause, causesStack } = await this._detectRootCause(
                errorAnalysis, matchStats, oddsData, featuresList, homeTeam, awayTeam, league
            );

            // ── STEP 3: Context & Surprise ────────────────────────────────────
            const context        = this._analyzeContext(
                homeTeam, awayTeam, league, oddsData,
                errorAnalysis, matchStats, scoreHome, scoreAway
            );

            // ── STEP 4: Weight Adjustments (Bayesian + Temporal) ──────────────
            const adjustments    = await this._computeAdjustments(
                league, errorAnalysis, rootCause, featuresList
            );
            await this._applyWeightAdjustments(league, adjustments, errorAnalysis.isCorrect);

            // ─── V5: ADVERSARIAL BENCHMARKING ──────────────────────────────
            await this._processAdversarialLearning(matchId, league, input, errorAnalysis);

            // ── STEP 5: Calibrate Future Confidence (Tiered Odds) ─────────────
            const oddsUsed = errorAnalysis.predictedSide === 'H' ? oddsData.home 
                           : errorAnalysis.predictedSide === 'A' ? oddsData.away : null;
            
            const confCalib      = this._calibrateConfidence(
                confidence, errorAnalysis, league, context.surpriseFactor, oddsUsed
            );
            await this._saveConfidenceAdj(league, confCalib.adjustment);

            // ── STEP 6: Tagging & Memory ──────────────────────────────────────
            const tags = this._generateTags(errorAnalysis, rootCause, context, confidence, oddsData);

            await this._saveMemory({
                matchId, league, homeTeam, awayTeam,
                score: `${scoreHome}-${scoreAway}`,
                prediction: prediction || 'N/A',
                confidence,
                actual: actualResult,
                errorType: errorAnalysis.errorType,
                rootCause: rootCause,
                context: context.summary,
                tags,
                adjustments,
                newRule: null,
                matchDate: matchDate || new Date().toISOString(),
                causesStack: JSON.stringify(causesStack)
            });

            // ── STEP 7: Rule Extraction ───────────────────────────────────────
            if (!errorAnalysis.isCorrect && rootCause !== ROOT_CAUSES.VARIANCE) {
                const rule = this._deriveRule(league, errorAnalysis.errorType, rootCause, adjustments);
                await this._persistRule(league, rule, errorAnalysis.errorType);
                this._broadcast(league, rule, adjustments, errorAnalysis, tags);
            }

            await this._updateLeagueAccuracy(league);
            
            // 🧠 Apprendre le pattern de mouvement de cotes pour ce match
            try {
                await SmartOddsAnalyzer.learnResult(matchId, { 
                    home: scoreHome, 
                    away: scoreAway 
                });
            } catch (e) {
                logger.debug(`[ODDS LEARNING] Pattern learning skipped: ${e.message}`);
            }

            return {
                success: true,
                errorAnalysis,
                rootCause,
                stackLength: causesStack.length,
                adjustments,
                calibratedConf: confCalib.newBaseline
            };

        } catch (err) {
            logger.error(`[LEARN V2] Engine crash: ${err.message}`);
            return { error: err.message };
        }
    }

    /**
     * Bulk processing of matches. 
     * Useful for startup catch-up or dashboard bulk triggers.
     */
    async processBatch(matches) {
        if (!matches || !Array.isArray(matches)) return { success: false, error: 'Invalid matches array' };
        
        logger.info(`🚀 [LEARN BATCH] Processing ${matches.length} matches...`);
        const results = [];
        for (const match of matches) {
            const res = await this.learn(match);
            results.push({ id: match.matchId, ...res });
        }
        
        const correct = results.filter(r => r.errorAnalysis?.isCorrect).length;
        logger.info(`✅ [LEARN BATCH] Finished. Correct: ${correct}/${matches.length}`);
        
        return {
            success: true,
            totalProcessed: matches.length,
            correctCount: correct,
            details: results
        };
    }

    // ─── IMPROVEMENT 10: ORACLE SIMULATION BRIDGE (V4) ───────────────────────

    /**
     * Provides the "Oracle Context" (Learned DNA) for a league to refine simulations.
     */
    async getSimulationContext(league) {
        try {
            const weights = await this.getWeights(league);
            const xgConv  = this._getLeagueXgConvRate(league);
            const meta    = database.db.prepare(`SELECT confidence_adj, accuracy FROM league_weights WHERE league = ?`).get(league) || { confidence_adj: 0, accuracy: 0.5 };
            
            return {
                weights,
                xgConv,
                confidenceAdj: meta.confidence_adj || 0,
                accuracy:      meta.accuracy || 0.5,
                isLearned:     meta.accuracy !== 0.5
            };
        } catch (_) {
            return { weights: DEFAULT_WEIGHTS, xgConv: 0.72, confidenceAdj: 0, accuracy: 0.5, isLearned: false };
        }
    }

    // ─── IMPROVEMENT 1: TEMPORAL DECAY ENGINE ─────────────────────────────────

    /**
     * Decays older league weights toward baseline DEFAULT_WEIGHTS.
     * Prevents ancient optimization from ruining current form/coaching paradigms.
     */
    _applyTemporalDecay(weights, daysSinceLastMatch) {
        if (!daysSinceLastMatch || daysSinceLastMatch < 14) return weights;
        
        // decay = e^(-0.001 * max(0, days - 14))
        const decay = Math.exp(-0.001 * Math.max(0, daysSinceLastMatch - 14));
        const dec_weights = {};
        
        for (const [key, currentW] of Object.entries(weights)) {
            const defaultW = DEFAULT_WEIGHTS[key] || 0.05;
            dec_weights[key] = currentW * decay + defaultW * (1 - decay);
        }
        
        return dec_weights;
    }

    // ─── IMPROVEMENT 3: TIERED ODDS CONFIDENCE PENALTY ───────────────────────

    /**
     * Maps risk tier to a penalty multiplier
     */
    _getOddsRiskTier(odds) {
        if (!odds || isNaN(odds)) return { tier: 'MODERATE', mult: 1.0 };
        const o = parseFloat(odds);
        if (o < 1.25) return { tier: 'BANKER', mult: 2.5 };
        if (o < 1.45) return { tier: 'EXTREME_FAV', mult: 2.0 };
        if (o < 1.70) return { tier: 'STRONG_FAV', mult: 1.5 };
        if (o < 2.20) return { tier: 'MODERATE', mult: 1.0 };
        return { tier: 'OPEN', mult: 0.5 };
    }

    // ─── IMPROVEMENT 7: DNA CLONING (SISTER LEAGUES) ─────────────────────────

    _getSisterLeagueWeights(league) {
        for (const [parent, sisters] of Object.entries(DNA_SIMILARITY_MAP)) {
            if (sisters.includes(league)) {
                try {
                    const row = database.db.prepare(`SELECT weights FROM league_weights WHERE league = ?`).get(parent);
                    if (row) return JSON.parse(row.weights);
                } catch (_) {}
            }
        }
        return null; // Fallback to defaults
    }

    // ─── IMPROVEMENT 8: ARABIC INSIGHT GENERATOR ─────────────────────────────

    _generateArabicInsight(h, a, analysis, cause, ctx) {
        if (analysis.isCorrect) {
            return `✅ توقع ناجح لمباراة ${h} و ${a}. العوامل التكتيكية كانت ضمن النطاق المتوقع.`;
        }

        const causeAr = ARABIC_LABELS[cause] || cause;
        const surprise = ctx.surpriseFactor > 7 ? 'مفاجأة كبيرة' : 'انحراف منطقي';
        
        let detail = `المحرك استنتج أن السبب الرئيسي هو: **${causeAr}**.`;
        if (cause === ROOT_CAUSES.ODDS_MISREAD) detail += ' حركة السوق كانت تشير لاتجاه مختلف عن الأداء الفني.';
        if (cause === ROOT_CAUSES.RED_CARD) detail += ' حالة الطرد أفسدت المحاكاة الأساسية.';
        
        return `⚠️ تحليل القصور الذاتي (${surprise}): ${h} ضد ${a}. ${detail}`;
    }

    // ─── IMPROVEMENT 9: TEAM MOMENTUM & TURNPOINTS ───────────────────────────

    async _updateTeamMomentum(home, away, result) {
        try {
            const db = database.db;
            const teams = [
                { name: home, pts: result === 'H' ? 3 : result === 'D' ? 1 : 0 },
                { name: away, pts: result === 'A' ? 3 : result === 'D' ? 1 : 0 }
            ];

            for (const t of teams) {
                db.prepare(`
                    INSERT INTO team_momentum (team_name, current_form, last_updated)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(team_name) DO UPDATE SET
                        current_form = (current_form * 0.7) + (? * 0.3),
                        last_updated = CURRENT_TIMESTAMP
                `).run(t.name, t.pts / 3, t.pts / 3);
            }
        } catch (_) {}
    }

    // ─── IMPROVEMENT 4: TEAM PATTERN MEMORY ───────────────────────────────────

    /**
     * Checks if team has recurring failures.
     */
    _getTeamRecentCases(teamName, limit = 5) {
        try {
            const db = database.db;
            return db.prepare(`
                SELECT root_cause, error_type FROM learning_memory 
                WHERE (home_team = ? OR away_team = ?) AND error_type != 'CORRECT'
                ORDER BY match_date DESC LIMIT ?
            `).all(teamName, teamName, limit);
        } catch (_) { return []; }
    }

    // ─── IMPROVEMENT 5: LEAGUE XG CONVERSION TABLE ────────────────────────────

    /**
     * Fetch dynamic xG conversion rate.
     */
    _getLeagueXgConvRate(league) {
        try {
            const data = database.db.prepare(`SELECT avg_conv_rate FROM league_xg_conversion WHERE league = ?`).get(league);
            return data ? data.avg_conv_rate : 0.72; // Default 0.72 per goal
        } catch (_) { return 0.72; }
    }

    /**
     * Update dynamic xG conversion moving average.
     */
    _updateXgConvRate(league, totalGoals, matchStats) {
        try {
            const totalXgStr = matchStats.xg_home ? 
                               parseFloat(matchStats.xg_home) + parseFloat(matchStats.xg_away) : 
                               matchStats.xG ? parseFloat(matchStats.xG.home) + parseFloat(matchStats.xG.away) : 0;
            
            if (totalXgStr <= 0.1) return; // Prevent div by 0 bounds
            
            let rate = Math.min(3.0, totalGoals / totalXgStr); // Clip anomaly
            
            const db = database.db;
            db.prepare(`
                INSERT INTO league_xg_conversion (league, avg_conv_rate, sample_size)
                VALUES (?, ?, 1)
                ON CONFLICT(league) DO UPDATE SET
                    avg_conv_rate = ((avg_conv_rate * sample_size) + excluded.avg_conv_rate) / (sample_size + 1),
                    sample_size   = sample_size + 1,
                    last_updated  = CURRENT_TIMESTAMP
            `).run(league, rate);
        } catch (e) {
            logger.warn(`[LEARN V2] Failed xG conv update: ${e.message}`);
        }
    }

    // ─── STEP 1: ERROR ANALYSIS ───────────────────────────────────────────────

    _analyzeError(prediction, actualResult, scoreHome, scoreAway, matchStats) {
        const pred = (prediction || '').toLowerCase();

        // Determine what was predicted (outcome vs goals)
        const isGoalPred = /o\d|u\d|over|under|btts|buts/.test(pred);
        const is1X2 = !isGoalPred;

        let predictedSide = null;
        if (is1X2) {
            if (/home|1(?!\d)|🏠|domicile/.test(pred))     predictedSide = 'H';
            else if (/away|2(?!\d)|✈️|extérieur/.test(pred)) predictedSide = 'A';
            else if (/draw|x(?!\d)|nul/.test(pred))         predictedSide = 'D';
        }

        const totalGoals = scoreHome + scoreAway;
        let isCorrect    = false;
        let errorType    = ERROR_TYPES.WRONG_OUTCOME;

        if (is1X2 && predictedSide) {
            isCorrect = predictedSide === actualResult;
            errorType = isCorrect ? ERROR_TYPES.CORRECT : ERROR_TYPES.WRONG_OUTCOME;
        } else if (isGoalPred) {
            const m = pred.match(/(\d+\.?\d*)/);
            const line = m ? parseFloat(m[1]) : 2.5;
            const isOver = /over|o\d|\+/.test(pred);
            isCorrect = isOver ? totalGoals > line : totalGoals < line;
            errorType = isCorrect ? ERROR_TYPES.CORRECT : ERROR_TYPES.WRONG_GOAL_PRED;
        }

        if (!isCorrect) {
            const xgHome = parseFloat(matchStats.xg_home || matchStats.xG?.home || 0);
            const xgAway = parseFloat(matchStats.xg_away || matchStats.xG?.away || 0);
            if (xgHome > xgAway + 0.7 && actualResult === 'A') {
                errorType = ERROR_TYPES.UNDERESTIMATED; 
            } else if (xgAway > xgHome + 0.7 && actualResult === 'H') {
                errorType = ERROR_TYPES.UNDERESTIMATED;
            } else if (predictedSide !== null && predictedSide !== actualResult) {
                errorType = ERROR_TYPES.OVERESTIMATED;
            }
        }

        return { isCorrect, errorType, predictedSide, totalGoals };
    }

    // ─── IMPROVEMENT 6: ROOT CAUSE PRIORITY STACKING ──────────────────────────

    async _detectRootCause(errorAnalysis, matchStats, oddsData, featuresList, homeTeam, awayTeam, league) {
        if (errorAnalysis.isCorrect) return { rootCause: ROOT_CAUSES.VARIANCE, causesStack: [] };

        const causes = [];
        const st   = matchStats;
        const rc_h = parseInt(st.red_cards_home || st.redCards?.home || 0);
        const rc_a = parseInt(st.red_cards_away || st.redCards?.away || 0);
        const xgH  = parseFloat(st.xg_home || st.xG?.home || 0);
        const xgA  = parseFloat(st.xg_away || st.xG?.away || 0);
        const posH = parseFloat(st.possession_home || st.possession?.home || 0);
        const sotH = parseInt(st.shots_on_target_home || st.shotsOnTarget?.home || 0);
        const sotA = parseInt(st.shots_on_target_away || st.shotsOnTarget?.away || 0);
        const lateGoal = st.late_goal_minute && parseInt(st.late_goal_minute) > 85;

        // Fetch dynamic threshold using Improvement 5
        const convRate = this._getLeagueXgConvRate(league);
        const dynamicXgThreshold = 1.0 / (convRate > 0.1 ? convRate : 0.72);

        // Score 10: Red Cards ignored
        if ((rc_h > 0 || rc_a > 0) && !featuresList.includes('red_card')) {
            causes.push({ cause: ROOT_CAUSES.RED_CARD, score: 10 });
        }

        // Score 8: Defensive Collapse (6+ goals)
        if (errorAnalysis.totalGoals >= 6) {
            causes.push({ cause: ROOT_CAUSES.DEFENSIVE_COLLAPSE, score: 8 });
        }

        // Score 7: Late Goal
        if (lateGoal) causes.push({ cause: ROOT_CAUSES.LATE_GOAL, score: 7 });

        // Score 6: Dynamic xG Anomaly
        if (xgH > xgA + dynamicXgThreshold && errorAnalysis.errorType !== ERROR_TYPES.CORRECT) {
            causes.push({ cause: ROOT_CAUSES.XG_ANOMALY, score: 6 });
        } else if (xgA > xgH + dynamicXgThreshold && errorAnalysis.errorType !== ERROR_TYPES.CORRECT) {
            causes.push({ cause: ROOT_CAUSES.XG_ANOMALY, score: 6 });
        }

        // Score 5: Odds misread
        if (oddsData.movement && Math.abs(parseFloat(oddsData.movement || 0)) > 0.3) {
            causes.push({ cause: ROOT_CAUSES.ODDS_MISREAD, score: 5 });
        }

        // Score 4: Injury ignored
        if ((st.injuries_home > 0 || st.injuries_away > 0) && !featuresList.includes('injuries')) {
            causes.push({ cause: ROOT_CAUSES.INJURY_IGNORED, score: 4 });
        }

        // Score 3: GK Masterclass
        if ((sotH >= 5 && errorAnalysis.errorType !== ERROR_TYPES.CORRECT) ||
            (sotA >= 5 && errorAnalysis.errorType !== ERROR_TYPES.CORRECT)) {
            causes.push({ cause: ROOT_CAUSES.GK_MASTERCLASS, score: 3 });
        }

        // Score 2: Possession trap
        if (posH > 62 && errorAnalysis.predictedSide === 'H' && !errorAnalysis.isCorrect) {
            causes.push({ cause: ROOT_CAUSES.POSSESSION_TRAP, score: 2 });
        }

        // Score 1: Data Poverty
        if (featuresList.length < 3) causes.push({ cause: ROOT_CAUSES.DATA_POVERTY, score: 1 });

        // Sort causes by severity score descending
        causes.sort((a, b) => b.score - a.score);

        let finalCause = causes.length > 0 ? causes[0].cause : ROOT_CAUSES.VARIANCE;

        // ─── IMPROVEMENT 11: DEEP AUTOPSY OVERRIDE (V5) ─────────────────────
        const deepDiagnosis = await autopsyService.diagnoseMatch(matchStats.matchId);
        if (deepDiagnosis && deepDiagnosis.type !== 'UNKNOWN') {
            const autopsyToRoot = {
                'PERSONNEL_DEFICIT_DISRUPTION': ROOT_CAUSES.RED_CARD,
                'EARLY_TACTICAL_DISRUPTION':    ROOT_CAUSES.EARLY_GOAL,
                'SET_PIECE_DECIDER':           ROOT_CAUSES.VAR_INTERVENTION,
                'SYSTEMIC_DEFENSIVE_FAILURE':   ROOT_CAUSES.DEFENSIVE_COLLAPSE,
                'XG_WASTE':                    ROOT_CAUSES.BIG_CHANCE_WASTE,
                'GK_WALL':                     ROOT_CAUSES.GK_MASTERCLASS,
                'LATE_GOAL':                   ROOT_CAUSES.LATE_GOAL,
                'POSSESSION_FAIL':             ROOT_CAUSES.POSSESSION_TRAP
            };
            
            const rootMap = autopsyToRoot[deepDiagnosis.type];
            if (rootMap) {
                logger.info(`🔬 [V5 AUTOPSY] Overriding Root Cause for ${homeTeam} vs ${awayTeam}: ${rootMap}`);
                finalCause = rootMap;
                causes.unshift({ cause: rootMap, score: 95 });
            }
        }

        // ─── IMPROVEMENT 12: LINEUP DEFICIT DETECTION (V6) ──────────────
        const lineupDeficit = await lineupService.calculateLineupDeficit(matchStats.matchId, matchStats.homeTeamId, matchStats.awayTeamId);
        if (lineupDeficit && lineupDeficit.isFetched) {
            const hDef = lineupDeficit.home.xgPenalty;
            const aDef = lineupDeficit.away.xgPenalty;
            if (hDef > 0.2 || aDef > 0.2) {
                logger.info(`🏃‍♂️ [V6 LINEUP] Significant deficit detected during learning for ${homeTeam} vs ${awayTeam}`);
                causes.push({ cause: ROOT_CAUSES.DATA_POVERTY, score: 9 }); // Data was incomplete (missed lineup)
            }
        }

        // IMPROVEMENT 4: Team Pattern Memory Override
        const failingTeam = errorAnalysis.predictedSide === 'H' ? homeTeam : errorAnalysis.predictedSide === 'A' ? awayTeam : null;
        if (failingTeam) {
            const history = this._getTeamRecentCases(failingTeam, 5);
            const causeCount = history.filter(h => h.root_cause === finalCause).length;
            if (causeCount >= 2 && finalCause !== ROOT_CAUSES.VARIANCE) {
                logger.warn(`[LEARN V2] Pattern detected: ${failingTeam} repeatedly failing on ${finalCause}`);
                finalCause = ROOT_CAUSES.STRUCTURAL_WEAKNESS;
                causes.unshift({ cause: ROOT_CAUSES.STRUCTURAL_WEAKNESS, score: 99 });
            }
        }

        return { rootCause: finalCause, causesStack: causes };
    }

    // ─── STEP 3: CONTEXT ANALYSIS ─────────────────────────────────────────────

    _analyzeContext(homeTeam, awayTeam, league, oddsData, errorAnalysis, matchStats, scoreHome, scoreAway) {
        let surpriseFactor = 0; // 0–10
        const notes        = [];

        if (oddsData.home && oddsData.away) {
            const homeOdds = parseFloat(oddsData.home);
            const awayOdds = parseFloat(oddsData.away);
            if (errorAnalysis.predictedSide === 'H' && !errorAnalysis.isCorrect && awayOdds > 3.0) {
                surpriseFactor += 4;
                notes.push('Heavy favourite home team lost');
            }
            if (errorAnalysis.predictedSide === 'A' && !errorAnalysis.isCorrect && homeOdds > 3.0) {
                surpriseFactor += 4;
            }
        }

        if (errorAnalysis.totalGoals >= 6) {
            surpriseFactor += 2;
            notes.push(`High-scoring match (${scoreHome}-${scoreAway})`);
        }

        const derbyTerms = ['derby', 'clasico', 'clásico', 'final', 'cup', 'coupe', 'cup'];
        if (derbyTerms.some(t => league.toLowerCase().includes(t))) {
            surpriseFactor += 2;
            notes.push('High-pressure match context (Derby/Cup)');
        }

        if (matchStats.days_since_last_match !== undefined && matchStats.days_since_last_match < 3) {
            surpriseFactor += 1;
            notes.push('Possible fatigue — match within 3 days of previous');
        }

        const isLogical  = surpriseFactor < 3;
        const summary   = [
            isLogical ? 'Result was logical given match context.' : 'Surprising result.',
            ...notes
        ].join(' ');

        return { surpriseFactor: Math.min(surpriseFactor, 10), isLogical, summary };
    }

    // ─── STEP 4: MODEL ADJUSTMENT COMPUTATION ────────────────────────────────

    async _computeAdjustments(league, errorAnalysis, rootCause, featuresList) {
        let adj = {};

        if (errorAnalysis.isCorrect) {
            for (const f of featuresList) {
                adj[f] = +0.005; 
            }
            return adj;
        }

        const causeToFeature = {
            [ROOT_CAUSES.RED_CARD]:            'red_card',
            [ROOT_CAUSES.XG_ANOMALY]:          'xg',
            [ROOT_CAUSES.ODDS_MISREAD]:        'odds',
            [ROOT_CAUSES.INJURY_IGNORED]:      'injuries',
            [ROOT_CAUSES.LATE_GOAL]:           'late_goal_risk',
            [ROOT_CAUSES.POSSESSION_TRAP]:     'possession',
            [ROOT_CAUSES.GK_MASTERCLASS]:      'xg',
            [ROOT_CAUSES.DEFENSIVE_COLLAPSE]:  'form',
            [ROOT_CAUSES.STRUCTURAL_WEAKNESS]: 'elo' // Penalize foundational rating
        };

        const targetFeature = causeToFeature[rootCause];

        if (targetFeature) {
            adj[targetFeature] = +0.02;     // Retained strict constraints
            for (const f of featuresList) {
                if (f !== targetFeature && !adj[f]) adj[f] = -0.005;
            }
        }

        if (league.toLowerCase().includes('friendly')) {
            adj['odds'] = (adj['odds'] || 0) - 0.02;
            adj['form'] = (adj['form'] || 0) - 0.01;
        }

        return adj;
    }

    // ─── IMPROVEMENT 2: BAYESIAN SAMPLE REGULARIZATION ───────────────────────

    async _applyWeightAdjustments(league, adjustments, isCorrect) {
        try {
            this._ensureSchema();
            
            // Extract totalCases and last_updated
            let totalCases = 0;
            let lastUpdateDays = 0;
            const db = database.db;
            const meta = db.prepare(`SELECT total_cases, last_updated FROM league_weights WHERE league = ?`).get(league);
            if (meta) {
                totalCases = meta.total_cases || 0;
                lastUpdateDays = Math.floor((Date.now() - new Date(meta.last_updated).getTime()) / (1000 * 3600 * 24));
            }

            // 1. Fetch current
            let current = await this.getWeights(league);

            // 2. Apply Temporal Decay
            current = this._applyTemporalDecay(current, lastUpdateDays);

            // 3. Apply Bayesian Regularization Factor
            const regularizationFactor = 1 - Math.exp(-totalCases / 30);
            const factor = Math.max(0.05, regularizationFactor); // Cap min factor so it still learns minimally on day 1
            
            const updated = { ...current };

            for (const [key, rawDelta] of Object.entries(adjustments)) {
                if (updated[key] !== undefined) {
                    const delta = rawDelta * factor;
                    updated[key] = Math.max(0.01, Math.min(0.5, updated[key] + delta));
                }
            }

            // Re-normalize so sum=1.0
            const total = Object.values(updated).reduce((s, v) => s + v, 0);
            for (const k of Object.keys(updated)) {
                updated[k] = parseFloat((updated[k] / total).toFixed(4));
            }

            this._weightCache.set(league, updated);

            db.prepare(`
                INSERT INTO league_weights (league, weights, total_cases, last_updated)
                VALUES (?, ?, 1, CURRENT_TIMESTAMP)
                ON CONFLICT(league) DO UPDATE SET
                    weights      = excluded.weights,
                    total_cases  = total_cases + 1,
                    last_updated = CURRENT_TIMESTAMP
            `).run(league, JSON.stringify(updated));

        } catch (err) {
            logger.warn(`[LEARN V2] Weight update failed: ${err.message}`);
        }
    }

    // ─── STEP 5: CONFIDENCE CALIBRATION ──────────────────────────────────────

    _calibrateConfidence(confidence, errorAnalysis, league, surpriseFactor, oddsUsed) {
        let adjustment = 0;
        let reason     = '';

        const conf = parseFloat(confidence) || 50;
        const isCorrect = errorAnalysis.isCorrect;

        if (!isCorrect && conf >= 75) {
            const basePenalty = CONFIDENCE_CALIBRATION.overconfident_penalty; 
            
            // Extrapolate Odds Risk Tier penalty multiplier
            const { tier, mult } = this._getOddsRiskTier(oddsUsed);
            
            if (surpriseFactor <= 2) {
                adjustment = basePenalty * 1.5 * mult; 
                reason = `Overconfident (${conf}%) on Logical Match [Tier: ${tier}]. Logic flaw penalty applied.`;
            } else if (surpriseFactor >= 8) {
                adjustment = basePenalty * 0.5 * mult; 
                reason = `Overconfident (${conf}%) on High Chaos [Tier: ${tier}]. Normal variance penalty.`;
            } else {
                adjustment = basePenalty * mult;
                reason = `Overconfident (${conf}%) — [Tier: ${tier}]. Multipled penalty applied.`;
            }
        } else if (isCorrect && conf <= 55) {
            adjustment = CONFIDENCE_CALIBRATION.underconfident_bonus;
            reason     = `Underconfident (${conf}%) — correct prediction. Future confidence bonus applied.`;
        } else {
            reason = 'Confidence level was appropriate given outcome.';
        }

        return { adjustment, reason, newBaseline: conf + (adjustment * 100) };
    }

    async _saveConfidenceAdj(league, adjustment) {
        if (adjustment === 0) return;
        try {
            const db = database.db;
            db.prepare(`
                INSERT INTO league_weights (league, weights, confidence_adj, last_updated)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(league) DO UPDATE SET
                    confidence_adj = MAX(-20, MIN(20, confidence_adj + ?)),
                    last_updated   = CURRENT_TIMESTAMP
            `).run(
                league,
                JSON.stringify(DEFAULT_WEIGHTS),
                adjustment * 100,
                adjustment * 100
            );
        } catch (_) {}
    }

    // ─── STEP 6: MEMORY TAGGING ───────────────────────────────────────────────

    _generateTags(errorAnalysis, rootCause, context, confidence, oddsData) {
        const tags = [];

        if (errorAnalysis.isCorrect) {
            tags.push(MEMORY_TAGS.CORRECT_CALL);
        } else {
            if (context.surpriseFactor >= 5) tags.push(MEMORY_TAGS.UPSET);
            if (rootCause === ROOT_CAUSES.RED_CARD)          tags.push(MEMORY_TAGS.RED_CARD_FLIP);
            if (rootCause === ROOT_CAUSES.XG_ANOMALY)        tags.push(MEMORY_TAGS.XG_WASTE);
            if (rootCause === ROOT_CAUSES.LATE_GOAL)         tags.push(MEMORY_TAGS.LATE_DRAMA);
            if (rootCause === ROOT_CAUSES.GK_MASTERCLASS)    tags.push(MEMORY_TAGS.GK_HERO);
            if (rootCause === ROOT_CAUSES.POSSESSION_TRAP)   tags.push(MEMORY_TAGS.OVERRATED_FAV);
            if (rootCause === ROOT_CAUSES.ODDS_MISREAD)      tags.push(MEMORY_TAGS.LOW_ODDS_TRAP);
            if (rootCause === ROOT_CAUSES.STRUCTURAL_WEAKNESS) tags.push(MEMORY_TAGS.STRUCTURAL_CRISIS);
        }

        if (oddsData.home && parseFloat(oddsData.home) < 1.25 && !errorAnalysis.isCorrect) {
            if (!tags.includes(MEMORY_TAGS.LOW_ODDS_TRAP)) tags.push(MEMORY_TAGS.LOW_ODDS_TRAP);
        }

        return tags;
    }

    // ─── STEP 7: RULE DERIVATION ──────────────────────────────────────────────

    _deriveRule(league, errorType, rootCause, adjustments) {
        const rulesMap = {
            [ROOT_CAUSES.RED_CARD]: {
                rule_type:  'FEATURE_BUMP', condition: 'red_card_detected', action: 'increase_red_card_weight_by_10pct', confidence: 0.80,
            },
            [ROOT_CAUSES.XG_ANOMALY]: {
                rule_type:  'XG_THRESHOLD', condition: 'xg_diff > dynamic_conv and upset', action: 'flag_as_xg_anomaly_and_reduce_confidence', confidence: 0.72,
            },
            [ROOT_CAUSES.ODDS_MISREAD]: {
                rule_type:  'ODDS_MOVEMENT', condition: 'odds_drift > 0.3', action: 'shift_prediction_weight_toward_odds', confidence: 0.68,
            },
            [ROOT_CAUSES.LATE_GOAL]: {
                rule_type:  'LATE_GOAL_RISK', condition: 'minute > 85 and tied', action: 'add_late_goal_risk_signal_to_ou25', confidence: 0.65,
            },
            [ROOT_CAUSES.POSSESSION_TRAP]: {
                rule_type:  'POSSESSION_TRAP', condition: 'possession_home > 62 and result_away', action: 'reduce_possession_weight', confidence: 0.70,
            },
            [ROOT_CAUSES.GK_MASTERCLASS]: {
                rule_type:  'GK_SAVE_BOOST', condition: 'shots_on_target >= 5 and goals <= 1', action: 'reduce_confidence_by_8pct', confidence: 0.62,
            },
            [ROOT_CAUSES.DEFENSIVE_COLLAPSE]: {
                rule_type:  'DEF_COLLAPSE', condition: 'total_goals >= 5', action: 'downgrade_form_weight', confidence: 0.75,
            },
            [ROOT_CAUSES.STRUCTURAL_WEAKNESS]: {
                rule_type:  'TEAM_PATTERN_CRISIS', condition: 'recurring_failure > 2 matches', action: 'override_root_cause_and_decay_elo', confidence: 0.88,
            }
        };

        return rulesMap[rootCause] || {
            rule_type:  'GENERAL_NOISE', condition: 'variance_event', action: 'no_weight_change_required', confidence: 0.40,
        };
    }

    // ─── PERSISTENCE HELPERS ──────────────────────────────────────────────────

    async _saveMemory(data) {
        try {
            const db = database.db;
            db.prepare(`
                INSERT OR REPLACE INTO learning_memory
                    (match_id, league, home_team, away_team, score, prediction,
                     confidence, actual, error_type, root_cause, context,
                     tags, adjustments, new_rule, match_date, root_causes_stack)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
                data.matchId, data.league, data.homeTeam, data.awayTeam, data.score, data.prediction,
                data.confidence, data.actual, data.errorType, data.rootCause, data.context,
                JSON.stringify(data.tags), JSON.stringify(data.adjustments), JSON.stringify(data.newRule),
                data.matchDate, data.causesStack || '[]'
            );
        } catch (err) {
            logger.warn(`[LEARN V2] Memory save failed: ${err.message}`);
        }
    }

    async _persistRule(league, rule, errorType) {
        try {
            const db = database.db;
            db.prepare(`
                INSERT INTO learning_rules (league, rule_type, condition, action, confidence, last_fired)
                VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
                ON CONFLICT(league, rule_type, condition) DO UPDATE SET
                    hit_count  = hit_count + 1,
                    last_fired = CURRENT_TIMESTAMP,
                    confidence = MAX(confidence, excluded.confidence)
            `).run(league, rule.rule_type, rule.condition, rule.action, rule.confidence);
        } catch (_) {}
    }

    async _updateLeagueAccuracy(league) {
        try {
            const db = database.db;
            const stats = db.prepare(`
                SELECT COUNT(*) as total, SUM(CASE WHEN error_type = 'CORRECT' THEN 1 ELSE 0 END) as correct
                FROM learning_memory WHERE league = ?
            `).get(league);
            if (!stats || stats.total === 0) return;
            db.prepare(`UPDATE league_weights SET accuracy = ? WHERE league = ?`).run(stats.correct / stats.total, league);
        } catch (_) {}
    }

    // ─── BROADCAST & READERS ──────────────────────────────────────────────────

    _broadcast(league, rule, adjustments, errorAnalysis, tags) {
        try {
            eventBus.emit('learning_update', {
                league, rule, adjustments,
                errorType:  errorAnalysis.errorType,
                isCorrect:  errorAnalysis.isCorrect,
                tags, timestamp:  Date.now(),
            });
        } catch (_) {}
    }

    async getWeights(league) {
        if (this._weightCache.has(league)) return this._weightCache.get(league);
        this._ensureSchema();
        try {
            const db = database.db;
            const row = db.prepare(`SELECT weights FROM league_weights WHERE league = ?`).get(league);
            if (row && row.weights) {
                const w = JSON.parse(row.weights);
                this._weightCache.set(league, w);
                return w;
            }
            
            // DNA CLONING: Check for sister league fallback
            const sisterWeights = this._getSisterLeagueWeights(league);
            if (sisterWeights) {
                logger.debug(`🧬 [DNA CLONE] Inheriting weights for ${league} from sister league.`);
                this._weightCache.set(league, sisterWeights);
                return sisterWeights;
            }
        } catch (_) {}
        return { ...DEFAULT_WEIGHTS };
    }

    async getLeagueReport(league, dateFilter = null) {
        this._ensureSchema();
        try {
            const db = database.db;
            let params = [];
            let where = [];
            
            if (league !== 'ALL') {
                where.push('TRIM(league) = ?');
                params.push(league.trim());
            }
            
            if (dateFilter) {
                where.push('DATE(match_date) = ?');
                params.push(dateFilter);
            }
            
            const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
            
            // Distributions
            const errorRows = db.prepare(`SELECT error_type, COUNT(*) as count FROM learning_memory ${whereClause} GROUP BY error_type`).all(...params);
            const causeRows = db.prepare(`SELECT root_cause, COUNT(*) as count FROM learning_memory ${whereClause} GROUP BY root_cause`).all(...params);
            
            const errorDistrib = {}; errorRows.forEach(r => errorDistrib[r.error_type] = r.count);
            const causeDistrib = {}; causeRows.forEach(r => causeDistrib[r.root_cause] = r.count);
            
            // Recent Cases
            const recentCases = db.prepare(`SELECT * FROM learning_memory ${whereClause} ORDER BY match_date DESC LIMIT 50`).all(...params);
            
            // Global recent cases if the date is filtered (to show fallback info in UI)
            let allRecentCases = [];
            if (dateFilter) {
                const globalWhere = league !== 'ALL' ? 'WHERE league = ?' : '';
                const globalParams = league !== 'ALL' ? [league] : [];
                allRecentCases = db.prepare(`SELECT * FROM learning_memory ${globalWhere} ORDER BY match_date DESC LIMIT 10`).all(...globalParams);
            }

            const w = await this.getWeights(league === 'ALL' ? 'Premier League' : league); // Default weight for ALL view
            
            const metaQuery = league !== 'ALL' 
                ? `SELECT accuracy, total_cases, confidence_adj FROM league_weights WHERE league = ?` 
                : `SELECT COALESCE(AVG(accuracy), 0.5) as accuracy, COALESCE(SUM(total_cases), 0) as total_cases, COALESCE(AVG(confidence_adj), 0) as confidence_adj FROM league_weights`;
            const meta = db.prepare(metaQuery).get(...(league !== 'ALL' ? [league] : [])) || { accuracy: 0.5, total_cases: 0, confidence_adj: 0 };
            
            let rulesQuery = `SELECT * FROM learning_rules ${whereClause} ORDER BY hit_count DESC LIMIT 20`;
            if (league === 'ALL') {
                rulesQuery = `
                    SELECT rule_type, condition, action, MAX(confidence) as confidence, SUM(hit_count) as hit_count 
                    FROM learning_rules 
                    ${whereClause} 
                    GROUP BY rule_type, condition, action 
                    ORDER BY hit_count DESC 
                    LIMIT 20
                `;
            }
            
            return {
                weights: w,
                confidenceAdj: meta.confidence_adj || 0,
                totalCases: meta.total_cases || (league === 'ALL' ? (db.prepare('SELECT COUNT(*) as c FROM learning_memory').get()?.c || 0) : 0),
                accuracy: meta.accuracy || 0.5,
                errorDistrib,
                causeDistrib,
                recentCases,
                allRecentCases,
                topRules: db.prepare(rulesQuery).all(...params)
            };
        } catch (e) { 
            console.error('[Engine Report Error]', e.message);
            return { 
                weights: DEFAULT_WEIGHTS, accuracy: 0.5, totalCases: 0, 
                errorDistrib: {}, causeDistrib: {}, recentCases: [], allRecentCases: [], topRules: [] 
            };
        }
    }

    // ─── V5: ADVERSARIAL DNA EVOLUTION ────────────────────────────────────────

    async _processAdversarialLearning(matchId, league, input, champAnalysis) {
        try {
            const db = database.db;
            
            // 1. Fetch or Init Challenger
            let challWeights = await this.getChallengerWeights(league);
            
            // 2. Perform "Challenger Analysis" (What would the challenger have predicted?)
            // For now, we simulate if the current correction was applied more aggressively
            const challAnalysis = { ...champAnalysis }; 
            // In a real dual-track, we'd run FPISEngine with challWeights here.
            
            // 3. Update Challenger Weights (Aggressive Bayesian Factor)
            const adjustments = await this._computeAdjustments(league, champAnalysis, 'VARIANCE', []); // Dummy call for base
            await this._applyChallengerWeightAdjustments(league, adjustments, champAnalysis.isCorrect);

            // 4. Track Performance
            db.prepare(`
                INSERT INTO league_performance_tracking (league, match_id, champ_result, chall_result)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(league, match_id) DO NOTHING
            `).run(league, matchId, champAnalysis.isCorrect ? 'WIN' : 'LOSS', challAnalysis.isCorrect ? 'WIN' : 'LOSS');

            // 5. Check for Auto-Promotion (V5 Fully Automatic)
            await this._checkAutoPromotion(league);

        } catch (err) {
            logger.error(`[V5 ADVERSARIAL] ${err.message}`);
        }
    }

    async getChallengerWeights(league) {
        try {
            const row = database.db.prepare(`SELECT weights FROM league_challenger_weights WHERE league = ?`).get(league);
            if (row) return JSON.parse(row.weights);
            
            // Init with Champion + slight jitter
            const champ = await this.getWeights(league);
            const chall = { ...champ };
            Object.keys(chall).forEach(k => chall[k] *= 1.0); // No jitter for deterministic evolution
            return chall;
        } catch (_) { return { ...DEFAULT_WEIGHTS }; }
    }

    async _applyChallengerWeightAdjustments(league, adjustments, isCorrect) {
        // Challenger learns 2x faster than champion to find new peaks
        const current = await this.getChallengerWeights(league);
        const factor = 0.15; // Aggressive
        const updated = { ...current };

        for (const [key, delta] of Object.entries(adjustments)) {
            if (updated[key]) updated[key] = Math.max(0.01, Math.min(0.6, updated[key] + (delta * factor)));
        }
        
        database.db.prepare(`
            INSERT INTO league_challenger_weights (league, weights, last_updated)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(league) DO UPDATE SET weights = excluded.weights, last_updated = CURRENT_TIMESTAMP
        `).run(league, JSON.stringify(updated));
    }

    async _checkAutoPromotion(league) {
        try {
            const db = database.db;
            const stats = db.prepare(`
                SELECT 
                    SUM(CASE WHEN champ_result = 'WIN' THEN 1 ELSE 0 END) as champ_wins,
                    SUM(CASE WHEN chall_result = 'WIN' THEN 1 ELSE 0 END) as chall_wins,
                    COUNT(*) as total
                FROM (SELECT * FROM league_performance_tracking WHERE league = ? ORDER BY timestamp DESC LIMIT 50)
            `).get(league);

            if (stats && stats.total >= 20) {
                const champAcc = stats.champ_wins / stats.total;
                const challAcc = stats.chall_wins / stats.total;

                // V5 Threshold: If challenger is 5% better (absolute) or champ is below 50%
                if (challAcc > (champAcc + 0.05) || (champAcc < 0.45 && challAcc > champAcc)) {
                    logger.info(`🏆 [V5 EVOLUTION] Challenger promoted for ${league}! (Accuracy: ${challAcc.toFixed(2)} vs ${champAcc.toFixed(2)})`);
                    
                    const challWeights = await this.getChallengerWeights(league);
                    
                    // PROMOTE: Swap Challenger to Main
                    db.prepare(`UPDATE league_weights SET weights = ?, accuracy = ? WHERE league = ?`).run(
                        JSON.stringify(challWeights), challAcc, league
                    );

                    // Reset stats for the new cycle
                    db.prepare(`DELETE FROM league_performance_tracking WHERE league = ?`).run(league);
                    
                    eventBus.emit('dna_evolution', { league, accuracy: challAcc, weights: challWeights });
                }
            }
        } catch (err) {
            logger.error(`[V5 PROMOTION] ${err.message}`);
        }
    }
}

module.exports = new AdaptiveLearningEngine();
