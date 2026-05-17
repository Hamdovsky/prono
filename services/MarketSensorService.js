const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');
const oddsMovementService = require('./oddsMovementService');

class MarketSensorService {
    async getMarketSignals(days = 1) {
        const db = database.db;
        const now = Math.floor(Date.now() / 1000);
        const lookAhead = now + (days * 86400);

        const matches = db.prepare(`
            SELECT * FROM matches
            WHERE startTimestamp BETWEEN ? AND ?
            AND (status = 'scheduled' OR status IS NULL OR status = 'notstarted')
            ORDER BY startTimestamp ASC
        `).all(now, lookAhead);

        const signals = [];

        for (const m of matches) {
            try {
                const enriched = await enrichedPredictions.fastEnrichMatch(m);
                const movement = oddsMovementService.get24hMovement(m.id);
                
                // Detect Steam (Significant Drop)
                const steamThreshold = -0.15; // 15% drop or more
                const isSteamH = movement && movement.h_pct <= steamThreshold * 100;
                const isSteamA = movement && movement.a_pct <= steamThreshold * 100;
                
                // Detect Trap
                const expectedWinner = (m.home_win_probability > m.away_win_probability) ? 'HOME' : 'AWAY';
                const trap = oddsMovementService.detectBookmakerTrap(m.id, Math.max(m.home_win_probability, m.away_win_probability), expectedWinner, {
                    home: m.odds_home,
                    away: m.odds_away
                });

                if (isSteamH || isSteamA || trap.isTrap) {
                    signals.push({
                        matchId: m.id,
                        homeTeam: m.homeTeam,
                        awayTeam: m.awayTeam,
                        league: m.league,
                        startTime: m.startTimestamp,
                        type: trap.isTrap ? 'TRAP' : 'STEAM',
                        severity: trap.isTrap ? trap.severity : Math.abs(isSteamH ? movement.h_pct : movement.a_pct),
                        description: trap.isTrap ? trap.msg : `Significant money flow on ${isSteamH ? m.homeTeam : m.awayTeam}`,
                        odds: { h: m.odds_home, d: m.odds_draw, a: m.odds_away },
                        movement: movement
                    });
                }
            } catch (e) {
                // Skip errors for individual matches
            }
        }

        return signals.sort((a, b) => b.severity - a.severity);
    }
}

module.exports = new MarketSensorService();
