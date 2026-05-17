const fs = require('fs');
const path = require('path');
const dbPath = path.resolve(__dirname, '../data/tactical.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
const db = require('better-sqlite3')(dbPath);
const logger = require('../core/logger');

class QuantRiskService {
    /**
     * Valide si un pari respecte les critères institutionnels.
     */
    static validateBet(match, evThreshold = 0.03, maxStakePct = 0.05) {
        if (!match.ev_best || match.ev_best === 'NONE') {
            return { valid: false, reason: 'EV- negative' };
        }

        const ev = match[`ev_${match.ev_best.toLowerCase()}`] / 100;
        if (ev < evThreshold) {
            return { valid: false, reason: `EV (${(ev*100).toFixed(1)}%) below threshold (${(evThreshold*100).toFixed(1)}%)` };
        }

        const stake = (match.kelly_stake || 0) / 100;
        if (stake > maxStakePct) {
            // Cap the stake to institutional limits
            match.kelly_stake = maxStakePct * 100;
        }

        if (match.insufficient_data === 1) {
            return { valid: false, reason: 'Insufficient data for institutional trade' };
        }

        return { valid: true, ev, finalStake: match.kelly_stake };
    }

    /**
     * Enregistre un snapshot des cotes pour le tracking historique et CLV.
     */
    static recordMarketSnapshot(matchId, odds, type = 'LIVE') {
        try {
            const stmt = db.prepare(`
                INSERT INTO odds_history (match_id, odds_home, odds_draw, odds_away, type)
                VALUES (?, ?, ?, ?, ?)
            `);
            stmt.run(matchId, odds.home, odds.draw, odds.away, type);
        } catch (e) {
            logger.error(`[QuantRisk] Failed to record snapshot: ${e.message}`);
        }
    }

    /**
     * Calcule le CLV (Closing Line Value) une fois le match terminé.
     */
    static calculateCLV(takenOdds, closingOdds) {
        if (!takenOdds || !closingOdds) return 0;
        // Formula: (Closing Odds / Taken Odds) - 1
        return (closingOdds / takenOdds) - 1;
    }

    /**
     * Ferme un trade et enregistre la performance réelle.
     */
    static logTradePerformance(matchId, takenOdds, stake, result) {
        try {
            // 1. Get closing odds from history
            const closing = db.prepare(`
                SELECT odds_home, odds_draw, odds_away FROM odds_history 
                WHERE match_id = ? AND type = 'CLOSING' 
                ORDER BY timestamp DESC LIMIT 1
            `).get(matchId);

            const closingOdds = closing ? closing.odds_home : takenOdds; // Fallback to taken if closing missing
            const clv = this.calculateCLV(takenOdds, closingOdds);
            
            let pnl = -stake;
            if (result === 'WIN') {
                pnl = stake * (takenOdds - 1);
            } else if (result === 'PUSH') {
                pnl = 0;
            }

            const stmt = db.prepare(`
                INSERT INTO quant_performance (match_id, taken_odds, closing_odds, clv, pnl, stake)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            stmt.run(matchId, takenOdds, closingOdds, clv, pnl, stake);
            
            return { clv, pnl };
        } catch (e) {
            logger.error(`[QuantRisk] Failed to log performance: ${e.message}`);
            return null;
        }
    }
}

module.exports = QuantRiskService;
