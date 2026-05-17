/**
 * SmartOddsAnalyzer.js - Analyseur Intelligent de Mouvements de Cotes
 * Apprentissage automatique, détection de patterns, intégration pronostics
 */

const db = require('../core/database_pg');
const crypto = require('crypto');

class SmartOddsAnalyzer {
    constructor() {
        this.patternCache = new Map();
        this.MIN_PATTERN_OCCURRENCES = 5;
        this.STEAM_THRESHOLD = 8; // % de baisse = signal fort
    }

    /**
     * Analyse complète des mouvements de cotes pour un match
     */
    async analyzeMatch(matchId) {
        const history = await this.getOddsHistory(matchId);
        if (history.length < 2) return { has_data: false };

        const movement = this.calculateMovement(history);
        const pattern = await this.detectPattern(movement, history);
        const patternPrediction = await this.getPatternPrediction(pattern);
        const signals = this.extractSignals(movement, history);

        return {
            has_data: true,
            history_count: history.length,
            movement,
            pattern,
            pattern_prediction: patternPrediction,
            signals,
            smart_confidence: this.calculateSmartConfidence(patternPrediction, signals)
        };
    }

    /**
     * Récupère tout l'historique des cotes pour un match
     */
    async getOddsHistory(matchId) {
        return await db.db.query(`
            SELECT * FROM odds_history 
            WHERE match_id = $1 
            ORDER BY timestamp ASC
        `, [matchId]).then(res => res.rows);
    }

    /**
     * Calcule tous les indicateurs de mouvement
     */
    calculateMovement(history) {
        const first = history[0];
        const last = history[history.length - 1];
        const mid = history[Math.floor(history.length / 2)];

        const calcDelta = (a, b) => a && b ? ((b - a) / a) * 100 : 0;

        return {
            home_delta_total: calcDelta(first.odds_home, last.odds_home),
            away_delta_total: calcDelta(first.odds_away, last.odds_away),
            draw_delta_total: calcDelta(first.odds_draw, last.odds_draw),
            
            home_delta_recent: calcDelta(mid.odds_home, last.odds_home),
            away_delta_recent: calcDelta(mid.odds_away, last.odds_away),
            
            velocity_home: this.calculateVelocity(history, 'odds_home'),
            velocity_away: this.calculateVelocity(history, 'odds_away'),
            
            volatility_home: this.calculateVolatility(history, 'odds_home'),
            volatility_away: this.calculateVolatility(history, 'odds_away'),
            
            opening: { h: first.odds_home, d: first.odds_draw, a: first.odds_away },
            current: { h: last.odds_home, d: last.odds_draw, a: last.odds_away }
        };
    }

    /**
     * Calcule la vitesse de variation des cotes
     */
    calculateVelocity(history, field) {
        if (history.length < 3) return 0;
        let totalChange = 0;
        for (let i = 1; i < history.length; i++) {
            const prev = history[i-1][field];
            const curr = history[i][field];
            if (prev && curr) totalChange += Math.abs(curr - prev);
        }
        return totalChange / history.length;
    }

    /**
     * Calcule la volatilité
     */
    calculateVolatility(history, field) {
        const values = history.map(h => h[field]).filter(v => v);
        if (values.length < 2) return 0;
        const avg = values.reduce((a,b) => a+b, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
        return Math.sqrt(variance);
    }

    /**
     * Détecte le pattern de mouvement
     */
    async detectPattern(movement, history) {
        const profile = {
            direction: movement.home_delta_total < 0 ? 'HOME_DOWN' : 
                       movement.away_delta_total < 0 ? 'AWAY_DOWN' : 'STABLE',
            steepness: Math.abs(movement.home_delta_total) > 15 ? 'SHARP' : 
                      Math.abs(movement.home_delta_total) > 5 ? 'MODERATE' : 'FLAT',
            timing: history.length > 10 ? 'LATE' : 'EARLY',
            volatility: movement.volatility_home > 0.3 ? 'HIGH' : 'LOW',
            velocity: movement.velocity_home > 0.1 ? 'FAST' : 'SLOW'
        };

        const hash = crypto.createHash('sha256')
            .update(JSON.stringify(profile))
            .digest('hex');

        return { hash, profile, movement_signature: Object.values(profile).join('_') };
    }

    /**
     * Récupère la prédiction basée sur les patterns historiques appris
     */
    async getPatternPrediction(pattern) {
        const existing = await db.db.query(`
            SELECT * FROM odds_patterns 
            WHERE pattern_hash = $1
        `, [pattern.hash]).then(res => res.rows[0]);

        if (!existing || existing.occurrences < this.MIN_PATTERN_OCCURRENCES) {
            return { known: false, confidence: 0 };
        }

        const maxWin = Math.max(
            existing.win_rate_home, 
            existing.win_rate_draw, 
            existing.win_rate_away
        );

        let predictedOutcome = 'UNKNOWN';
        if (maxWin === existing.win_rate_home) predictedOutcome = 'HOME';
        else if (maxWin === existing.win_rate_away) predictedOutcome = 'AWAY';
        else predictedOutcome = 'DRAW';

        return {
            known: true,
            occurrences: existing.occurrences,
            predicted_outcome: predictedOutcome,
            win_rate: maxWin,
            avg_goals: existing.avg_total_goals,
            confidence: existing.confidence,
            pattern_type: existing.pattern_type
        };
    }

    /**
     * Extrait tous les signaux intelligents
     */
    extractSignals(movement) {
        const signals = [];
        let confidenceBonus = 0;

        // Signal 1: Fort mouvement baissier sur domicile (Sharp Money)
        if (movement.home_delta_total < -this.STEAM_THRESHOLD) {
            signals.push({
                type: 'STEAM_HOME',
                strength: Math.abs(movement.home_delta_total),
                description: `Gros argent entrant sur domicile: ${movement.home_delta_total.toFixed(1)}% de baisse`
            });
            confidenceBonus += 15;
        }

        // Signal 2: Fort mouvement baissier sur extérieur
        if (movement.away_delta_total < -this.STEAM_THRESHOLD) {
            signals.push({
                type: 'STEAM_AWAY',
                strength: Math.abs(movement.away_delta_total),
                description: `Gros argent entrant sur extérieur: ${movement.away_delta_total.toFixed(1)}% de baisse`
            });
            confidenceBonus += 15;
        }

        // Signal 3: Mouvement rapide = information récente
        if (movement.velocity_home > 0.2 || movement.velocity_away > 0.2) {
            signals.push({
                type: 'FAST_MOVEMENT',
                strength: 10,
                description: 'Mouvement très rapide = information fraîche'
            });
            confidenceBonus += 10;
        }

        // Signal 4: Haute volatilité = incertitude du marché
        if (movement.volatility_home > 0.4) {
            signals.push({
                type: 'HIGH_VOLATILITY',
                strength: -10,
                description: 'Haute volatilité = marché indécis / informations contradictoires'
            });
            confidenceBonus -= 10;
        }

        // Signal 5: Piège du bookmaker (cotes qui montent sur le favori)
        if (movement.home_delta_total > 10 && movement.current.h < 2.2) {
            signals.push({
                type: 'BOOKMAKER_TRAP',
                strength: -20,
                description: '⚠️ PIÈGE: Cotes domicile qui montent alors que c\'est le favori!'
            });
            confidenceBonus -= 25;
        }

        return { list: signals, total_bonus: confidenceBonus };
    }

    /**
     * Calcule la confiance intelligente finale
     */
    calculateSmartConfidence(patternPrediction, signals) {
        let base = 50;
        
        if (patternPrediction.known) {
            base += patternPrediction.confidence * 0.5;
        }
        
        base += signals.total_bonus;
        
        return Math.max(0, Math.min(100, base));
    }

    /**
     * Apprend un nouveau résultat pour améliorer les patterns
     */
    async learnResult(matchId, finalScore) {
        const history = await this.getOddsHistory(matchId);
        if (history.length < 3) return false;

        const movement = this.calculateMovement(history);
        const pattern = await this.detectPattern(movement, history);

        const totalGoals = finalScore.home + finalScore.away;
        const outcome = finalScore.home > finalScore.away ? 'home' : 
                       finalScore.home < finalScore.away ? 'away' : 'draw';

        // Mettre à jour ou créer le pattern
        await db.db.query(`
            INSERT INTO odds_patterns (
                pattern_hash, pattern_type, movement_profile, 
                occurrences, win_rate_home, win_rate_draw, win_rate_away, 
                avg_total_goals, confidence, last_seen
            ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 50, $8)
            ON CONFLICT(pattern_hash) DO UPDATE SET
                occurrences = odds_patterns.occurrences + 1,
                win_rate_home = (odds_patterns.win_rate_home * odds_patterns.occurrences + $4) / (odds_patterns.occurrences + 1),
                win_rate_draw = (odds_patterns.win_rate_draw * odds_patterns.occurrences + $5) / (odds_patterns.occurrences + 1),
                win_rate_away = (odds_patterns.win_rate_away * odds_patterns.occurrences + $6) / (odds_patterns.occurrences + 1),
                avg_total_goals = (odds_patterns.avg_total_goals * odds_patterns.occurrences + $7) / (odds_patterns.occurrences + 1),
                confidence = MIN(95, 40 + (odds_patterns.occurrences * 3)),
                last_seen = $8
        `, [
            pattern.hash, 
            pattern.movement_signature,
            JSON.stringify(pattern.profile),
            outcome === 'home' ? 1 : 0,
            outcome === 'draw' ? 1 : 0,
            outcome === 'away' ? 1 : 0,
            totalGoals,
            Date.now()
        ]);

        console.log(`🧠 [APPRENTISSAGE] Pattern ${pattern.hash} mis à jour pour résultat ${outcome}`);
        return true;
    }

    /**
     * Ajuste la prédiction finale en utilisant l'analyse des cotes
     */
    async adjustPrediction(basePrediction, matchId) {
        const oddsAnalysis = await this.analyzeMatch(matchId);
        
        if (!oddsAnalysis.has_data) return basePrediction;

        const adjusted = { ...basePrediction };
        
        // Appliquer les signaux
        oddsAnalysis.signals.list.forEach(signal => {
            if (signal.type === 'STEAM_HOME') {
                adjusted.home_win_probability = Math.min(95, adjusted.home_win_probability + (signal.strength * 0.8));
                adjusted.confidence = Math.min(95, adjusted.confidence + 5);
            }
            if (signal.type === 'STEAM_AWAY') {
                adjusted.away_win_probability = Math.min(95, adjusted.away_win_probability + (signal.strength * 0.8));
                adjusted.confidence = Math.min(95, adjusted.confidence + 5);
            }
            if (signal.type === 'BOOKMAKER_TRAP') {
                adjusted.confidence = Math.max(20, adjusted.confidence - 15);
                adjusted.prediction_logic = (adjusted.prediction_logic || '') + ' | ⚠️ PIÈGE DÉTECTÉ';
            }
        });

        // Appliquer les patterns appris
        if (oddsAnalysis.pattern_prediction.known && oddsAnalysis.pattern_prediction.confidence > 60) {
            const pred = oddsAnalysis.pattern_prediction;
            if (pred.predicted_outcome === 'HOME') {
                adjusted.home_win_probability += 10;
            } else if (pred.predicted_outcome === 'AWAY') {
                adjusted.away_win_probability += 10;
            }
            
            adjusted.pattern_based_adjustment = true;
            adjusted.pattern_confidence = pred.confidence;
        }

        // Renormaliser les probabilités
        const total = adjusted.home_win_probability + adjusted.draw_probability + adjusted.away_win_probability;
        adjusted.home_win_probability = (adjusted.home_win_probability / total) * 100;
        adjusted.draw_probability = (adjusted.draw_probability / total) * 100;
        adjusted.away_win_probability = (adjusted.away_win_probability / total) * 100;

        adjusted.odds_analysis_applied = true;
        adjusted.smart_confidence = oddsAnalysis.smart_confidence;

        return adjusted;
    }
}

module.exports = new SmartOddsAnalyzer();
