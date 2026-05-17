const { SofaAPI } = require('./apiClient');
const persistence = require('./Persistence');
const { getCache, setCache } = require('../../core/redisClient');

const DELAY_MS = 1000; // Increased delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch detailed seasonal statistics for a specific player.
 */
async function fetchPlayerSeasonStats(playerId, uniqueTournamentId, seasonId) {
    if (!playerId || !uniqueTournamentId || !seasonId) return null;
    
    const cacheKey = `player_stats_${playerId}_${uniqueTournamentId}_${seasonId}`;
    try {
        const cached = await getCache(cacheKey);
        if (cached) return cached;

        const data = await SofaAPI.getPlayerStats(playerId, uniqueTournamentId, seasonId);
        const stats = data?.statistics || null;
        
        if (stats) {
            await setCache(cacheKey, stats, 86400); // 24h cache
        }
        return stats;
    } catch (e) {
        console.error(`[PropsScraper] Error fetching stats for player ${playerId}: ${e.message}`);
    }
    return null;
}

/**
 * Process a lineup, extracting top players and their seasonal statistics.
 * @param {Array} players - Array of player objects from Sofascore lineup
 */
async function processTeamLineupForProps(players, teamName, uniqueTournamentId, seasonId) {
    if (!players || !Array.isArray(players)) return;

    // Filter to just the starting XI and prioritize non-goalkeepers
    const starters = players
        .filter(p => !p.substitute && p.player && p.player.id && p.position !== 'G')
        .slice(0, 3); // 🎯 Limit to TOP 3 players to save API quota and prevent 403
    
    let processedCount = 0;

    for (const p of starters) {
        const stat = await fetchPlayerSeasonStats(p.player.id, uniqueTournamentId, seasonId);
        if (stat) {
            const matchesPlayed = stat.appearances || stat.matchesStarted || 1;
            
            const shotsOnTargetAvg = stat.shotsOnTarget ? (stat.shotsOnTarget / matchesPlayed).toFixed(2) : 0;
            const ratingAvg = stat.rating ? parseFloat(stat.rating).toFixed(2) : 0;

            const playerEntity = {
                player_id: p.player.id.toString(),
                name: p.player.name,
                team_name: teamName,
                position: p.position || 'Unknown',
                goals: stat.goals || 0,
                shots_on_target_avg: parseFloat(shotsOnTargetAvg),
                yellow_cards: stat.yellowCards || 0,
                red_cards: stat.red_cards || 0,
                rating_avg: parseFloat(ratingAvg)
            };

            // Save to DB
            persistence.insertPlayerStat(playerEntity);
            processedCount++;
        }

        // Wait between requests if not from cache
        await sleep(DELAY_MS); 
    }
    
    if (processedCount > 0) {
        console.log(`👟 [PropsScraper] Fetched stats for ${processedCount} players from ${teamName || 'Team'}`);
    }
}

module.exports = {
    processTeamLineupForProps
};
