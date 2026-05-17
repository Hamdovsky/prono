const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const database = require('../core/database');
const logger = require('../core/logger');

class LineupService {
    constructor() {
        this.IMPACT_THRESHOLDS = {
            TOP_SCORER: 0.25, // -0.25 xG if missing
            KEY_PLAYMAKER: 0.15, // -0.15 xG if missing
            DEFENSIVE_PILLAR: 0.10, // Higher variance if missing
            MASTER_GOALKEEPER: 0.12
        };
    }

    /**
     * Identifies and saves the 5 most important players for a team
     */
    async syncKeyPlayers(teamId, tournamentId, seasonId) {
        try {
            const res = await SofaAPI.getTeamPlayers(teamId);
            if (!res || !res.players) return;

            const players = res.players.map(p => p.player);
            
            // Enrich with stats to find "Importance"
            const enriched = [];
            for (const p of players.slice(0, 15)) { // Check top 15 by default relevance
                const stats = await SofaAPI.getPlayerStats(p.id, tournamentId, seasonId);
                if (stats && stats.statistics) {
                    const s = stats.statistics;
                    const score = (s.rating || 6.5) + (s.goals || 0) * 0.5 + (s.goalAssist || 0) * 0.3;
                    enriched.push({
                        ...p,
                        score,
                        rating: s.rating || 6.5,
                        goals: s.goals || 0,
                        assists: s.goalAssist || 0
                    });
                }
            }

            // Sort by Importance score and take Top 5
            const top5 = enriched.sort((a, b) => b.score - a.score).slice(0, 5);

            for (const p of top5) {
                database.db.prepare(`
                    INSERT INTO team_key_players (team_id, player_id, name, role, rating, goals, assists)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(team_id, player_id) DO UPDATE SET 
                        rating = excluded.rating, 
                        goals = excluded.goals, 
                        assists = excluded.assists,
                        last_updated = CURRENT_TIMESTAMP
                `).run(teamId, p.id, p.name, p.position, p.rating, p.goals, p.assists);
            }

            logger.info(`✅ [LINEUP] Synced ${top5.length} key players for Team ID ${teamId}`);
        } catch (err) {
            logger.error(`❌ [LINEUP] Sync failed for Team ${teamId}: ${err.message}`);
        }
    }

    /**
     * Checks a match lineup against known key players and calculates the deficit
     */
    async calculateLineupDeficit(matchId, homeTeamId, awayTeamId) {
        try {
            // V6 Optimization: Check DB first for mocked or recently fetched lineups
            let hLine, aLine;
            const existing = database.db.prepare(`SELECT * FROM match_lineups WHERE match_id = ?`).get(matchId);
            
            if (existing && existing.home_lineup) {
                hLine = JSON.parse(existing.home_lineup);
                aLine = JSON.parse(existing.away_lineup);
            } else {
                const lineups = await SofaAPI.getLineups(matchId);
                if (!lineups || !lineups.home || !lineups.away) return null;

                hLine = lineups.home.players.map(p => p.player.id);
                aLine = lineups.away.players.map(p => p.player.id);
                
                database.db.prepare(`
                    INSERT INTO match_lineups (match_id, home_lineup, away_lineup)
                    VALUES (?, ?, ?)
                    ON CONFLICT(match_id) DO UPDATE SET home_lineup = excluded.home_lineup, away_lineup = excluded.away_lineup
                `).run(matchId, JSON.stringify(hLine), JSON.stringify(aLine));
            }

            // Analyze Deficit
            const homeDeficit = await this._getTeamDeficit(homeTeamId, hLine);
            const awayDeficit = await this._getTeamDeficit(awayTeamId, aLine);

            return {
                matchId,
                home: homeDeficit,
                away: awayDeficit,
                isFetched: true
            };
        } catch (err) {
            return { isFetched: false, error: err.message };
        }
    }

    async _getTeamDeficit(teamId, activePlayerIds) {
        const keys = database.db.prepare(`SELECT * FROM team_key_players WHERE team_id = ?`).all(teamId);
        if (keys.length === 0) return { deficit: 0, missingKeys: [] };

        let xgPenalty = 0;
        let confidencePenalty = 0;
        const missing = [];

        keys.forEach(k => {
            if (!activePlayerIds.includes(k.player_id)) {
                missing.push(k.name);
                // Weight penalty by goals/rating
                const p = (k.goals > 5 ? 0.20 : 0.10) + (k.rating > 7.3 ? 0.05 : 0);
                xgPenalty += p;
                confidencePenalty += 5;
            }
        });

        return {
            xgPenalty: parseFloat(xgPenalty.toFixed(2)),
            confidencePenalty,
            missingKeys: missing
        };
    }
}

module.exports = new LineupService();
