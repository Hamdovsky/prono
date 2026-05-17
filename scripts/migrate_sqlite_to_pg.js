const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');

const sqliteDbPath = path.resolve(__dirname, '../data/tactical.db');
const sqlite = new Database(sqliteDbPath, { readonly: true });

const pgPool = new Pool({
    user: process.env.PG_USER || 'postgres',
    host: process.env.PG_HOST || 'localhost',
    database: process.env.PG_DB || 'titanium_quant',
    password: process.env.PG_PASSWORD || 'postgres_password',
    port: process.env.PG_PORT || 5432,
});

async function migrate() {
    console.log('🚀 Starting Migration from SQLite to PostgreSQL Append-Only Architecture...');
    
    try {
        const matches = sqlite.prepare('SELECT * FROM matches ORDER BY timestamp ASC').all();
        console.log(`📦 Found ${matches.length} matches in SQLite.`);

        for (const m of matches) {
            // Reconstruct historical timestamp strictly
            let matchTime = new Date(m.timestamp);
            if (m.startTimestamp) matchTime = new Date(m.startTimestamp * 1000);
            
            // Historical fallback: assuming it was recorded slightly before match started
            const recordedAt = matchTime.toISOString();

            // 1. Insert Event Log (Append-only)
            const payload = JSON.parse(m.fullData || '{}');
            await pgPool.query(
                'INSERT INTO event_log (event_type, aggregate_id, payload, created_at) VALUES ($1, $2, $3, $4)',
                ['MATCH_MIGRATED', m.id, payload, recordedAt]
            );

            // 2. Insert Match History (Point-in-time)
            await pgPool.query(`
                INSERT INTO matches_history 
                (match_id, league, home_team, away_team, status, home_score, away_score, match_timestamp, valid_from, recorded_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                m.id, m.league, m.homeTeam, m.awayTeam, m.status || 'finished', 
                m.scoreHome || 0, m.scoreAway || 0, 
                matchTime.toISOString(), recordedAt, recordedAt
            ]);

            // 3. Insert Odds Tick (Hypertable)
            if (m.odds_home && m.odds_draw && m.odds_away) {
                await pgPool.query(`
                    INSERT INTO odds_ticks 
                    (match_id, bookmaker_id, market_type, home_odds, draw_odds, away_odds, recorded_at)
                    VALUES ($1, 'Pinnacle', '1X2', $2, $3, $4, $5)
                `, [m.id, m.odds_home, m.odds_draw, m.odds_away, recordedAt]);
            }
        }
        
        console.log('✅ SQLite Migration Completed Successfully without destructive updates.');
    } catch (e) {
        console.error('❌ Migration Error:', e.message);
    } finally {
        await pgPool.end();
        process.exit(0);
    }
}

migrate();
