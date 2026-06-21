/**
 * migrate_to_pg.js — V90 Database Migration Strategy
 * ───────────────────────────────────────────────────────
 * This script serves as the official PostgreSQL adapter initialization.
 * Run this when transitioning the app from zero-config SQLite to 
 * Enterprise PostgreSQL for High-Availability.
 * 
 * Usage: `node scripts/migrate_to_pg.js`
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PG_URL = process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/stitch_titanium';

async function migratePG() {
    console.log(`🐬 [PG_MIGRATE] Connecting to PostgreSQL at ${PG_URL.split('@')[1] || 'default'}...`);
    const client = new Client({ connectionString: PG_URL });

    try {
        await client.connect();
        console.log(`✅ [PG_MIGRATE] Connected successfully.`);

        // 1. Matches Table (V90 Full Schema)
        console.log(`🔨 [PG_MIGRATE] Creating 'matches' table...`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS matches (
                id TEXT PRIMARY KEY,
                homeTeam TEXT,
                awayTeam TEXT,
                status TEXT,
                league TEXT,
                scoreHome INTEGER,
                scoreAway INTEGER,
                minute TEXT,
                fullData JSONB,
                last_updated BIGINT,
                timestamp TIMESTAMP,
                home_xg REAL,
                away_xg REAL,
                odds_home REAL,
                odds_draw REAL,
                odds_away REAL,
                odds_home_open REAL,
                odds_draw_open REAL,
                odds_away_open REAL,
                referee TEXT,
                referee_yellow_avg REAL,
                home_attack_impact REAL DEFAULT 1.0,
                home_defense_impact REAL DEFAULT 1.0,
                away_attack_impact REAL DEFAULT 1.0,
                away_defense_impact REAL DEFAULT 1.0,
                weather_temp REAL,
                weather_desc TEXT
            );
        `);

        // 2. Indexes for fast retrieval
        console.log(`⚡ [PG_MIGRATE] Creating indexes...`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);`);

        // 3. Player Stats Table
        console.log(`🔨 [PG_MIGRATE] Creating 'player_stats' table...`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS player_stats (
                player_id TEXT PRIMARY KEY,
                name TEXT,
                team_name TEXT,
                position TEXT,
                goals INTEGER DEFAULT 0,
                shots_on_target_avg REAL DEFAULT 0.0,
                rating_avg REAL DEFAULT 6.5,
                last_updated BIGINT
            );
        `);

        console.log(`🚀 [PG_MIGRATE] V90 Schema fully deployed to PostgreSQL!`);
        console.log(`👉 Next steps: Update 'core/database.js' to export the 'pg' client instead of 'better-sqlite3'.`);

    } catch (err) {
        console.error(`❌ [PG_MIGRATE] Migration failed:`, err.message);
    } finally {
        await client.end();
    }
}

// Execute if run directly
if (require.main === module) {
    migratePG();
}

module.exports = migratePG;
