/**
 * 🧠 TITANIUM AI - NEURAL META-REFINER V2 (Node.js)
 * -----------------------------------------------
 * Corrects model bias in real-time using Bayesian Smoothing.
 * It learns from 'prediction_history' to adjust future probabilities.
 */

const db = require('../core/database');
const logger = require('../core/logger');

class NeuralMetaRefiner {
    constructor() {
        this.biasCache = new Map();
        this.lastUpdate = 0;
    }

    async refreshBiasMatrix() {
        if (Date.now() - this.lastUpdate < 300000) return; // Refresh every 5 mins

        try {
            const query = `
                SELECT league, prediction_type, probability, result
                FROM prediction_history
                WHERE result IS NOT NULL
            `;
            const { rows } = await db.query(query);

            const stats = {};
            for (const r of rows) {
                const key = `${r.league}|${r.prediction_type}`;
                if (!stats[key]) stats[key] = { sumProb: 0, sumActual: 0, count: 0 };
                
                stats[key].sumProb += r.probability || 0;
                stats[key].sumActual += (r.result === 'won' || r.result === 'WON') ? 1 : 0;
                stats[key].count++;
            }

            this.biasCache.clear();
            for (const [key, data] of Object.entries(stats)) {
                if (data.count < 3) continue; // Minimum 3 matches for bias

                const avgProb = data.sumProb / data.count;
                const avgActual = data.sumActual / data.count;

                // Bayesian Correction Factor
                const alpha = 2; // Prior strength
                const correctedFactor = (data.sumActual + alpha) / (data.sumProb + alpha);
                
                this.biasCache.set(key, correctedFactor);
            }
            this.lastUpdate = Date.now();
            logger.info(`🧬 [META-REFINER] Matrix updated with ${this.biasCache.size} active bias keys.`);
        } catch (e) {
            logger.error(`❌ [META-REFINER] Refresh failed: ${e.message}`);
        }
    }

    /**
     * Refines probabilities based on historical bias.
     */
    async refine(match) {
        await this.refreshBiasMatrix();

        const refined = { ...match };
        const league = match.league || 'Unknown';

        // 1. Refine Home Win
        const hKey = `${league}|Home`;
        if (this.biasCache.has(hKey)) {
            const factor = this.biasCache.get(hKey);
            refined.home_win_probability = Math.min(99, Math.max(1, (match.home_win_probability || 0) * factor));
            refined.meta_correction_h = factor;
        }

        // 2. Refine Away Win
        const aKey = `${league}|Away`;
        if (this.biasCache.has(aKey)) {
            const factor = this.biasCache.get(aKey);
            refined.away_win_probability = Math.min(99, Math.max(1, (match.away_win_probability || 0) * factor));
            refined.meta_correction_a = factor;
        }

        return refined;
    }
}

module.exports = new NeuralMetaRefiner();
