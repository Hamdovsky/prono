const database = require('../core/database');

/**
 * Player Props Service (V34 Elite Expansion)
 * Analyzes individual player statistics and cross-references them against
 * opposition defensive weaknesses to uncover value player bets.
 */

class PlayerPropsService {
    
    /**
     * Get all player stats for a specific team.
     * @param {string} teamName 
     */
    getPlayersForTeam(teamName) {
        try {
            return database.prepare(
                'SELECT * FROM player_stats WHERE team_name = ? ORDER BY rating_avg DESC LIMIT 15'
            ).all(teamName);
        } catch (e) {
            console.error(`[PlayerPropsService] Error fetching players for ${teamName}: ${e.message}`);
            return [];
        }
    }

    /**
     * Build predictive player props for a given match using Python Micro-Simulations.
     * @param {Object} m - The match object
     */
    async generatePlayerProps(m) {
        if (!m.homeTeam || !m.awayTeam) return [];

        try {
            const pythonService = require('../core/pythonService');
            
            // 1. Get available players from local DB
            const homePlayers = this.getPlayersForTeam(m.homeTeam);
            const awayPlayers = this.getPlayersForTeam(m.awayTeam);

            // 2. Map absences from news_data
            const absences = { opponent: [], team: [] };
            const news = m.news_data ? (typeof m.news_data === 'string' ? JSON.parse(m.news_data) : m.news_data) : {};
            const injuries = news.injuries || {};
            
            // Map injuries to positional codes (G, D, M, F)
            const mapPos = (players) => players.map(p => {
                const name = typeof p === 'string' ? p : (p.name || '');
                // Find player in DB to get position
                const dbP = database.prepare('SELECT position FROM player_stats WHERE name = ?').get(name);
                return (dbP?.position || 'U').charAt(0).toUpperCase();
            });

            const homeAbsences = mapPos(injuries.home || []);
            const awayAbsences = mapPos(injuries.away || []);

            // 3. Sequential Python Calls for each side
            const homeTask = {
                task: 'PLAYER_PROPS',
                players: homePlayers,
                absences: { opponent: awayAbsences },
                opponent_goals_conceded_avg: m.away_xg || 1.3,
                opponent_shots_conceded_avg: 4.5
            };

            const awayTask = {
                task: 'PLAYER_PROPS',
                players: awayPlayers,
                absences: { opponent: homeAbsences },
                opponent_goals_conceded_avg: m.home_xg || 1.3,
                opponent_shots_conceded_avg: 4.5
            };

            const [homeRes, awayRes] = await Promise.all([
                pythonService.predict(homeTask),
                pythonService.predict(awayTask)
            ]);

            const results = [];
            if (homeRes?.success) results.push(...homeRes.props.map(p => ({ ...p, side: 'Home', team: m.homeTeam })));
            if (awayRes?.success) results.push(...awayRes.props.map(p => ({ ...p, side: 'Away', team: m.awayTeam })));

            // 4. Format for UI
            return results.slice(0, 5).map(p => ({
                player: p.player_name,
                team: p.team,
                market: p.market_ar || p.prop_type,
                confidence: Math.round(p.probability),
                reason: p.reason_ar || "أداء مستقر متوقع",
                icon: p.prop_type.includes('Shot') ? '🎯' : (p.prop_type.includes('Goal') ? '⚽' : '🟨')
            }));

        } catch (e) {
            console.error(`[PlayerPropsV80] Error: ${e.message}`);
            return [];
        }
    }

    _evaluatePlayer(player, attackBoost, teamName, side, props) {
        // Skip invalid data
        if (!player || player.rating_avg < 6.0) return;

        const pos = (player.position || 'U').toUpperCase();
        const sotAvg = player.shots_on_target_avg || 0;
        const goals = player.goals || 0;
        
        // 1. Shots on Target Prop (Over 0.5)
        // Adjust expected SOT based on opposition defense weakness
        const expectedSOT = sotAvg * attackBoost;
        
        if (expectedSOT > 0.8 && (pos === 'F' || pos === 'M')) {
            let conf = Math.min(95, expectedSOT * 60); // 1.5 expected = 90% confidence
            
            // Further boost if player rating is extremely high
            if (player.rating_avg > 7.2) conf += 5;

            if (conf >= 65) {
                props.push({
                    type: 'SHOTS_ON_TARGET',
                    player: player.name,
                    team: teamName,
                    market: 'Plus de 0.5 Tirs Cadrés',
                    confidence: Math.round(conf),
                    icon: '🎯',
                    reason: `Moyenne de ${sotAvg.toFixed(2)} tirs cadrés/match. Affronte une défense affaiblie (Boost x${attackBoost.toFixed(2)}).`
                });
            }
        }

        // 2. Goalscorer Prop (Anytime Goalscorer)
        // Need to be a consistent scorer
        if (goals >= 4 && pos === 'F') {
            // Rough heuristic: goals scored over season -> chance per match
            // We'll use rating + goals volume to estimate confidence
            let conf = 40 + (goals * 3) * attackBoost;
            if (player.rating_avg > 7.4) conf += 10;
            if (player.rating_avg < 6.8) conf -= 10;

            conf = Math.min(85, conf); // Max 85% for an individual goalscorer (it's hard to predict)

            if (conf >= 60) {
                props.push({
                    type: 'GOALSCORER',
                    player: player.name,
                    team: teamName,
                    market: 'Buteur Pendant le Match',
                    confidence: Math.round(conf),
                    icon: '⚽',
                    reason: `Buteur prolifique (${goals} buts). Forme excellente (${player.rating_avg}). Cible de choix.`
                });
            }
        }

        // 3. Yellow Card Prop (To be booked)
        // High card volume players against tough attacking opposition
        const cards = player.yellow_cards || 0;
        if (cards >= 5 && (pos === 'D' || pos === 'M')) {
            // If opposition is attacking heavily (attackBoost ironically means defense is weak, but let's just use raw cards)
            let conf = 45 + (cards * 2.5);
            conf = Math.min(80, conf);
            
            if (conf >= 65) {
                props.push({
                    type: 'CARDS',
                    player: player.name,
                    team: teamName,
                    market: 'Recevra un carton',
                    confidence: Math.round(conf),
                    icon: '🟨',
                    reason: `Profil agressif (${cards} avertissements). Risque élevé dans les duels défensifs.`
                });
            }
        }
    }
}

module.exports = new PlayerPropsService();
