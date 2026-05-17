const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

// Configurations
const SQLITE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });
const SOFA_API = 'https://api.sofascore.com/api/v1';
const SOFA_HEADERS = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Cache-Control': 'no-cache'
};

async function run() {
    console.log("🚀 [V53-REHAB] Starting Historical Enrichment Pipeline...");
    
    // --- PHASE 1: SQLite Schema Expansion ---
    const db = new Database(SQLITE_PATH);
    console.log("   -> Expanding SQLite Schema...");
    try {
        db.prepare("ALTER TABLE archive_matches ADD COLUMN h2h_data TEXT").run();
        console.log("      + Added h2h_data column");
    } catch(e) {}
    try {
        db.prepare("ALTER TABLE archive_matches ADD COLUMN odds_movement_24h TEXT").run();
        console.log("      + Added odds_movement_24h column");
    } catch(e) {}

    // --- PHASE 2: Import Finished Matches from Postgres ---
    console.log("   -> Importing finished matches from Postgres...");
    const pgMatches = await pool.query("SELECT * FROM matches WHERE status = 'finished'");
    console.log(`      Found ${pgMatches.rows.length} finished matches in Postgres.`);
    
    let imported = 0;
    for (const row of pgMatches.rows) {
        const id = String(row.id);
        const existing = db.prepare("SELECT id FROM archive_matches WHERE sofascore_id = ?").get(id);
        if (!existing) {
            const data = row.fulldata || {};
            const scoreHome = row.scorehome ?? data.score?.home ?? 0;
            const scoreAway = row.scoreaway ?? data.score?.away ?? 0;
            const result = scoreHome > scoreAway ? 'H' : (scoreAway > scoreHome ? 'A' : 'D');
            
            db.prepare(`
                INSERT INTO archive_matches (sofascore_id, startTimestamp, tournament_name, homeTeam, awayTeam, scoreHome, scoreAway, result, archived_at, h2h_data, odds_movement_24h)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id, 
                data.startTimestamp || 0,
                row.league || 'Unknown',
                row.hometeam || data.homeTeam,
                row.awayteam || data.awayTeam,
                scoreHome,
                scoreAway,
                result,
                Date.now(),
                JSON.stringify(data.h2h_data || null),
                JSON.stringify(data.odds_movement_24h || null)
            );
            imported++;
        }
    }
    console.log(`      Imported ${imported} new finished matches into SQLite.`);

    // --- PHASE 3: Mass Enrichment from Sofascore ---
    console.log("   -> Batch Enriching H2H records (Target: matches with NULL h2h_data)...");
    const targets = db.prepare("SELECT sofascore_id FROM archive_matches WHERE h2h_data IS NULL OR h2h_data = 'null' LIMIT 500").all();
    console.log(`      Enriching ${targets.length} matches in this batch...`);

    let enriched = 0;
    for (const t of targets) {
        try {
            const res = await axios.get(`${SOFA_API}/event/${t.sofascore_id}/h2h`, { headers: SOFA_HEADERS, timeout: 5000 });
            if (res.data) {
                db.prepare("UPDATE archive_matches SET h2h_data = ? WHERE sofascore_id = ?")
                  .run(JSON.stringify(res.data), t.sofascore_id);
                enriched++;
            }
            // Rate limiting
            await new Promise(r => setTimeout(r, 300));
            if (enriched % 20 === 0) console.log(`      ... Processed ${enriched}/${targets.length}`);
        } catch (err) {
            // Silently skip matches without H2H API data
        }
    }
    console.log(`✅ [V53-REHAB] Enrichment phase complete. ${enriched} matches now have Real H2H metrics.`);

    db.close();
    pool.end();
}

run();
