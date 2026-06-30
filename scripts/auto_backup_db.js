#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function log(msg) { console.log(`[BACKUP ${new Date().toISOString()}] ${msg}`); }

async function backupToPostgres() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        log('⚠️ DATABASE_URL not set, skipping PG backup');
        return { success: false, reason: 'no DATABASE_URL' };
    }

    try {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: dbUrl, max: 5, ssl: { rejectUnauthorized: false } });

        // Check if SQLite exists
        const dbPath = path.join(__dirname, '..', 'data', 'tactical.db');
        if (!fs.existsSync(dbPath)) {
            log('⚠️ tactical.db not found, skipping');
            return { success: false, reason: 'no SQLite db' };
        }

        const Database = require('better-sqlite3');
        const sqlite = new Database(dbPath, { readonly: true });

        // Backup prediction_history (most critical)
        const predictions = sqlite.prepare('SELECT * FROM prediction_history').all();
        if (predictions.length > 0) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const p of predictions) {
                    await client.query(`
                        INSERT INTO prediction_history (match_id, league, prediction_type, prediction_val, probability, status, result, timestamp)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (match_id, prediction_type) DO UPDATE SET
                            probability = EXCLUDED.probability,
                            status = COALESCE(EXCLUDED.status, prediction_history.status),
                            result = COALESCE(EXCLUDED.result, prediction_history.result)
                    `, [p.match_id, p.league, p.prediction_type, p.prediction_val, p.probability, p.status, p.result || null, p.timestamp]);
                }
                await client.query('COMMIT');
                log(`✅ prediction_history: ${predictions.length} rows synced to PG`);
            } catch (e) {
                await client.query('ROLLBACK');
                log(`❌ prediction_history sync failed: ${e.message}`);
            } finally {
                client.release();
            }
        }

        // Backup matches (upcoming)
        try {
            const matches = sqlite.prepare("SELECT * FROM matches WHERE status IN ('scheduled','NOT_STARTED','NS')").all();
            if (matches.length > 0) {
                for (const m of matches) {
                    await pool.query(`
                        INSERT INTO matches (id, home_team, away_team, league, start_timestamp, status, score_home, score_away)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (id) DO NOTHING
                    `, [m.id, m.homeTeam || m.home_team, m.awayTeam || m.away_team, m.league, m.startTimestamp || m.start_timestamp, m.status, m.scoreHome || m.score_home, m.scoreAway || m.score_away]);
                }
                log(`✅ matches: ${matches.length} upcoming synced to PG`);
            }
        } catch (e) {
            log(`⚠️ matches sync: ${e.message}`);
        }

        sqlite.close();
        await pool.end();
        log('🎯 PG backup complete');
        return { success: true, predictions: predictions.length };
    } catch (e) {
        log(`❌ Backup failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

async function main() {
    log('🔄 Starting PG backup...');
    const result = await backupToPostgres();
    log(`Result: ${JSON.stringify(result)}`);
}

if (require.main === module) {
    main().catch(e => { log(`❌ Fatal: ${e.message}`); process.exit(1); });
}

module.exports = { backupToPostgres };
