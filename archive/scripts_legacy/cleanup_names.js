/**
 * V43 DATABASE CLEANUP SCRIPT
 * Re-normalizes all team and league names in the 'matches' table.
 */
const database = require('../core/database');
const AliasResolver = require('../SofascoreScraping/src/AliasResolver');

async function runCleanup() {
    console.log('🛡️ [CLEANUP] Starting global name normalization...');
    
    // Ensure DB is connected
    const db = database.db;
    const resolver = new AliasResolver(db);
    resolver.seedMasterNames();

    const matches = db.prepare('SELECT id, homeTeam, awayTeam, league, category_name, home_team_id, away_team_id FROM matches').all();
    console.log(`📊 Processing ${matches.length} matches...`);

    const updateStmt = db.prepare(`
        UPDATE matches 
        SET homeTeam = ?, awayTeam = ?, league = ?
        WHERE id = ?
    `);

    let updatedCount = 0;
    
    db.transaction(() => {
        for (const m of matches) {
            const newHome = resolver.resolve(m.home_team_id, m.homeTeam);
            const newAway = resolver.resolve(m.away_team_id, m.awayTeam);
            const newLeague = resolver.resolveTournament(m.league, m.category_name);

            if (newHome !== m.homeTeam || newAway !== m.awayTeam || newLeague !== m.league) {
                updateStmt.run(newHome, newAway, newLeague, m.id);
                updatedCount++;
            }
        }
    })();

    console.log(`\n✅ [CLEANUP] Finished. Updated ${updatedCount} matches with clean names.`);
    process.exit(0);
}

runCleanup().catch(err => {
    console.error('❌ [CLEANUP] Fatal Error:', err);
    process.exit(1);
});
