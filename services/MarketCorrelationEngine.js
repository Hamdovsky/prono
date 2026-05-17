/**
 * MarketCorrelationEngine.js — [MASTER V20] 
 * ─────────────────────────────────────────────────────────────
 * Correlates multiple betting markets to detect "Elite Nodes" (90%+ Confidence).
 * Analyzes synergy between:
 *  - 1X2 (Match Result)
 *  - Over/Under 2.5 Goals
 *  - Both Teams to Score (BTTS)
 *  - Sharp Money (RLM, Steam)
 *  - Tactical Momentum (xG, Pressure)
 * ─────────────────────────────────────────────────────────────
 */

const { execSync } = require('child_process');
const path = require('path');
const logger = require('../core/logger');

const MASTER_PROFILES = [
    { data1: '1', score: '2 - 0', ou: 'Under 2.5', btts: 'No',  verdict: 'Victoire équipe 1' }, // Rule 10 (Priority)
    { data1: '',  score: '2 - 0', ou: 'Over 2.5',  btts: 'No',  verdict: 'Victoire équipe 1' }, // Rule 1
    { data1: 'X', score: '1 - 1', ou: 'Under 2.5', btts: 'Yes', verdict: 'BTTS' },             // Rule 2
    { data1: '2', score: '1 - 2', ou: 'Over 2.5',  btts: 'Yes', verdict: 'Victoire équipe 2' }, // Rule 3
    { data1: '1', score: '3 - 1', ou: 'Over 2.5',  btts: 'Yes', verdict: 'Over 2.5' },          // Rule 4
    { data1: '1', score: '2 - 1', ou: 'Over 2.5',  btts: 'Yes', verdict: 'BTTS' },              // Rule 5
    { data1: '2', score: '0 - 2', ou: 'Under 2.5', btts: 'No',  verdict: 'Victoire équipe 2' }, // Rule 6
    { data1: 'X', score: '0 - 0', ou: 'Under 2.5', btts: 'No',  verdict: 'Under 2.5' },          // Rule 7
    { data1: '1', score: '1 - 0', ou: 'Under 2.5', btts: 'No',  verdict: 'Victoire équipe 1' }, // Rule 8
    { data1: '2', score: '1 - 3', ou: 'Over 2.5',  btts: 'Yes', verdict: 'Over 2.5' },          // Rule 9
    { data1: 'X', score: '2 - 2', ou: 'Over 2.5',  btts: 'Yes', verdict: 'BTTS' },              // Rule 11
    { data1: '2', score: '0 - 1', ou: 'Under 2.5', btts: 'No',  verdict: 'Victoire équipe 2' }  // Rule 12
];

class MarketCorrelationEngine {
    constructor() {}

    /**
     * analyze(match)
     * @param {Object} m - The match object with enriched data.
     * @returns {Object} { master_confidence, master_verdict, correlations: [] }
     */
    async analyze(m) {
        if (!m || !m.enriched) return null;

        const e = m.enriched;
        const correlations = [];
        let totalScore = 0;
        let nodeCount = 0;

        // --- Execute Master V20 Plus (Python Engine) ---
        let v20Plus = null;
        try {
            const pythonService = require('../core/pythonService');
            // Prepare a minimal match object for the python engine
            const matchPayload = {
                homeTeam: m.homeTeam,
                awayTeam: m.awayTeam,
                home_xg: m.home_xg || e.home_xg || 1.2,
                away_xg: m.away_xg || e.away_xg || 1.0,
                odds_home: m.odds_home || m.market_odds,
                odds_away: m.odds_away,
                odds_draw: m.odds_draw,
                task: 'MEGA_CORRELATION'
            };
            
            // USE PERSISTENT WORKER POOL (Async)
            v20Plus = await pythonService.predict(matchPayload);
        } catch (err) {
            logger.warn(`⚠️ [V20-Plus] Python Worker Bridge failed: ${err.message}`);
        }

        // --- MASTER PROFILE CHECK ---
        const currentRes = (e.winner === (m.homeTeam || 'Home')) ? '1' : (e.winner === (m.awayTeam || 'Away') ? '2' : 'X');
        const currentScore = (m.expected_score || e.expected_score || '0 - 0').replace(/\s+/g, ' ').trim();

        // [V20 DATA 1] Logic: Prioritize precise result match
        let profileMatch = MASTER_PROFILES.find(p => p.data1 === currentRes && p.score === currentScore);
        if (!profileMatch) {
            profileMatch = MASTER_PROFILES.find(p => p.data1 === '' && p.score === currentScore);
        }

        // 1. [1X2 NODE] Result Correlation
        const pWin = Math.max(e.home_win_probability || 0, e.away_win_probability || 0) / 100;
        if (pWin >= 0.75) {
            correlations.push({ type: 'ELITE_RESULT', val: pWin >= 0.85 ? 'ULTRA' : 'STRONG', weight: 30 });
            totalScore += 30;
            nodeCount++;
        }

        // 2. [GOAL NODE] Goals vs xG Correlation
        const pOU25 = (e.ou_25_prob || 0) / 100;
        const totalXG = (parseFloat(m.home_xg) || 0) + (parseFloat(m.away_xg) || 0);
        if (pOU25 >= 0.70 && totalXG >= 2.6) {
            correlations.push({ type: 'GOAL_RUSH', val: 'OVER 2.5', weight: 25 });
            totalScore += 25;
            nodeCount++;
        } else if (pOU25 <= 0.30 && totalXG <= 1.9) {
            correlations.push({ type: 'TIGHT_DEFENSE', val: 'UNDER 2.5', weight: 25 });
            totalScore += 25;
            nodeCount++;
        }

        // 3. [BTTS NODE] Scoring Synergy
        const pBTTS = (e.btts_prob || 0) / 100;
        if (pBTTS >= 0.65 && (m.home_xg > 1.2 && m.away_xg > 1.1)) {
            correlations.push({ type: 'BTTS_SYNC', val: 'YES', weight: 20 });
            totalScore += 20;
            nodeCount++;
        }

        // 4. [V25 SHARP NODE] Institutional Money & Volume-Price Synergy
        if (m.market_signals && m.market_signals.length > 0) {
            const hasSharp = m.market_signals.some(s => s.type === 'STEAM' || s.type === 'RLM');
            const hasVolume = (m.market_volume || 0) > 10000; // Simplified volume threshold
            
            if (hasSharp && hasVolume) {
                correlations.push({ type: 'V25_SMART_MONEY', val: 'CONFIRMED', weight: 40 });
                totalScore += 40;
                nodeCount++;
            } else if (hasSharp && !hasVolume) {
                correlations.push({ type: 'MARKET_TRAP', val: 'LOW LIQUIDITY', weight: -10 });
                totalScore -= 10;
            } else if (hasSharp) {
                correlations.push({ type: 'SHARP_MONEY', val: 'DETECTED', weight: 25 });
                totalScore += 25;
                nodeCount++;
            }
        }

        // 5. [V26 MARKET SENTINEL] Institutional Manipulation & Ghost Steam Detection
        const oddsH = parseFloat(m.odds_home || 0);
        const oddsHOpen = parseFloat(m.odds_home_open || oddsH);
        const dropH = oddsHOpen > 0 ? (oddsHOpen - oddsH) / oddsHOpen : 0;
        const momTrend = m.enriched?.v26_momentum_trend || 0;
        const isConfirmed = !!m.lineups_confirmed;
        
        if (dropH > 0.15 && momTrend < -10) {
            correlations.push({ type: 'V26_SENTINEL', val: '⚠️ GHOST_STEAM (TRAP)', weight: -35 });
            totalScore -= 35;
        } else if (dropH > 0.12 && momTrend > 8) {
            correlations.push({ type: 'V26_SENTINEL', val: '✅ VERIFIED_STEAM', weight: 25 });
            totalScore += 25;
            nodeCount++;
        }

        if (!isConfirmed && m.status === 'pre') {
            totalScore *= 0.9; // Penalty for unconfirmed squads
        }

        // --- Build Final Analytics Object ---
        const v20 = v20Plus || {};
        const masterConfidence = v20Plus ? v20Plus.master_confidence : Math.min(99, Math.round((totalScore / 115) * 100 + (nodeCount * 5)));
        const verdict = v20Plus ? v20Plus.master_verdict : (profileMatch ? profileMatch.verdict.toUpperCase() : "NEUTRAL");

        if (v20Plus && v20Plus.is_pattern) {
            correlations.push({ type: 'ELITE_MEGA', val: '⚡ GOLDEN', weight: 50 });
        }

        // --- 4. Market Sensitivity & Staleness Check (V21) ---
        const now = Date.now();
        const oddsTs = m.last_odds_update || m.last_updated || now;
        const latencySecs = Math.round((now - oddsTs) / 1000);
        const isStale = latencySecs > 60; 

        return {
            master_confidence: isStale ? Math.round(masterConfidence * 0.85) : masterConfidence,
            master_verdict: verdict,
            correlations: correlations.slice(0, 5),
            node_count: nodeCount,
            is_pattern: v20Plus ? v20Plus.is_pattern : !!profileMatch,
            is_stale: isStale,
            market_latency: latencySecs,
            // [V20 PLUS] Enhanced Data
            v20_plus: v20Plus, 
            pattern_score: v20Plus ? v20Plus.monte_carlo_mode_score : (profileMatch ? profileMatch.score : null),
            pattern_ou: profileMatch ? profileMatch.ou : null,
            pattern_btts: profileMatch ? profileMatch.btts : null
        };
    }
}

module.exports = new MarketCorrelationEngine();
