const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Lazy SQLite init (Postgres-only environments don't need better-sqlite3)
let db = null
const dbPath = path.resolve(__dirname, '../data/tactical.db')
try {
  const Database = require('better-sqlite3');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 30000');
  db.pragma('cache_size = -16000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 64000000');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('foreign_keys = ON');
  logger.info('[DB] SQLite initialized')
} catch (e) {
  logger.warn(`[DB] SQLite not available: ${e.message}. Postgres-only mode.`)
}

// Periodic WAL checkpoint (no-op if SQLite unavailable)
const WAL_CHECKPOINT_INTERVAL = 5 * 60 * 1000
setInterval(() => {
  try {
    if (db) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (_) {}
}, WAL_CHECKPOINT_INTERVAL)

// 🚀 [PERFORMANCE] Statement Cache to avoid constant regex/parsing
const statementCache = new Map();
const MAX_CACHE_SIZE = 100;

function getPreparedStatement(sql) {
    if (statementCache.has(sql)) return statementCache.get(sql);
    
    // 🧹 [RAM] Cache Eviction if too large
    if (statementCache.size >= MAX_CACHE_SIZE) {
        const firstKey = statementCache.keys().next().value;
        statementCache.delete(firstKey);
    }
    
    const processedSql = sql
        .replace(/\$\d+/g, '?')
        .replace(/::text/gi, '')
        .replace(/::varchar\(\d+\)/gi, '')
        .replace(/::jsonb/gi, '')
        .replace(/ILIKE/gi, 'LIKE');
        
    try {
        const stmt = db.prepare(processedSql);
        statementCache.set(sql, stmt);
        return stmt;
    } catch (e) {
        logger.error(`[DB CACHE] Failed to prepare: ${processedSql} | Error: ${e.message}`);
        throw e;
    }
}

if (db) logger.info(`🗄️ [DATABASE] Using SQLite: ${dbPath}`);

// ─── ABSOLUTE DEFENSE SCHEMA INITIALIZATION ───────────────────────
function initSchema() {
    if (!db) return
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS matches (
                id TEXT PRIMARY KEY,
                homeTeam TEXT,
                awayTeam TEXT,
                league TEXT,
                scoreHome INTEGER DEFAULT 0,
                scoreAway INTEGER DEFAULT 0,
                minute TEXT,
                status TEXT,
                prediction TEXT,
                confidence REAL,
                fullData TEXT,
                timestamp TEXT,
                startTimestamp INTEGER,
                possession_home INTEGER,
                possession_away INTEGER,
                dangerous_attacks_home INTEGER,
                dangerous_attacks_away INTEGER,
                shots_on_target_home INTEGER,
                shots_on_target_away INTEGER,
                corners_home INTEGER,
                corners_away INTEGER,
                source TEXT,
                last_updated INTEGER,
                home_win_probability REAL,
                draw_probability REAL,
                away_win_probability REAL,
                expected_score TEXT,
                chaos_score INTEGER,
                ou_25_prob REAL,
                btts_prob REAL,
                xgboost_confidence REAL,
                news_impact REAL,
                odds_home REAL,
                odds_draw REAL,
                odds_away REAL,
                ev_home REAL,
                ev_best TEXT,
                weather_temp REAL,
                weather_desc TEXT,
                weather_humidity REAL,
                home_form_pts REAL,
                away_form_pts REAL,
                insufficient_data INTEGER DEFAULT 0,
                category_id TEXT,
                category_name TEXT,
                tournament_id TEXT,
                tournament_name TEXT,
                referee TEXT,
                home_xg REAL,
                away_xg REAL,
                player_ratings_home TEXT,
                player_ratings_away TEXT,
                home_team_id TEXT,
                away_team_id TEXT,
                country_iso TEXT,
                tournament_id_official TEXT,
                home_attack_impact REAL,
                home_defense_impact REAL,
                away_attack_impact REAL,
                away_defense_impact REAL,
                referee_id TEXT,
                referee_yellow_avg REAL,
                referee_red_avg REAL,
                referee_penalties_avg REAL,
                odds_home_open REAL,
                odds_draw_open REAL,
                odds_away_open REAL,
                true_prob_home REAL,
                true_prob_draw REAL,
                true_prob_away REAL,
                true_prob_ou25 REAL,
                true_prob_btts REAL,
                ev_draw REAL,
                ev_away REAL,
                clv_value REAL,
                kelly_stake REAL,
                news_sentiment REAL,
                is_missing_gk INTEGER,
                is_missing_scorer INTEGER,
                is_missing_captain INTEGER,
                is_missing_star INTEGER,
                home_market_value REAL,
                away_market_value REAL,
                referee_home_win_rate REAL,
                is_high_pressure INTEGER,
                motivation_signature TEXT,
                autopsy_result TEXT,
                is_autopsied INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS prediction_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id TEXT,
                league TEXT,
                prediction_type TEXT,
                prediction_val TEXT,
                probability REAL,
                status TEXT DEFAULT 'PENDING',
                result TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(match_id, prediction_type)
            );

            -- Full odds_history with minute tracking created below in second batch
            CREATE TABLE IF NOT EXISTS quant_performance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id TEXT,
                taken_odds REAL,
                closing_odds REAL,
                clv REAL,
                pnl REAL,
                stake REAL,
                ev_at_bet REAL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS leagues_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE,
                tier INTEGER DEFAULT 3,
                active INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS league_challenger_weights (
                league        TEXT PRIMARY KEY,
                weights       TEXT NOT NULL,
                accuracy      REAL DEFAULT 0.0,
                total_cases   INTEGER DEFAULT 0,
                last_updated  DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS league_performance_tracking (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                league        TEXT NOT NULL,
                match_id      TEXT NOT NULL,
                champ_result  TEXT, -- 'WIN' or 'LOSS'
                chall_result  TEXT, -- 'WIN' or 'LOSS'
                timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(league, match_id)
            );

            CREATE TABLE IF NOT EXISTS team_key_players (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                team_id       INTEGER NOT NULL,
                player_id     INTEGER NOT NULL,
                name          TEXT NOT NULL,
                role          TEXT,
                rating        REAL DEFAULT 7.0,
                goals         INTEGER DEFAULT 0,
                assists       INTEGER DEFAULT 0,
                importance    REAL DEFAULT 1.0,
                last_updated  DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(team_id, player_id)
            );

            CREATE TABLE IF NOT EXISTS match_lineups (
                match_id      TEXT PRIMARY KEY,
                home_lineup   TEXT, -- JSON string of player IDs
                away_lineup   TEXT, -- JSON string of player IDs
                status        TEXT DEFAULT 'FETCHED',
                timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS historical_matches (
                id TEXT PRIMARY KEY,
                homeTeam TEXT,
                awayTeam TEXT,
                scoreHome INTEGER,
                scoreAway INTEGER,
                league TEXT,
                fullData TEXT,
                timestamp TEXT,
                archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS winning_patterns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id TEXT,
                league TEXT,
                homeTeam TEXT,
                awayTeam TEXT,
                prediction TEXT,
                result TEXT,
                score TEXT,
                fullData TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS team_registry (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT UNIQUE NOT NULL,
                normalized TEXT NOT NULL,
                league     TEXT,
                last_seen  BIGINT
            );
            CREATE INDEX IF NOT EXISTS idx_team_registry_normalized ON team_registry(normalized);
            CREATE INDEX IF NOT EXISTS idx_team_registry_name ON team_registry(name);

            CREATE TABLE IF NOT EXISTS player_stats (
                player_id   INTEGER PRIMARY KEY,
                name        TEXT NOT NULL,
                team_name   TEXT,
                position    TEXT,
                goals       INTEGER DEFAULT 0,
                shots_on_target_avg REAL DEFAULT 0,
                yellow_cards INTEGER DEFAULT 0,
                red_cards    INTEGER DEFAULT 0,
                rating_avg   REAL DEFAULT 0,
                xg_avg       REAL DEFAULT 0,
                xgot_avg     REAL DEFAULT 0,
                heatmap_danger REAL DEFAULT 0,
                last_updated INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_player_stats_team ON player_stats(team_name);

            CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
            CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);
            CREATE INDEX IF NOT EXISTS idx_matches_status_timestamp ON matches(status, timestamp);
            CREATE INDEX IF NOT EXISTS idx_matches_home_team ON matches(homeTeam);
            CREATE INDEX IF NOT EXISTS idx_matches_away_team ON matches(awayTeam);
            CREATE INDEX IF NOT EXISTS idx_history_match_id ON prediction_history(match_id);
            CREATE INDEX IF NOT EXISTS idx_patterns_league ON winning_patterns(league);

            -- 📈 [ODDS INTEL] Ported from PostgreSQL for SQLite standardization
            CREATE TABLE IF NOT EXISTS odds_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id TEXT NOT NULL,
                minute INTEGER DEFAULT 0,
                odds_home REAL,
                odds_draw REAL,
                odds_away REAL,
                timestamp BIGINT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_odds_history_match_id ON odds_history(match_id);

            CREATE TABLE IF NOT EXISTS odds_patterns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern_hash TEXT UNIQUE NOT NULL,
                pattern_type TEXT NOT NULL,
                movement_profile TEXT NOT NULL, -- JSON string
                occurrences INTEGER DEFAULT 1,
                win_rate_home REAL DEFAULT 0,
                win_rate_draw REAL DEFAULT 0,
                win_rate_away REAL DEFAULT 0,
                avg_total_goals REAL DEFAULT 0,
                confidence REAL DEFAULT 0,
                last_seen BIGINT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- 🔴 LIVE TRAINING: Snapshots for goal prediction model
            CREATE TABLE IF NOT EXISTS live_prediction_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id TEXT NOT NULL,
                home_team TEXT,
                away_team TEXT,
                league TEXT,
                minute INTEGER DEFAULT 0,
                score_home INTEGER DEFAULT 0,
                score_away INTEGER DEFAULT 0,
                prediction_next5 REAL DEFAULT 0,
                prediction_next10 REAL DEFAULT 0,
                prediction_next15 REAL DEFAULT 0,
                home_xg REAL DEFAULT 0,
                away_xg REAL DEFAULT 0,
                home_shots_on_target INTEGER DEFAULT 0,
                away_shots_on_target INTEGER DEFAULT 0,
                home_corners INTEGER DEFAULT 0,
                away_corners INTEGER DEFAULT 0,
                home_possession REAL DEFAULT 50,
                alert_level TEXT DEFAULT 'NORMAL',
                source TEXT,
                -- Actual outcomes (filled retroactively)
                actual_goal_next5 INTEGER,
                actual_goal_next10 INTEGER,
                actual_goal_next15 INTEGER,
                actual_goal_minute INTEGER,
                actual_scored_by TEXT,
                actual_final_home INTEGER,
                actual_final_away INTEGER,
                outcome_checked INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                checked_at DATETIME
            );
            CREATE INDEX IF NOT EXISTS idx_live_logs_match ON live_prediction_logs(match_id);
            CREATE INDEX IF NOT EXISTS idx_live_logs_checked ON live_prediction_logs(outcome_checked);

            CREATE TABLE IF NOT EXISTS league_model_parameters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tournament_name TEXT NOT NULL,
                team_name TEXT,
                attack_rating REAL DEFAULT 0.0,
                defense_rating REAL DEFAULT 0.0,
                hfa REAL DEFAULT 0.25,
                rho REAL DEFAULT -0.12,
                mu REAL DEFAULT 0.13,
                distribution_type TEXT DEFAULT 'poisson',
                num_matches INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tournament_name, team_name)
            );
        `);
        logger.info('🛡️ [DB] Tactical Schema validated with INDICES (SQLite)');
    } catch (e) {
        logger.error(`❌ [DB] Schema Init Failed: ${e.message}`);
    }
}
initSchema();

// ─── AUTO-MIGRATION: Add missing columns to existing DB ───────────────────────
function runMigrations() {
    // List of [table, column, type+default] to ensure exist
    const migrations = [
        ['matches', 'weather_temp',              'REAL'],
        ['matches', 'weather_desc',              'TEXT'],
        ['matches', 'weather_humidity',          'REAL'],
        ['matches', 'home_form_pts',             'REAL'],
        ['matches', 'away_form_pts',             'REAL'],
        ['matches', 'ev_home',                   'REAL'],
        ['matches', 'ev_best',                   'TEXT'],
        ['matches', 'xgboost_confidence',        'REAL DEFAULT 0'],
        ['matches', 'news_impact',               'REAL DEFAULT 0'],
        ['matches', 'ou_25_prob',                'REAL DEFAULT 0'],
        ['matches', 'btts_prob',                 'REAL DEFAULT 0'],
        ['matches', 'odds_home',                 'REAL'],
        ['matches', 'odds_draw',                 'REAL'],
        ['matches', 'odds_away',                 'REAL'],
        ['matches', 'home_win_probability',      'REAL DEFAULT 0'],
        ['matches', 'draw_probability',          'REAL DEFAULT 0'],
        ['matches', 'away_win_probability',      'REAL DEFAULT 0'],
        ['matches', 'expected_score',            'TEXT'],
        ['matches', 'chaos_score',               'INTEGER DEFAULT 50'],
        ['matches', 'insufficient_data',         'INTEGER DEFAULT 0'],
        ['matches', 'source',                    'TEXT'],
        ['matches', 'last_updated',              'INTEGER'],
        ['matches', 'startTimestamp',            'INTEGER'],
        ['matches', 'category_id',               'TEXT'],
        ['matches', 'category_name',             'TEXT'],
        ['matches', 'tournament_id',             'TEXT'],
        ['matches', 'tournament_name',           'TEXT'],
        ['matches', 'referee',                   'TEXT'],
        ['matches', 'home_xg',                   'REAL'],
        ['matches', 'away_xg',                   'REAL'],
        ['matches', 'player_ratings_home',       'TEXT'],
        ['matches', 'player_ratings_away',       'TEXT'],
        ['matches', 'home_team_id',              'TEXT'],
        ['matches', 'away_team_id',              'TEXT'],
        ['matches', 'country_iso',               'TEXT'],
        ['matches', 'tournament_id_official',    'TEXT'],
        ['matches', 'home_attack_impact',        'REAL'],
        ['matches', 'home_defense_impact',       'REAL'],
        ['matches', 'away_attack_impact',        'REAL'],
        ['matches', 'away_defense_impact',       'REAL'],
        ['matches', 'referee_id',                'TEXT'],
        ['matches', 'referee_yellow_avg',        'REAL'],
        ['matches', 'referee_red_avg',           'REAL'],
        ['matches', 'referee_penalties_avg',     'REAL'],
        ['matches', 'odds_home_open',            'REAL'],
        ['matches', 'odds_draw_open',            'REAL'],
        ['matches', 'odds_away_open',            'REAL'],
        ['matches', 'news_sentiment',            'REAL'],
        ['matches', 'is_missing_gk',             'INTEGER'],
        ['matches', 'is_missing_scorer',         'INTEGER'],
        ['matches', 'is_missing_captain',        'INTEGER'],
        ['matches', 'is_missing_star',           'INTEGER'],
        ['matches', 'home_market_value',         'REAL'],
        ['matches', 'away_market_value',         'REAL'],
        ['matches', 'referee_home_win_rate',     'REAL'],
        ['matches', 'is_high_pressure',          'INTEGER'],
        ['matches', 'motivation_signature',      'TEXT'],
        ['matches', 'autopsy_result',            'TEXT'],
        ['matches', 'is_autopsied',               'INTEGER DEFAULT 0'],
        ['matches', 'bsd_match_id',              'TEXT'],
        ['matches', 'best_odds_home',             'REAL'],
        ['matches', 'best_odds_draw',             'REAL'],
        ['matches', 'best_odds_away',             'REAL'],
        ['matches', 'bsd_prediction',             'TEXT'],
        ['matches', 'bsd_home_win_prob',          'REAL DEFAULT 0'],
        ['matches', 'bsd_draw_prob',              'REAL DEFAULT 0'],
        ['matches', 'bsd_away_win_prob',          'REAL DEFAULT 0'],
        ['matches', 'bsd_confidence',             'REAL DEFAULT 0'],
        ['player_stats', 'xg_avg',                'REAL DEFAULT 0'],
        ['player_stats', 'xgot_avg',              'REAL DEFAULT 0'],
        ['player_stats', 'heatmap_danger',        'REAL DEFAULT 0'],
    ];

    let added = 0;
    for (const [table, column, typeDef] of migrations) {
        try {
            // Check if column exists
            const cols = db.prepare(`PRAGMA table_info(${table})`).all();
            const exists = cols.some(c => c.name === column);
            if (!exists) {
                db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`).run();
                logger.info(`🔧 [DB MIGRATION] Added missing column: ${table}.${column}`);
                added++;
            }
        } catch (e) {
            // Column may already exist or table doesn't exist yet — safe to ignore
            logger.warn(`⚠️ [DB MIGRATION] Could not add ${table}.${column}: ${e.message}`);
        }
    }
    if (added > 0) {
        logger.info(`✅ [DB MIGRATION] Applied ${added} column migration(s) successfully.`);
    } else {
        logger.info('✅ [DB MIGRATION] Schema is up-to-date, no migrations needed.');
    }
}
runMigrations();

const database = {
    db: db,
    exec: async (sql) => { db.exec(sql); },
    query: async (sql, params = []) => {
        try {
            const stmt = getPreparedStatement(sql);
            const isMutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|BEGIN|COMMIT|ROLLBACK)/i.test(stmt.source || sql);
            
            if (isMutation) {
                const res = stmt.run(Array.isArray(params) ? params : [params]);
                return { rows: [], lastInsertRowid: res.lastInsertRowid, changes: res.changes };
            } else {
                const rows = stmt.all(Array.isArray(params) ? params : [params]);
                return { rows };
            }
        } catch (e) {
            logger.error(`[DB QUERY] Error: ${e.message} | SQL: ${sql}`);
            return { rows: [] };
        }
    },
    prepare: (sql) => {
        try {
            const stmt = getPreparedStatement(sql);
            return {
                run: (...args) => {
                    const params = Array.isArray(args[0]) ? args[0] : args;
                    const res = stmt.run(params);
                    return { lastInsertRowid: res.lastInsertRowid, changes: res.changes };
                },
                get: (...args) => {
                    const params = Array.isArray(args[0]) ? args[0] : args;
                    return stmt.get(params);
                },
                all: (...args) => {
                    const params = Array.isArray(args[0]) ? args[0] : args;
                    return stmt.all(params);
                }
            };
        } catch (e) {
            logger.error(`[DB PREPARE] Failed: ${sql}`);
            return { run: () => ({changes:0}), get: () => null, all: () => [] };
        }
    },
    get: async (sql, params = []) => {
        const sqliteSql = sql.replace(/\$\d+/g, '?');
        return db.prepare(sqliteSql).get(params);
    },
    transaction: (fn) => (items) => {
        const CHUNK_SIZE = 100;
        const insertChunk = db.transaction((dataChunk) => {
            for (const item of dataChunk) fn(item);
        });

        // Split items into smaller chunks
        for (let i = 0; i < items.length; i += CHUNK_SIZE) {
            const chunk = items.slice(i, i + CHUNK_SIZE);
            insertChunk(chunk);
            // In synchronous land, this is all we can do to minimally segment the transaction object itself
        }
    },

    // -- NATIVE POSTGRES IMPLEMENTATIONS --
    insertMatch: async (m) => {
        try {
            // Skip matches with placeholder team names
            const home = (m.homeTeam || '').toString().toLowerCase()
            const away = (m.awayTeam || '').toString().toLowerCase()
            if (home === 'home' || away === 'away') {
                logger.warn(`[DB] Skipping match ${m.id} — placeholder team name (${m.homeTeam} vs ${m.awayTeam})`)
                return false
            }

            let timestamp = new Date().toISOString();
            if (m.startTimestamp) {
                try {
                    const d = new Date(m.startTimestamp * 1000);
                    if (!isNaN(d.getTime())) timestamp = d.toISOString();
                } catch (e) {
                    logger.warn(`[DB] Invalid timestamp for ${m.id}: ${m.startTimestamp}`)
                }
            }

            const dataToSave = { ...m };
            delete dataToSave.fullData;

            // Merge with existing fullData if match already exists
            let mergedData = dataToSave
            try {
              const existing = db.prepare('SELECT fullData FROM matches WHERE id = ?').get(m.id)
              if (existing && existing.fullData) {
                const existingParsed = typeof existing.fullData === 'string' ? JSON.parse(existing.fullData) : existing.fullData
                mergedData = { ...existingParsed, ...dataToSave }
              }
            } catch (_) {}

            const fullData = JSON.stringify(mergedData);
            const stats = m.stats || m.statistics || {};

            // Best odds = max des sources disponibles
            m.best_odds_home = Math.max(m.odds_home || 0, m.best_odds_home || 0) || m.odds_home || null
            m.best_odds_draw = Math.max(m.odds_draw || 0, m.best_odds_draw || 0) || m.odds_draw || null
            m.best_odds_away = Math.max(m.odds_away || 0, m.best_odds_away || 0) || m.odds_away || null

            const sql = `
                INSERT INTO matches (
                    id, bsd_match_id, homeTeam, awayTeam, league, scoreHome, scoreAway, 
                    minute, status, prediction, confidence, fullData, timestamp,
                    possession_home, possession_away, dangerous_attacks_home, dangerous_attacks_away,
                    shots_on_target_home, shots_on_target_away, corners_home, corners_away,
                    source, last_updated, home_win_probability, draw_probability, away_win_probability,
                    expected_score, chaos_score, ou_25_prob, btts_prob, xgboost_confidence, news_impact,
                    odds_home, odds_draw, odds_away, best_odds_home, best_odds_draw, best_odds_away,
                    ev_home, ev_draw, ev_away, ev_best,
                    odds_home_open, odds_draw_open, odds_away_open,
                    true_prob_home, true_prob_draw, true_prob_away, true_prob_ou25, true_prob_btts,
                    clv_value, kelly_stake,
                    weather_temp, weather_desc, weather_humidity, home_form_pts, away_form_pts, insufficient_data
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?
                ) ON CONFLICT (id) DO UPDATE SET 
                    bsd_match_id = COALESCE(excluded.bsd_match_id, matches.bsd_match_id),
                    scoreHome = excluded.scoreHome, scoreAway = excluded.scoreAway,
                    minute = excluded.minute, status = excluded.status, 
                    last_updated = excluded.last_updated, fullData = excluded.fullData,
                    prediction = COALESCE(excluded.prediction, matches.prediction),
                    confidence = COALESCE(excluded.confidence, matches.confidence),
                    expected_score = CASE WHEN excluded.expected_score != '1 - 1' THEN excluded.expected_score ELSE matches.expected_score END,
                    home_win_probability = COALESCE(excluded.home_win_probability, matches.home_win_probability),
                    draw_probability = COALESCE(excluded.draw_probability, matches.draw_probability),
                    away_win_probability = COALESCE(excluded.away_win_probability, matches.away_win_probability),
                    ou_25_prob = COALESCE(excluded.ou_25_prob, matches.ou_25_prob),
                    btts_prob = COALESCE(excluded.btts_prob, matches.btts_prob),
                    ev_home = COALESCE(excluded.ev_home, matches.ev_home),
                    ev_draw = COALESCE(excluded.ev_draw, matches.ev_draw),
                    ev_away = COALESCE(excluded.ev_away, matches.ev_away),
                    kelly_stake = COALESCE(excluded.kelly_stake, matches.kelly_stake),
                    possession_home = excluded.possession_home, possession_away = excluded.possession_away,
                    dangerous_attacks_home = excluded.dangerous_attacks_home, dangerous_attacks_away = excluded.dangerous_attacks_away,
                    odds_home = COALESCE(excluded.odds_home, matches.odds_home),
                    odds_draw = COALESCE(excluded.odds_draw, matches.odds_draw),
                    odds_away = COALESCE(excluded.odds_away, matches.odds_away),
                    best_odds_home = COALESCE(excluded.best_odds_home, matches.best_odds_home),
                    best_odds_draw = COALESCE(excluded.best_odds_draw, matches.best_odds_draw),
                    best_odds_away = COALESCE(excluded.best_odds_away, matches.best_odds_away),
                    weather_temp = COALESCE(excluded.weather_temp, matches.weather_temp),
                    weather_desc = COALESCE(excluded.weather_desc, matches.weather_desc),
                    weather_humidity = COALESCE(excluded.weather_humidity, matches.weather_humidity),
                    home_form_pts = COALESCE(excluded.home_form_pts, matches.home_form_pts),
                    away_form_pts = COALESCE(excluded.away_form_pts, matches.away_form_pts),
                    insufficient_data = excluded.insufficient_data;
            `;

            const params = [
                m.id, m.bsd_match_id || null, m.homeTeam, m.awayTeam, m.league, m.score?.home ?? 0, m.score?.away ?? 0,
                m.minute || '0', m.status || (m.isLive ? 'live' : 'scheduled'), m.prediction, m.confidence,
                fullData, timestamp,
                stats.possession?.home || m.possession_home || 0, stats.possession?.away || m.possession_away || 0,
                stats.dangerousAttacks?.home || m.dangerous_attacks_home || 0, stats.dangerousAttacks?.away || m.dangerous_attacks_away || 0,
                stats.totalShots?.home || m.shots_on_target_home || 0, stats.totalShots?.away || m.shots_on_target_away || 0,
                stats.corners?.home || m.corners_home || 0, stats.corners?.away || m.corners_away || 0,
                m.source || 'flashscore', Date.now(),
                m.home_win_probability || 0, m.draw_probability || 0, m.away_win_probability || 0,
                m.expected_score || '1 - 1', m.chaos_score || 50, m.ou_25_prob || 0, m.btts_prob || 0,
                m.xgboost_confidence || 0, m.news_impact || 0,
                m.odds_home || null, m.odds_draw || null, m.odds_away || null,
                m.best_odds_home || null, m.best_odds_draw || null, m.best_odds_away || null,
                m.ev_home || null, m.ev_draw || null, m.ev_away || null, m.ev_best || 'NONE',
                m.odds_home_open || m.odds_home || null, m.odds_draw_open || m.odds_draw || null, m.odds_away_open || m.odds_away || null,
                m.true_prob_home || null, m.true_prob_draw || null, m.true_prob_away || null, m.true_prob_ou25 || null, m.true_prob_btts || null,
                m.clv_value || 0, m.kelly_stake || 0,
                m.weather_temp ?? null, m.weather_desc ?? null, m.weather_humidity ?? null,
                m.home_form_pts || 0, m.away_form_pts || 0, m.insufficient_data || 0
            ];

            db.prepare(sql).run(params);
            return m.id;
        } catch (err) { 
            logger.error(`SQLite insertMatch error: ${err.message}`);
            throw err; 
        }
    },

    getMatchesByStatuses: async (statuses = []) => {
        if (!Array.isArray(statuses) || statuses.length === 0) return [];
        try {
            const placeholders = statuses.map(() => '?').join(',');
            const res = db.prepare(`SELECT * FROM matches WHERE status IN (${placeholders}) ORDER BY timestamp ASC`).all(statuses);
            return res.map(r => {
                try {
                    const parsed = r.fullData ? (typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData) : {};
                    return { 
                        ...r, ...parsed, 
                        id: r.id, 
                        homeTeam: r.homeTeam || parsed.homeTeam, 
                        awayTeam: r.awayTeam || parsed.awayTeam, 
                        league: r.league || parsed.league,
                        insufficient_data: r.insufficient_data
                    };
                } catch (e) { return r; }
            });
        } catch (e) {
            logger.error(`[DB] getMatchesByStatuses failed: ${e.message}`);
            return [];
        }
    },

    getAllMatches: async () => {
        try {
            const res = db.prepare(`SELECT * FROM matches ORDER BY timestamp DESC`).all();
            return res.map(r => {
                try {
                    const parsed = r.fullData ? (typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData) : {};
                    return { 
                        ...r, ...parsed, 
                        id: r.id, 
                        homeTeam: r.homeTeam || parsed.homeTeam, 
                        awayTeam: r.awayTeam || parsed.awayTeam, 
                        league: r.league || parsed.league,
                        insufficient_data: r.insufficient_data
                    };
                } catch (e) { return r; }
            });
        } catch (e) {
            logger.error(`[DB] getAllMatches failed: ${e.message}`);
            return [];
        }
    },

    /**
     * Finds or creates a team alias to handle name normalization across sources.
     * E.g., "ESPERANCE" -> "Esperance Tunis"
     */
    resolveTeamName: async (name) => {
        if (!name) return null;
        const normalized = name.toLowerCase().trim()
            .replace(/%20/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/[.\-]/g, '');
            
        try {
            // 1. Check if we have an alias in the registry
            const row = db.prepare('SELECT name FROM team_registry WHERE normalized = ? OR name LIKE ? LIMIT 1')
                .get(normalized, `%${normalized}%`);
            
            if (row) return row.name;

            // 2. If not found, add it as a new entry for future learning
            db.prepare('INSERT OR IGNORE INTO team_registry (name, normalized, last_seen) VALUES (?, ?, ?)')
                .run(name, normalized, Date.now());
            
            return name;
        } catch (e) {
            return name;
        }
    },

    getMatchById: async (id) => {
        try {
            const r = db.prepare("SELECT * FROM matches WHERE id = ?").get(id);
            if (!r) return null;
            try {
                const parsed = r.fullData ? (typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData) : {};
                return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league };
            } catch (e) { return r; }
        } catch (err) { return null; }
    },
    
    updatePredictions: async (matchId, data) => {
        try {
            const row = db.prepare('SELECT fullData FROM matches WHERE id = ?').get(matchId);
            if (!row) return false;
            
            let fullData = row.fullData ? (typeof row.fullData === 'string' ? JSON.parse(row.fullData) : row.fullData) : {};
            
            // Ensure we have a clean enriched object
            const enriched = data.enriched || (data.home_win_probability ? data : null);
            
            fullData = { 
                ...fullData, 
                ...data,
                enriched: enriched ? { ...(fullData.enriched || {}), ...enriched } : fullData.enriched,
                last_updated: Date.now() 
            };
            
            // If data was already enriched, flatten important fields to top level for DB queries
            if (enriched) {
                fullData.home_win_probability = enriched.home_win_probability || fullData.home_win_probability;
                fullData.draw_probability = enriched.draw_probability || fullData.draw_probability;
                fullData.away_win_probability = enriched.away_win_probability || fullData.away_win_probability;
                fullData.master_v20 = enriched.master_v20 || fullData.master_v20;
            }
            
            delete fullData.id;
            delete fullData.fullData;
            if (fullData.enriched && fullData.enriched.enriched) delete fullData.enriched.enriched;

            const verdict = data.prediction || (data.enriched && data.enriched.prediction) || data.verdict || 'RISKY BET';

            // Extract scalar values to write into indexed SQLite columns
            // Use null when no source provides a value (allows clearing)
            const hProb  = data.home_win_probability !== undefined ? parseFloat(data.home_win_probability) : (enriched?.home_win_probability !== undefined ? parseFloat(enriched.home_win_probability) : (fullData.home_win_probability !== undefined ? parseFloat(fullData.home_win_probability) : null));
            const dProb  = data.draw_probability !== undefined ? parseFloat(data.draw_probability) : (enriched?.draw_probability !== undefined ? parseFloat(enriched.draw_probability) : (fullData.draw_probability !== undefined ? parseFloat(fullData.draw_probability) : null));
            const aProb  = data.away_win_probability !== undefined ? parseFloat(data.away_win_probability) : (enriched?.away_win_probability !== undefined ? parseFloat(enriched.away_win_probability) : (fullData.away_win_probability !== undefined ? parseFloat(fullData.away_win_probability) : null));
            const ou25   = data.ou_25_prob !== undefined ? parseFloat(data.ou_25_prob) : (enriched?.ou_25_prob !== undefined ? parseFloat(enriched.ou_25_prob) : (data.ou_2_5_prob !== undefined ? parseFloat(data.ou_2_5_prob) : null));
            const bttsp  = data.btts_prob !== undefined ? parseFloat(data.btts_prob) : (enriched?.btts_prob !== undefined ? parseFloat(enriched.btts_prob) : null);
            const expScr = data.expected_score || enriched?.expected_score || fullData.expected_score || null;
            const conf   = data.confidence !== undefined ? parseFloat(data.confidence) : (enriched?.confidence !== undefined ? parseFloat(enriched.confidence) : (data.v22_success_rate !== undefined ? parseFloat(data.v22_success_rate) : null));
            const xgbConf = data.xgboost_confidence !== undefined ? parseFloat(data.xgboost_confidence) : (enriched?.xgboost_confidence !== undefined ? parseFloat(enriched.xgboost_confidence) : null);

            // ⚡ Write BOTH fullData JSON AND individual indexed columns
            const sql = `
                UPDATE matches SET 
                    "fullData" = ?,
                    prediction = ?,
                    last_updated = ?,
                    "home_win_probability" = CASE WHEN ? IS NOT NULL THEN ? ELSE "home_win_probability" END,
                    "draw_probability"     = CASE WHEN ? IS NOT NULL THEN ? ELSE "draw_probability" END,
                    "away_win_probability" = CASE WHEN ? IS NOT NULL THEN ? ELSE "away_win_probability" END,
                    "ou_25_prob"           = CASE WHEN ? IS NOT NULL THEN ? ELSE "ou_25_prob" END,
                    "btts_prob"            = CASE WHEN ? IS NOT NULL THEN ? ELSE "btts_prob" END,
                    "expected_score"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "expected_score" END,
                    confidence           = CASE WHEN ? IS NOT NULL THEN ? ELSE confidence END,
                    "xgboost_confidence"   = CASE WHEN ? IS NOT NULL THEN ? ELSE "xgboost_confidence" END,
                    "ev_home"              = CASE WHEN ? IS NOT NULL THEN ? ELSE "ev_home" END,
                    "ev_draw"              = CASE WHEN ? IS NOT NULL THEN ? ELSE "ev_draw" END,
                    "ev_away"              = CASE WHEN ? IS NOT NULL THEN ? ELSE "ev_away" END,
                    "kelly_stake"          = CASE WHEN ? IS NOT NULL THEN ? ELSE "kelly_stake" END,
                    "true_prob_home"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "true_prob_home" END,
                    "true_prob_draw"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "true_prob_draw" END,
                    "true_prob_away"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "true_prob_away" END,
                    "weather_temp"         = CASE WHEN ? IS NOT NULL THEN ? ELSE "weather_temp" END,
                    "weather_humidity"     = CASE WHEN ? IS NOT NULL THEN ? ELSE "weather_humidity" END,
                    "home_form_pts"        = CASE WHEN ? IS NOT NULL THEN ? ELSE "home_form_pts" END,
                    "away_form_pts"        = CASE WHEN ? IS NOT NULL THEN ? ELSE "away_form_pts" END,
                    "motivation_signature" = ?,
                    "insufficient_data" = 0
                WHERE id = ?
            `;

            const params = [
                JSON.stringify(fullData), verdict, Date.now(),
                hProb, hProb,
                dProb, dProb,
                aProb, aProb,
                ou25,  ou25,
                bttsp, bttsp,
                expScr, expScr,
                conf,  conf,
                xgbConf, xgbConf,
                data.ev_home ?? null, data.ev_home ?? null,
                data.ev_draw ?? null, data.ev_draw ?? null,
                data.ev_away ?? null, data.ev_away ?? null,
                data.kelly_stake ?? null, data.kelly_stake ?? null,
                data.true_prob_home ?? null, data.true_prob_home ?? null,
                data.true_prob_draw ?? null, data.true_prob_draw ?? null,
                data.true_prob_away ?? null, data.true_prob_away ?? null,
                data.weather_temp ?? null, data.weather_temp ?? null,
                data.weather_humidity ?? null, data.weather_humidity ?? null,
                data.home_form_pts ?? null, data.home_form_pts ?? null,
                data.away_form_pts ?? null, data.away_form_pts ?? null,
                data.motivation_signature || enriched?.motivation_signature || 'Logique Standard',
                matchId
            ];

            // 🛡️ [STABILITY] Atomic transaction + Retry for SQLite "Database is locked"
            const histSql = `
                INSERT INTO prediction_history (match_id, league, prediction_type, prediction_val, probability, status, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(match_id, prediction_type) DO UPDATE SET
                probability = excluded.probability,
                prediction_val = excluded.prediction_val
            `
            const updateTransaction = db.transaction(() => {
                db.prepare(sql).run(params)
                if (hProb > 0) db.prepare(histSql).run(matchId, fullData.league, 'Home', 'Win', hProb/100, 'pending', Date.now())
                if (aProb > 0) db.prepare(histSql).run(matchId, fullData.league, 'Away', 'Win', aProb/100, 'pending', Date.now())
                if (dProb > 0) db.prepare(histSql).run(matchId, fullData.league, 'Draw', 'Draw', dProb/100, 'pending', Date.now())
            })

            let attempts = 0;
            while (attempts < 3) {
                try {
                    updateTransaction()
                    logger.info(`✅ [DB] AI Enrichment persisted for ${matchId} — Home:${hProb.toFixed(1)}% Draw:${dProb.toFixed(1)}% Away:${aProb.toFixed(1)}%`);
                    return true;
                } catch (err) {
                    attempts++;
                    if (err.message.includes('busy') || err.message.includes('locked')) {
                        logger.warn(`⚠️ [DB] Database busy, retry ${attempts}/3 for ${matchId}...`);
                        await new Promise(r => setTimeout(r, 500 * attempts));
                    } else {
                        logger.error(`❌ [DB] updatePredictions transaction failed for ${matchId}: ${err.message}`);
                        return false;
                    }
                }
            }
            return false;
        } catch (e) {
            logger.error(`❌ [DB] updatePredictions failed for ${matchId}: ${e.message}`);
            return false;
        }
    },

    getLatestMatchTimestamp: async () => {
        const row = db.prepare("SELECT MAX(timestamp) as lastupdate FROM matches").get();
        return row?.lastupdate;
    },

    getLeagueAverages: async () => { return { avgTotalGoals: 2.7, avgHomeGoals: 1.5, avgAwayGoals: 1.2, matchCount: 0 }; },

    getAllLeaguesConfig: async () => {
        try {
            return db.prepare("SELECT * FROM leagues_config ORDER BY tier ASC, name ASC").all();
        } catch (e) { return []; } 
    },

    insertPlayerStat: async (stat) => { return true; }, // Handled outside directly or ignored initially
    getPlayerStatsByTeam: async (teamName) => { return []; },
    insertVisionLog: async (desc) => { return true; },
    getHighImpactScheduledMatches: async () => {
        try {
            const rows = db.prepare(`
                SELECT * FROM matches 
                WHERE status = 'scheduled' 
                AND (json_extract(fullData, '$.news_data') IS NOT NULL)
                ORDER BY timestamp ASC LIMIT 20
            `).all();
            return rows.map(r => {
                const parsed = JSON.parse(r.fullData || '{}');
                return { ...r, ...parsed };
            });
        } catch (e) { return []; }
    },
    getNewsPrecisionHistory: async () => {
        try {
            const rows = db.prepare(`
                SELECT homeTeam, awayTeam, status, scoreHome, scoreAway, fullData
                FROM matches 
                WHERE status IN ('FT', 'finished', 'Finished')
                ORDER BY timestamp DESC LIMIT 30
            `).all();
            
            let total = 0;
            let hits = 0;
            const matches = [];

            for (const r of rows) {
                const data = JSON.parse(r.fullData || '{}');
                const pronos = (data.enriched && data.enriched.main_predictions) ? data.enriched.main_predictions : (data.predictions || []);
                if (pronos.length === 0) continue;

                total++;
                const actual = r.scoreHome > r.scoreAway ? 'H' : r.scoreHome < r.scoreAway ? 'A' : 'D';
                
                // Simplified success check
                let success = false;
                pronos.forEach(p => {
                    const val = (p.val || '').toLowerCase();
                    if (val.includes('home') || val.includes('🏠') || val.includes('1')) {
                        if (actual === 'H') success = true;
                    } else if (val.includes('away') || val.includes('✈️') || val.includes('2')) {
                        if (actual === 'A') success = true;
                    } else if (val.includes('draw') || val.includes('x')) {
                        if (actual === 'D') success = true;
                    }
                });

                if (success) hits++;
                matches.push({
                    id: Math.random().toString(),
                    homeTeam: r.homeTeam,
                    awayTeam: r.awayTeam,
                    impact: 'High',
                    success: success
                });
            }

            return {
                total,
                accuracy: total > 0 ? Math.round((hits / total) * 100) : 0,
                matches: matches.slice(0, 10)
            };
        } catch (e) { return { total: 0, accuracy: 0, matches: [] }; }
    },
    seedLeagues: async (leagues) => { return true; },
    getTeamMatchHistory: async (teamName, limit=5) => { return []; },
    archiveFinishedMatches: async () => {
        try {
            const finished = db.prepare("SELECT * FROM matches WHERE status IN ('FT', 'finished', 'Finished', 'Ended')").all();
            if (finished.length === 0) return { success: true, archivedCount: 0 };

            const insert = db.prepare(`
                INSERT INTO historical_matches (id, homeTeam, awayTeam, scoreHome, scoreAway, league, fullData, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO NOTHING
            `);
            
            const updateHist = db.prepare(`
                UPDATE prediction_history 
                SET status = 'finished', 
                    result = CASE 
                        WHEN prediction_type = 'Home' AND ? > ? THEN 'won'
                        WHEN prediction_type = 'Away' AND ? < ? THEN 'won'
                        WHEN prediction_type = 'Draw' AND ? = ? THEN 'won'
                    END
                WHERE match_id = ? AND prediction_type IN ('Home', 'Away', 'Draw')
            `);

            const deleteStmt = db.prepare("DELETE FROM matches WHERE id = ?");

            let count = 0;
            const transaction = db.transaction((rows) => {
                for (const r of rows) {
                    const sh = r.scoreHome ?? 0;
                    const sa = r.scoreAway ?? 0;
                    
                    insert.run(r.id, r.homeTeam, r.awayTeam, sh, sa, r.league, r.fullData || '{}', r.timestamp || new Date().toISOString());
                    updateHist.run(sh, sa, sh, sa, sh, sa, r.id);
                    deleteStmt.run(r.id);
                    count++;
                }
            });

            transaction(finished);
            logger.info(`📦 [DB] Archived ${count} matches to historical_matches.`);
            return { success: true, archivedCount: count };
        } catch (e) {
            logger.error(`❌ [DB] Archive failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    },
    insertSnapshot: async (matchId, minute, stats) => { return true; },
    getSnapshotBefore: async (matchId, beforeTimestamp) => { return null; },

    // ── LIVE PREDICTION LOGGING ────────────────────────────────────
    logLivePrediction: async (snapshot) => {
        try {
            const sql = `
                INSERT INTO live_prediction_logs
                    (match_id, home_team, away_team, league, minute, score_home, score_away,
                     prediction_next5, prediction_next10, prediction_next15,
                     home_xg, away_xg, home_shots_on_target, away_shots_on_target,
                     home_corners, away_corners, home_possession, alert_level, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const res = db.prepare(sql).run(
                snapshot.matchId, snapshot.homeTeam, snapshot.awayTeam, snapshot.league,
                snapshot.minute, snapshot.scoreHome, snapshot.scoreAway,
                snapshot.predNext5, snapshot.predNext10, snapshot.predNext15,
                snapshot.homeXg || 0, snapshot.awayXg || 0,
                snapshot.homeSot || 0, snapshot.awaySot || 0,
                snapshot.homeCorners || 0, snapshot.awayCorners || 0,
                snapshot.homePossession || 50, snapshot.alertLevel || 'NORMAL',
                snapshot.source || 'unknown'
            );
            return res.lastInsertRowid
        } catch (e) {
            logger.error(`[DB] logLivePrediction failed: ${e.message}`)
            return null
        }
    },

    updateLivePredictionOutcomes: async (matchId, finalScoreHome, finalScoreAway) => {
        try {
            const logs = db.prepare(
                `SELECT id, minute, score_home, score_away FROM live_prediction_logs
                 WHERE match_id = ? AND outcome_checked = 0 ORDER BY minute ASC`
            ).all(matchId);

            for (const log of logs) {
                const next5goal = log.minute + 5
                const next10goal = log.minute + 10
                const next15goal = log.minute + 15

                const actualGoalMinute = null // Unknown without granular live data
                const goalNext5 = finalScoreHome + finalScoreAway > log.score_home + log.score_away ? 1 : 0
                const goalNext10 = goalNext5
                const goalNext15 = goalNext5

                db.prepare(`
                    UPDATE live_prediction_logs SET
                        actual_goal_next5 = ?,
                        actual_goal_next10 = ?,
                        actual_goal_next15 = ?,
                        actual_final_home = ?,
                        actual_final_away = ?,
                        outcome_checked = 1,
                        checked_at = datetime('now')
                    WHERE id = ?
                `).run(goalNext5, goalNext10, goalNext15, finalScoreHome, finalScoreAway, log.id);
            }

            if (logs.length > 0) {
                logger.info(`[DB] Updated ${logs.length} live prediction outcomes for match ${matchId}`)
            }
            return logs.length
        } catch (e) {
            logger.error(`[DB] updateLivePredictionOutcomes failed: ${e.message}`)
            return 0
        }
    },

    getLivePredictionsForTraining: async (limit = 5000) => {
        try {
            return db.prepare(`
                SELECT * FROM live_prediction_logs
                WHERE outcome_checked = 1 AND actual_goal_next5 IS NOT NULL
                ORDER BY created_at DESC LIMIT ?
            `).all(limit);
        } catch (e) {
            logger.error(`[DB] getLivePredictionsForTraining failed: ${e.message}`)
            return []
        }
    },

    getUncheckedLivePredictions: async () => {
        try {
            return db.prepare(
                `SELECT DISTINCT match_id FROM live_prediction_logs WHERE outcome_checked = 0`
            ).all();
        } catch (e) {
            return []
        }
    },
    insertPattern: async (match) => {
        try {
            const sql = `
                INSERT INTO winning_patterns (match_id, league, homeTeam, awayTeam, prediction, result, score, fullData)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const result = match.status === 'finished' ? 'WIN' : 'UNKNOWN'; 
            const scoreStr = `${match.scoreHome}-${match.scoreAway}`;
            
            db.prepare(sql).run(
                match.id, 
                match.league, 
                match.homeTeam, 
                match.awayTeam, 
                match.prediction || 'N/A', 
                result, 
                scoreStr, 
                match.fullData || JSON.stringify(match)
            );
            return true;
        } catch (e) {
            logger.error(`❌ [DB] insertPattern failed: ${e.message}`);
            return false;
        }
    },
    getAllPatterns: async (limit=100) => {
        try {
            return db.prepare("SELECT * FROM winning_patterns ORDER BY timestamp DESC LIMIT ?").all(limit);
        } catch (e) { return []; }
    },
    getUpcomingPredictions: async () => { return []; },
    insertPrediction: async (p) => { return p.id; },
    getMatchesByStatus: async (status, limit = null) => {
        const parsedStatus = status === 'live' ? 'live' : (status === 'scheduled' ? 'scheduled' : status);
        const sql = limit ? `SELECT * FROM matches WHERE status = ? ORDER BY timestamp ASC LIMIT ?` : `SELECT * FROM matches WHERE status = ? ORDER BY timestamp ASC`;
        const params = limit ? [parsedStatus, limit] : [parsedStatus];
        const res = db.prepare(sql).all(...params);
        return res.map(r => {
            try {
                const parsed = r.fullData ? (typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData) : {};
                return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league };
            } catch (e) { return r; }
        });
    },

    cleanupStaleMatches: async () => {
        try {
            // Delete matches older than 24 hours that are not LIVE
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const res = db.prepare("DELETE FROM matches WHERE timestamp < ? AND status NOT IN ('live', '1H', '2H', 'HT')").run(oneDayAgo);
            if (res.changes > 0) {
                logger.info(`🧹 [DB] Cleaned up ${res.changes} stale matches older than 24h.`);
            }
            return res.changes;
        } catch (e) {
            logger.error(`❌ [DB] Cleanup failed: ${e.message}`);
            return 0;
        }
    },

    maintenance: async () => {
        try {
            logger.info('🧹 [DB] Running RAM & integrity optimization (VACUUM + ANALYZE)...');
            db.exec('ANALYZE');
            db.exec('VACUUM');
            logger.info('✅ [DB] Database maintenance complete.');
            return true;
        } catch (e) {
            logger.error(`❌ [DB] Maintenance error: ${e.message}`);
            return false;
        }
    },

    getMatchesByDate: async (dateStr) => {
        try {
            // dateStr format: 'YYYY-MM-DD'
            // We search in the timestamp column which contains ISO dates
            const res = db.prepare(`SELECT * FROM matches WHERE timestamp LIKE ? ORDER BY timestamp ASC`).all(`${dateStr}%`);
            return res.map(r => {
                try {
                    const parsed = r.fullData ? (typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData) : {};
                    return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league };
                } catch (e) { return r; }
            });
        } catch (e) {
            logger.error(`[DB] getMatchesByDate failed: ${e.message}`);
            return [];
        }
    },
    cleanupPlaceholderTeams: () => {
        try {
            const count = db.prepare("DELETE FROM matches WHERE LOWER(homeTeam) = 'home' OR LOWER(awayTeam) = 'away'").run()
            if (count.changes > 0) {
                logger.info(`[DB] Cleaned up ${count.changes} matches with placeholder team names`)
            }
            return count.changes
        } catch (e) {
            logger.error(`[DB] Cleanup error: ${e.message}`)
            return 0
        }
    },
    // ─── GOALMODEL PARAMETERS ──────────────────────────────────
    getGoalModelParameters: async (tournamentName) => {
        try {
            const rows = db.prepare(
                "SELECT * FROM league_model_parameters WHERE tournament_name = ?"
            ).all(tournamentName);
            return rows;
        } catch (e) {
            logger.error(`[DB] getGoalModelParameters error: ${e.message}`);
            return [];
        }
    },
    upsertGoalModelParameter: async (params) => {
        try {
            const ts = params.updated_at || new Date().toISOString()
            db.prepare(`
                INSERT INTO league_model_parameters (tournament_name, team_name, attack_rating, defense_rating, hfa, rho, mu, distribution_type, num_matches, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tournament_name, team_name) DO UPDATE SET
                    attack_rating = excluded.attack_rating,
                    defense_rating = excluded.defense_rating,
                    hfa = excluded.hfa,
                    rho = excluded.rho,
                    mu = excluded.mu,
                    distribution_type = excluded.distribution_type,
                    num_matches = excluded.num_matches,
                    updated_at = excluded.updated_at
            `).run(
                params.tournament_name,
                params.team_name || null,
                params.attack_rating || 0,
                params.defense_rating || 0,
                params.hfa || 0.25,
                params.rho || -0.12,
                params.mu || 0.13,
                params.distribution_type || 'poisson',
                params.num_matches || 0,
                ts
            );
            return true;
        } catch (e) {
            logger.error(`[DB] upsertGoalModelParameter error: ${e.message}`);
            return false;
        }
    },
    query: (sql, params = []) => {
        try {
            const stmt = getPreparedStatement(sql);
            const res = stmt.all(params);
            return { rows: res || [] };
        } catch (e) {
            logger.error(`[DB QUERY ERROR] ${sql} | ${e.message}`);
            return { rows: [] };
        }
    }
};

// 🛡️ [DATABASE SELF-HEALING]
// Removed redundant maintenance interval - handled by CronManager at 3 AM.

database.db.query = database.query.bind(database);

// ─── Auto-detect: Postgres (Neon/Supabase) vs SQLite ───
if (process.env.DATABASE_URL) {
  logger.info('[DB] DATABASE_URL detected — using Postgres (Neon/Supabase) instead of SQLite')
  const pgConnector = require('./pg_connector')
  const pgDb = require('./pg_database')
  const pgMigrations = require('./pg_migrations')
  pgConnector.getPool() // Ensure isPostgres=true BEFORE migration check
  pgMigrations.runMigrations().catch(e => logger.error(`[DB] PG migration error: ${e.message}`))
  // Direct backfill of startTimestamp from "fullData" for existing rows
  setTimeout(async () => {
    try {
      const { query: pgQuery } = require('./pg_connector')
      const testResult = await pgQuery('SELECT id, "fullData", SUBSTRING("fullData" FROM \'"startTimestamp":([0-9]+)\') AS ts FROM matches WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL LIMIT 1')
      if (testResult.rows.length > 0) {
        const testRow = testResult.rows[0]
        logger.info(`[DB] Backfill test: id=${testRow.id} ts_extracted=${testRow.ts} fullData_length=${(testRow.fullData || '').length}`)
        if (testRow.ts) {
          const result = await pgQuery(
            `UPDATE matches SET "startTimestamp" = SUBSTRING("fullData" FROM '"startTimestamp":([0-9]+)')::bigint WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL AND "fullData" ~ '"startTimestamp":[0-9]+'`
          )
          logger.info(`[DB] Backfill result: rowCount=${result.rowCount}`)
        } else {
          logger.warn(`[DB] Backfill: could not extract startTimestamp (format mismatch or fullData JSON missing field)`)
        }
      } else {
        logger.info('[DB] Backfill: no rows need backfill')
      }
    } catch (e) {
      logger.warn(`[DB] Backfill error: ${e.message} | stack: ${(e.stack || '').slice(0, 200)}`)
    }
  }, 5000)
  module.exports = pgDb
} else {
  module.exports = database
}
