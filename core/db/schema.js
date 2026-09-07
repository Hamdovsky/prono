// schema.js — schéma SQLite, auto-migrations colonnes, seed leagues.
// Extrait de core/database.js (split 2026-09-07) ; le handle db est passé en paramètre.
const logger = require('../logger')

// ─── ABSOLUTE DEFENSE SCHEMA INITIALIZATION ───────────────────────
function initSchema(db) {
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
                ht_score_home INTEGER,
                ht_score_away INTEGER,
                corners_ht_home INTEGER,
                corners_ht_away INTEGER,
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
                odds_source TEXT,
                odds_fetch_error TEXT,
                odds_over25 REAL,
                odds_under25 REAL,
                odds_btts_yes REAL,
                odds_btts_no REAL,
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
            -- Daily top-picks persisted for real settlement/accuracy scoring
            CREATE TABLE IF NOT EXISTS top_picks (
                id TEXT PRIMARY KEY,
                pick_date TEXT,
                home_team TEXT,
                away_team TEXT,
                league TEXT,
                prediction TEXT,
                confidence REAL,
                home_prob REAL,
                draw_prob REAL,
                away_prob REAL,
                odds_home REAL,
                odds_draw REAL,
                odds_away REAL,
                odds_source TEXT,
                odds_fetch_error TEXT,
                ev REAL,
                kelly REAL,
                has_real_odds INTEGER DEFAULT 0,
                models TEXT,
                match_id TEXT,
                status TEXT DEFAULT 'PENDING',
                result TEXT,
                score TEXT,
                source TEXT DEFAULT 'all',
                created_at BIGINT,
                settled_at BIGINT
            );
            CREATE INDEX IF NOT EXISTS idx_top_picks_status ON top_picks(status);
            CREATE INDEX IF NOT EXISTS idx_top_picks_date ON top_picks(pick_date);
            CREATE INDEX IF NOT EXISTS idx_top_picks_match ON top_picks(match_id);

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

            CREATE TABLE IF NOT EXISTS bets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_label TEXT,
                league TEXT,
                pick TEXT,
                odds REAL,
                stake REAL,
                result TEXT DEFAULT 'pending',
                profit REAL DEFAULT 0,
                note TEXT,
                date TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS leagues_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE,
                tier TEXT DEFAULT 'MENA',
                active INTEGER DEFAULT 1,
                flag TEXT DEFAULT '',
                country TEXT DEFAULT '',
                displayName TEXT DEFAULT '',
                smartScanEnabled INTEGER DEFAULT 1,
                webhookEnabled INTEGER DEFAULT 1,
                arabicNewsEnabled INTEGER DEFAULT 0
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
                archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                prediction TEXT,
                confidence REAL,
                home_win_probability REAL,
                draw_probability REAL,
                away_win_probability REAL,
                expected_score TEXT,
                result TEXT,
                settled_at INTEGER
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

            CREATE TABLE IF NOT EXISTS visual_context_cache (
                match_id TEXT PRIMARY KEY,
                screenshot_paths TEXT,
                article_ids TEXT,
                visual_confidence REAL DEFAULT 0,
                tiles TEXT,
                scores TEXT,
                query_text TEXT,
                enriched_at INTEGER,
                briefing TEXT
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
            CREATE INDEX IF NOT EXISTS idx_matches_status_startts ON matches(status, "startTimestamp");
            CREATE INDEX IF NOT EXISTS idx_matches_source ON matches(source);
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
                type TEXT DEFAULT 'LIVE',
                timestamp BIGINT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_odds_history_match_id ON odds_history(match_id);

            CREATE TABLE IF NOT EXISTS player_absences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL,
                side TEXT,
                team TEXT,
                player TEXT NOT NULL,
                position TEXT,
                status TEXT,
                detail TEXT,
                source TEXT DEFAULT 'sofascore',
                fetched_at BIGINT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(event_id, player, status)
            );
            CREATE INDEX IF NOT EXISTS idx_player_absences_event_id ON player_absences(event_id);

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

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'user',
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME
            );
        `)
    logger.info('🛡️ [DB] Tactical Schema validated with INDICES (SQLite)')
  } catch (e) {
    logger.error(`❌ [DB] Schema Init Failed: ${e.message}`)
  }
}

// ─── AUTO-MIGRATION: Add missing columns to existing DB ───────────────────────
function runMigrations(db) {
  // List of [table, column, type+default] to ensure exist
  const migrations = [
    ['matches', 'weather_temp', 'REAL'],
    ['matches', 'weather_desc', 'TEXT'],
    ['matches', 'weather_humidity', 'REAL'],
    ['matches', 'home_form_pts', 'REAL'],
    ['matches', 'away_form_pts', 'REAL'],
    ['matches', 'ev_home', 'REAL'],
    ['matches', 'ev_best', 'TEXT'],
    ['matches', 'xgboost_confidence', 'REAL DEFAULT 0'],
    ['users', 'password_hash', 'TEXT DEFAULT ""'],
    ['users', 'role', 'TEXT DEFAULT "user"'],
    ['users', 'is_active', 'INTEGER DEFAULT 1'],
    ['users', 'last_login', 'DATETIME'],
    ['matches', 'news_impact', 'REAL DEFAULT 0'],
    ['matches', 'ou_25_prob', 'REAL DEFAULT 0'],
    ['matches', 'btts_prob', 'REAL DEFAULT 0'],
    ['matches', 'odds_home', 'REAL'],
    ['matches', 'odds_draw', 'REAL'],
    ['matches', 'odds_away', 'REAL'],
    ['matches', 'home_win_probability', 'REAL DEFAULT 0'],
    ['matches', 'draw_probability', 'REAL DEFAULT 0'],
    ['matches', 'away_win_probability', 'REAL DEFAULT 0'],
    ['matches', 'expected_score', 'TEXT'],
    ['matches', 'chaos_score', 'INTEGER DEFAULT 50'],
    ['matches', 'insufficient_data', 'INTEGER DEFAULT 0'],
    // HT score + Corners FT/HT (extracted from Sofascore /incidents + /statistics)
    ['matches', 'ht_score_home', 'INTEGER'],
    ['matches', 'ht_score_away', 'INTEGER'],
    ['matches', 'corners_ht_home', 'INTEGER'],
    ['matches', 'corners_ht_away', 'INTEGER'],
    ['matches', 'source', 'TEXT'],
    ['matches', 'last_updated', 'INTEGER'],
    ['matches', 'startTimestamp', 'INTEGER'],
    ['matches', 'category_id', 'TEXT'],
    ['matches', 'category_name', 'TEXT'],
    ['matches', 'tournament_id', 'TEXT'],
    ['matches', 'tournament_name', 'TEXT'],
    ['matches', 'referee', 'TEXT'],
    ['matches', 'home_xg', 'REAL'],
    ['matches', 'away_xg', 'REAL'],
    ['matches', 'player_ratings_home', 'TEXT'],
    ['matches', 'player_ratings_away', 'TEXT'],
    ['matches', 'home_team_id', 'TEXT'],
    ['matches', 'away_team_id', 'TEXT'],
    ['matches', 'country_iso', 'TEXT'],
    ['matches', 'tournament_id_official', 'TEXT'],
    ['matches', 'home_attack_impact', 'REAL'],
    ['matches', 'home_defense_impact', 'REAL'],
    ['matches', 'away_attack_impact', 'REAL'],
    ['matches', 'away_defense_impact', 'REAL'],
    ['matches', 'referee_id', 'TEXT'],
    ['matches', 'referee_yellow_avg', 'REAL'],
    ['matches', 'referee_red_avg', 'REAL'],
    ['matches', 'referee_penalties_avg', 'REAL'],
    ['matches', 'odds_home_open', 'REAL'],
    ['matches', 'odds_draw_open', 'REAL'],
    ['matches', 'odds_away_open', 'REAL'],
    ['matches', 'news_sentiment', 'REAL'],
    ['matches', 'is_missing_gk', 'INTEGER'],
    ['matches', 'is_missing_scorer', 'INTEGER'],
    ['matches', 'is_missing_captain', 'INTEGER'],
    ['matches', 'is_missing_star', 'INTEGER'],
    ['matches', 'home_market_value', 'REAL'],
    ['matches', 'away_market_value', 'REAL'],
    ['matches', 'referee_home_win_rate', 'REAL'],
    ['matches', 'is_high_pressure', 'INTEGER'],
    ['matches', 'motivation_signature', 'TEXT'],
    ['matches', 'autopsy_result', 'TEXT'],
    ['matches', 'is_autopsied', 'INTEGER DEFAULT 0'],
    ['matches', 'bsd_match_id', 'TEXT'],
    ['matches', 'best_odds_home', 'REAL'],
    ['matches', 'best_odds_draw', 'REAL'],
    ['matches', 'best_odds_away', 'REAL'],
    ['matches', 'bsd_prediction', 'TEXT'],
    ['matches', 'bsd_home_win_prob', 'REAL DEFAULT 0'],
    ['matches', 'bsd_draw_prob', 'REAL DEFAULT 0'],
    ['matches', 'bsd_away_win_prob', 'REAL DEFAULT 0'],
    ['matches', 'bsd_confidence', 'REAL DEFAULT 0'],
    ['player_stats', 'xg_avg', 'REAL DEFAULT 0'],
    ['player_stats', 'xgot_avg', 'REAL DEFAULT 0'],
    ['player_stats', 'heatmap_danger', 'REAL DEFAULT 0'],
    ['matches', 'result', 'TEXT'],
    ['matches', 'settled_at', 'INTEGER'],
    ['matches', 'match_key', 'TEXT'],
    ['matches', 'market_type', 'TEXT'],
    ['matches', 'odds_fetch_error', 'TEXT'],
    ['matches', 'odds_source', 'TEXT'],
    ['matches', 'ev_draw', 'REAL'],
    ['matches', 'ev_away', 'REAL'],
    ['matches', 'kelly_stake', 'REAL'],
    ['matches', 'true_prob_home', 'REAL'],
    ['matches', 'true_prob_draw', 'REAL'],
    ['matches', 'true_prob_away', 'REAL'],
    ['matches', 'odds_over25', 'REAL'],
    ['matches', 'odds_under25', 'REAL'],
    ['matches', 'odds_btts_yes', 'REAL'],
    ['matches', 'odds_btts_no', 'REAL'],
    ['matches', 'absence_impact_pondéré', 'REAL DEFAULT 0'],
    ['odds_history', 'type', 'TEXT DEFAULT "LIVE"'],
    ['leagues_config', 'tier', 'TEXT DEFAULT "MENA"'],
    ['leagues_config', 'flag', 'TEXT DEFAULT ""'],
    ['leagues_config', 'country', 'TEXT DEFAULT ""'],
    ['leagues_config', 'displayName', 'TEXT DEFAULT ""'],
    ['leagues_config', 'smartScanEnabled', 'INTEGER DEFAULT 1'],
    ['leagues_config', 'webhookEnabled', 'INTEGER DEFAULT 1'],
    ['leagues_config', 'arabicNewsEnabled', 'INTEGER DEFAULT 0'],
    ['historical_matches', 'prediction', 'TEXT'],
    ['historical_matches', 'confidence', 'REAL'],
    ['historical_matches', 'home_win_probability', 'REAL'],
    ['historical_matches', 'draw_probability', 'REAL'],
    ['historical_matches', 'away_win_probability', 'REAL'],
    ['historical_matches', 'expected_score', 'TEXT'],
    ['historical_matches', 'result', 'TEXT'],
    ['historical_matches', 'settled_at', 'INTEGER'],
    ['visual_context_cache', 'briefing', 'TEXT'],
  ]

  let added = 0
  for (const [table, column, typeDef] of migrations) {
    try {
      // Check if column exists
      const cols = db.prepare(`PRAGMA table_info(${table})`).all()
      const exists = cols.some((c) => c.name === column)
      if (!exists) {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`).run()
        logger.info(`🔧 [DB MIGRATION] Added missing column: ${table}.${column}`)
        added++
      }
    } catch (e) {
      // Column may already exist or table doesn't exist yet — safe to ignore
      logger.warn(`⚠️ [DB MIGRATION] Could not add ${table}.${column}: ${e.message}`)
    }
  }
  if (added > 0) {
    logger.info(`✅ [DB MIGRATION] Applied ${added} column migration(s) successfully.`)
  } else {
    logger.info('✅ [DB MIGRATION] Schema is up-to-date, no migrations needed.')
  }
}

// ─── LEAGUES CONFIG SEED ─────────────────────────────────────────────
const LEAGUES_CONFIG_SEED = [
  [17, 'Premier League', 'ELITE', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'England', 'Premier League', 0],
  [8, 'LaLiga', 'ELITE', '🇪🇸', 'Spain', 'LaLiga', 0],
  [23, 'Serie A', 'ELITE', '🇮🇹', 'Italy', 'Serie A', 0],
  [35, 'Bundesliga', 'ELITE', '🇩🇪', 'Germany', 'Bundesliga', 0],
  [34, 'Ligue 1', 'ELITE', '🇫🇷', 'France', 'Ligue 1', 0],
  [238, 'Primeira Liga', 'TIER1', '🇵🇹', 'Portugal', 'Primeira Liga', 0],
  [37, 'Eredivisie', 'TIER1', '🇳🇱', 'Netherlands', 'Eredivisie', 0],
  [808, 'Egyptian Premier League', 'MENA', '🇪🇬', 'Egypt', 'Egyptian Premier League', 1],
  [955, 'Saudi Pro League', 'MENA', '🇸🇦', 'Saudi Arabia', 'Saudi Pro League', 1],
  [937, 'Botola Pro', 'MENA', '🇲🇦', 'Morocco', 'Botola Pro', 1],
  [984, 'Tunisian Ligue 1', 'MENA', '🇹🇳', 'Tunisia', 'Tunisian Ligue 1', 1],
  [841, 'Algerian Ligue 1', 'MENA', '🇩🇿', 'Algeria', 'Algerian Ligue 1', 1],
]

function seedLeaguesConfig(db) {
  if (!db) return
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO leagues_config
        (id, name, tier, active, flag, country, displayName, smartScanEnabled, webhookEnabled, arabicNewsEnabled)
      VALUES (?, ?, ?, 1, ?, ?, ?, 1, 1, ?)
    `)
    const runSeed = db.transaction(() => {
      for (const row of LEAGUES_CONFIG_SEED) insert.run(...row)
    })
    runSeed()
    const count = db.prepare('SELECT COUNT(*) AS n FROM leagues_config').get().n
    logger.info(`🎛️ [DB] leagues_config seeded: ${count} leagues (12 expected).`)
  } catch (e) {
    logger.error(`❌ [DB] leagues_config seed failed: ${e.message}`)
  }
}

module.exports = { initSchema, runMigrations, seedLeaguesConfig }
