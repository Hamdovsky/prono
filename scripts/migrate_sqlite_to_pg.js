const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const sqliteDbPath = path.resolve(__dirname, '../data/tactical.db');
const sqlite = new Database(sqliteDbPath, { readonly: true });

const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function migrate() {
    console.log('🚀 Starting Migration from SQLite to PostgreSQL...');
    
    try {
        const matches = sqlite.prepare('SELECT * FROM matches ORDER BY timestamp ASC').all();
        console.log(`📦 Found ${matches.length} matches in SQLite.`);

        let successCount = 0;
        let errorCount = 0;

        for (const m of matches) {
            try {
                // 1. Standardize values
                const fullData = typeof m.fullData === 'string' ? m.fullData : JSON.stringify(m.fullData || {});
                const timestamp = m.timestamp || new Date().toISOString();
                
                // 2. Insert/Update into main matches table (The most important part for the AI)
                await pgPool.query(`
                    INSERT INTO matches (
                        "id", "homeTeam", "awayTeam", "league", "scoreHome", "scoreAway", 
                        "status", "prediction", "confidence", "fullData", "timestamp", 
                        "home_win_probability", "draw_probability", "away_win_probability", 
                        "expected_score", "home_xg", "away_xg", "source"
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                    ON CONFLICT ("id") DO UPDATE SET
                        "scoreHome" = EXCLUDED."scoreHome",
                        "scoreAway" = EXCLUDED."scoreAway",
                        "status" = EXCLUDED."status",
                        "fullData" = EXCLUDED."fullData",
                        "timestamp" = EXCLUDED."timestamp",
                        "home_win_probability" = EXCLUDED."home_win_probability",
                        "draw_probability" = EXCLUDED."draw_probability",
                        "away_win_probability" = EXCLUDED."away_win_probability",
                        "expected_score" = EXCLUDED."expected_score",
                        "home_xg" = EXCLUDED."home_xg",
                        "away_xg" = EXCLUDED."away_xg"
                `, [
                    m.id, m.homeTeam, m.awayTeam, m.league, m.scoreHome || 0, m.scoreAway || 0,
                    m.status || 'finished', m.prediction, m.confidence, fullData, timestamp,
                    m.home_win_probability || 0, m.draw_probability || 0, m.away_win_probability || 0,
                    m.expected_score, m.home_xg || 0, m.away_xg || 0, m.source || 'SofaScore'
                ]);

                successCount++;
                } catch (e) {
                    errorCount++;
                    console.error(`❌ Error migrating match ${m.id}: ${e.message}`);
                }
        }
        
        console.log(`✅ Migration Completed!`);
        console.log(`- Matches processed: ${matches.length}`);
        console.log(`- Successfully migrated: ${successCount}`);
        console.log(`- Errors: ${errorCount}`);
    } catch (e) {
        console.error('❌ Critical Migration Error:', e.message);
    } finally {
        await pgPool.end();
        process.exit(0);
    }
}

migrate();
