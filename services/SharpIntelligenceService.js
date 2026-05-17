/**
 * SharpIntelligenceService.js — Sharp Money & Market Logic
 * ───────────────────────────────────────────────────────
 * Detects professional betting signals:
 * 1. RLM (Reverse Line Movement): Price moves AGAINST high-probability outcome.
 * 2. Steam: Rapid, high-volume price drops.
 * 3. Market Divergence: Disagreement between bookmakers or models.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

class SharpIntelligenceService {
    constructor() {
        this.RLM_THRESHOLD = 0.15; // 0.15 odds shift against probability
        this.STEAM_THRESHOLD = 0.12;
    }

    /**
     * Detects RLM, Steam, and Market Energy.
     * @param {Object} match - Match object
     * @param {Object} probs - { p_h, p_d, p_a }
     */
    analyzeSharpSignals(match, probs) {
        if (!match || !probs) return { sharp_score: 0, signals: [] };

        const signals = [];
        let score = 0;

        const odds = {
            h: parseFloat(match.odds_home),
            a: parseFloat(match.odds_away),
            d: parseFloat(match.odds_draw),
            h_open: parseFloat(match.odds_home_open),
            a_open: parseFloat(match.odds_away_open),
            d_open: parseFloat(match.odds_draw_open)
        };

        const velocity = match.odds_speed || { home: 0, away: 0 };

        // 1. Detect RLM (Reverse Line Movement)
        const checkRLM = (prob, cur, open, side, sideAr) => {
            if (!cur || !open) return;
            const shift = cur - open;
            if (prob > 0.60 && shift >= this.RLM_THRESHOLD) {
                signals.push({ 
                    type: 'RLM', 
                    side, 
                    msg: `تحرك معاكس (RLM): أموال ذكية على ${sideAr} رغم قوة الخصم`,
                    severity: 'HIGH'
                });
                score += 40;
            }
        };

        checkRLM(probs.p_h, odds.h, odds.h_open, 'AWAY', 'الضيف');
        checkRLM(probs.p_a, odds.a, odds.a_open, 'HOME', 'المضيف');

        // 2. Detect Steam Moves (Magnitude + Velocity) [V85]
        const checkSteam = (cur, open, vel, side, sideAr) => {
            if (!cur || !open) return;
            const drop = open - cur;
            const isFast = Math.abs(vel) > 0.15;
            
            if (drop >= this.STEAM_THRESHOLD || (drop > 0.05 && isFast)) {
                const type = isFast ? 'STEAM_FAST' : 'STEAM';
                const msg = isFast 
                    ? `حركة بخارية صاعقة (Steam): سيولة ضخمة وفورية على ${sideAr} 🔥`
                    : `تدفق مالي قوي (Steam) على ${sideAr}`;
                
                signals.push({ type, side, msg, severity: isFast ? 'CRITICAL' : 'HIGH' });
                score += isFast ? 45 : 25;
            }
        };

        checkSteam(odds.h, odds.h_open, velocity.home, 'HOME', 'المضيف');
        checkSteam(odds.a, odds.a_open, velocity.away, 'AWAY', 'الضيف');

        // 3. Advanced Market Energy Score (V90) 
        // Integrates pseudo-EMA logic & cross-volatility dampening to avoid whipsaws
        const calculateEnergy = (vel, cur, open) => {
            const shift = Math.abs(cur - open);
            const speed_factor = Math.abs(vel * 100);
            const shift_factor = shift * 50;
            let rawEnergy = speed_factor + shift_factor;
            
            // Volatility damping: if the odds are extremely low (< 1.2), shifts are mathematically exaggerated
            if (cur < 1.2 || cur > 8) {
                rawEnergy *= 0.6; 
            }
            return rawEnergy;
        };

        const hEnergy = calculateEnergy(velocity.home, odds.h, odds.h_open);
        const aEnergy = calculateEnergy(velocity.away, odds.a, odds.a_open);
        const maxEnergy = Math.max(hEnergy, aEnergy);

        if (maxEnergy > 75) {
            signals.push({ 
                type: 'HIGH_ENERGY', 
                msg: `طاقة سوق مرتفعة: سيولة قوية ومؤكدة (Market Power: ${Math.round(maxEnergy)})`,
                severity: 'MEDIUM'
            });
            score += 15;
        }

        // 4. Value Overlay & Cross-Book Divergence Proxy
        const implied_h = odds.h ? 0.95 / odds.h : 0;
        if (probs.p_h - implied_h > 0.15) {
            signals.push({ type: 'VALUE', side: 'HOME', msg: 'قيمة مضافة (Value): نموذجنا يتوقع أداء أقوى من تقدير السوق' });
            score += 15;
        }

        return {
            sharp_score: Math.min(100, score),
            signals: signals,
            market_energy: Math.round(maxEnergy)
        };
    }
}

module.exports = new SharpIntelligenceService();
