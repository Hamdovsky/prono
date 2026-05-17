const Database = require('better-sqlite3');
const path = require('path');
const database = require('../../core/database');

// Internal memory caching (O(1) lookup) to avoid re-calcs for the same matchId
const processedMatches = new Set();
let archiveDb;

try {
    archiveDb = new Database(path.join(__dirname, '..', '..', 'data', 'historical_archive.sqlite'), { readonly: true });
    console.log("📚 [ARCHIVE] Historical Archive DB Connected");
} catch (e) {
    console.warn("⚠️ [ARCHIVE] Historical Archive DB not found, H2H injection disabled.");
}

/**
 * Injects Historical H2H statistics into the match JSON payload.
 * Runs only once per matchId.
 * @param {string} matchId The match ID
 */
async function injectHistoricalData(matchId) {
    if (processedMatches.has(matchId)) return false; // Already processed
    if (!archiveDb) return false;

    try {
        // 1. Fetch from tactical DB
        const match = await database.getMatchById(matchId);
        if (!match || !match.homeTeam || !match.awayTeam) return false;

        const home = match.homeTeam.name || match.homeTeam;
        const away = match.awayTeam.name || match.awayTeam;

        // 2. Query reverse archive for the last 10 Head-to-Head games
        const stmt = archiveDb.prepare(`
            SELECT scoreHome, scoreAway, homeTeam, awayTeam, startTimestamp 
            FROM archive_matches 
            WHERE (homeTeam LIKE ? AND awayTeam LIKE ?) OR (homeTeam LIKE ? AND awayTeam LIKE ?)
            ORDER BY startTimestamp DESC 
            LIMIT 10
        `);

        // Entity Matching using wildcards
        const hSearch = `%${home.substring(0, 5)}%`;
        const aSearch = `%${away.substring(0, 5)}%`;

        const rows = stmt.all(hSearch, aSearch, aSearch, hSearch);

        // 3. Pattern Analysis
        if (rows.length === 0) {
            match.historical_context = {
                message: "No H2H data found in archive",
                h2hPlayed: 0
            };
        } else {
            let totalGoals = 0;
            let over25Count = 0;
            let homeWins = 0;
            let awayWins = 0;
            let draws = 0;

            rows.forEach(r => {
                const isHomeInArchive = r.homeTeam.toLowerCase().includes(home.substring(0, 5).toLowerCase());
                const currentHomeGoals = isHomeInArchive ? r.scoreHome : r.scoreAway;
                const currentAwayGoals = isHomeInArchive ? r.scoreAway : r.scoreHome;

                const matchGoals = currentHomeGoals + currentAwayGoals;
                totalGoals += matchGoals;
                if (matchGoals > 2) over25Count++;

                if (currentHomeGoals > currentAwayGoals) homeWins++;
                else if (currentAwayGoals > currentHomeGoals) awayWins++;
                else draws++;
            });

            const count = rows.length;
            match.historical_context = {
                h2hPlayed: count,
                avgGoals: (totalGoals / count).toFixed(2),
                over25Pct: ((over25Count / count) * 100).toFixed(0) + '%',
                winRateHome: ((homeWins / count) * 100).toFixed(0) + '%',
                winRateAway: ((awayWins / count) * 100).toFixed(0) + '%',
                drawRate: ((draws / count) * 100).toFixed(0) + '%'
            };
        }

        // --- NEW: LAST 5 MATCHES FORM EXTRACTION ---
        const getTeamForm = (teamName) => {
            const formStmt = archiveDb.prepare(`
                SELECT scoreHome, scoreAway, homeTeam, awayTeam, startTimestamp
                FROM archive_matches
                WHERE homeTeam LIKE ? OR awayTeam LIKE ?
                ORDER BY startTimestamp DESC
                LIMIT 5
            `);
            const searchTerm = `%${teamName.substring(0, 5)}%`;
            return formStmt.all(searchTerm, searchTerm);
        };

        const homeFormRows = getTeamForm(home);
        const awayFormRows = getTeamForm(away);

        const calculateFormStats = (rows, teamName) => {
            if (rows.length === 0) return null;
            let timeWeightedGoalsFor = 0;
            let timeWeightedGoalsAgainst = 0;
            let momentumScore = 0; 

            let totalWeight = 0;
            let winPoints = 0;

            rows.forEach((r, index) => {
                const weight = 1.0 - (index * 0.2);
                totalWeight += weight;

                const isHome = r.homeTeam.toLowerCase().includes(teamName.substring(0, 5).toLowerCase());
                const goalsFor = isHome ? r.scoreHome : r.scoreAway;
                const goalsAgainst = isHome ? r.scoreAway : r.scoreHome;

                timeWeightedGoalsFor += goalsFor * weight;
                timeWeightedGoalsAgainst += goalsAgainst * weight;

                if (goalsFor > goalsAgainst) winPoints += (3 * weight); 
                else if (goalsFor === goalsAgainst) winPoints += (1 * weight); 
            });

            momentumScore = (winPoints / (3 * totalWeight)) * 100;
            return {
                tw_xG_scored: (timeWeightedGoalsFor / totalWeight).toFixed(2),
                tw_xG_conceded: (timeWeightedGoalsAgainst / totalWeight).toFixed(2),
                momentum: momentumScore.toFixed(0)
            };
        };

        match.form_context = {
            home: calculateFormStats(homeFormRows, home),
            away: calculateFormStats(awayFormRows, away)
        };

        // MARK: V51 REAL H2H INTELLIGENCE (Sofascore API)
        try {
            const { getSofaH2H } = require('./newsService');
            const sofaH2h = await getSofaH2H(matchId);
            if (sofaH2h) {
                match.h2h_data = sofaH2h;
                console.log(`📊 [ARCHIVE] Real Sofascore H2H injected for ${matchId}`);
            }
        } catch (sofaErr) {
            console.warn(`⚠️ [ARCHIVE] Failed to fetch Real H2H for ${matchId}: ${sofaErr.message}`);
        }

        // MARK: V52 LINE MOVEMENT INTELLIGENCE
        try {
            const { get24hMovement } = require('../../services/oddsMovementService');
            const movement = get24hMovement(matchId);
            if (movement) {
                match.odds_movement_24h = movement;
            }
        } catch (moveErr) {
            console.warn(`⚠️ [ARCHIVE] Odds Movement injection failed: ${moveErr.message}`);
        }

        // 4. Update the main tactical database directly (matches.fulldata)
        await database.updatePredictions(matchId, match);



        // Mark as processed
        processedMatches.add(matchId);
        console.log(`📚 [ARCHIVE] Historical Context & Line Movement injected for Match ${matchId} (${home} vs ${away})`);

        return true;
    } catch (e) {
        console.error(`❌ [ARCHIVE] Error injecting historical data for ${matchId}: ${e.message}`);
        return false;
    }
}

module.exports = {
    injectHistoricalData
};
