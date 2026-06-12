const { getPool, usingPostgres, query } = require('./pg_connector')
const logger = require('./logger')

const SCHEMA_SQL = `
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
    is_autopsied INTEGER DEFAULT 0,
    bsd_match_id TEXT,
    best_odds_home REAL,
    best_odds_draw REAL,
    best_odds_away REAL,
    bsd_prediction TEXT,
    bsd_home_win_prob REAL DEFAULT 0,
    bsd_draw_prob REAL DEFAULT 0,
    bsd_away_win_prob REAL DEFAULT 0,
    bsd_confidence REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prediction_history (
    id SERIAL PRIMARY KEY,
    match_id TEXT,
    league TEXT,
    prediction_type TEXT,
    prediction_val TEXT,
    probability REAL,
    status TEXT DEFAULT 'PENDING',
    result TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(match_id, prediction_type)
);

CREATE TABLE IF NOT EXISTS quant_performance (
    id SERIAL PRIMARY KEY,
    match_id TEXT,
    taken_odds REAL,
    closing_odds REAL,
    clv REAL,
    pnl REAL,
    stake REAL,
    ev_at_bet REAL,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leagues_config (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE,
    tier INTEGER DEFAULT 3,
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS league_challenger_weights (
    league TEXT PRIMARY KEY,
    weights TEXT NOT NULL,
    accuracy REAL DEFAULT 0.0,
    total_cases INTEGER DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS league_performance_tracking (
    id SERIAL PRIMARY KEY,
    league TEXT NOT NULL,
    match_id TEXT NOT NULL,
    champ_result TEXT,
    chall_result TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(league, match_id)
);

CREATE TABLE IF NOT EXISTS team_key_players (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    rating REAL DEFAULT 7.0,
    goals INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    importance REAL DEFAULT 1.0,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(team_id, player_id)
);

CREATE TABLE IF NOT EXISTS match_lineups (
    match_id TEXT PRIMARY KEY,
    home_lineup TEXT,
    away_lineup TEXT,
    status TEXT DEFAULT 'FETCHED',
    timestamp TIMESTAMPTZ DEFAULT NOW()
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
    archived_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS winning_patterns (
    id SERIAL PRIMARY KEY,
    match_id TEXT,
    league TEXT,
    homeTeam TEXT,
    awayTeam TEXT,
    prediction TEXT,
    result TEXT,
    score TEXT,
    fullData TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_registry (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    normalized TEXT NOT NULL,
    league TEXT,
    last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS idx_team_registry_normalized ON team_registry(normalized);

CREATE TABLE IF NOT EXISTS player_stats (
    player_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    team_name TEXT,
    position TEXT,
    goals INTEGER DEFAULT 0,
    shots_on_target_avg REAL DEFAULT 0,
    yellow_cards INTEGER DEFAULT 0,
    red_cards INTEGER DEFAULT 0,
    rating_avg REAL DEFAULT 0,
    xg_avg REAL DEFAULT 0,
    xgot_avg REAL DEFAULT 0,
    heatmap_danger REAL DEFAULT 0,
    last_updated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_player_stats_team ON player_stats(team_name);

CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);
CREATE INDEX IF NOT EXISTS idx_history_match_id ON prediction_history(match_id);
CREATE INDEX IF NOT EXISTS idx_patterns_league ON winning_patterns(league);

CREATE TABLE IF NOT EXISTS odds_history (
    id SERIAL PRIMARY KEY,
    match_id TEXT NOT NULL,
    minute INTEGER DEFAULT 0,
    odds_home REAL,
    odds_draw REAL,
    odds_away REAL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_odds_history_match_id ON odds_history(match_id);

CREATE TABLE IF NOT EXISTS odds_patterns (
    id SERIAL PRIMARY KEY,
    pattern_hash TEXT UNIQUE NOT NULL,
    pattern_type TEXT NOT NULL,
    movement_profile TEXT NOT NULL,
    occurrences INTEGER DEFAULT 1,
    win_rate_home REAL DEFAULT 0,
    win_rate_draw REAL DEFAULT 0,
    win_rate_away REAL DEFAULT 0,
    avg_total_goals REAL DEFAULT 0,
    confidence REAL DEFAULT 0,
    last_seen BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_prediction_logs (
    id SERIAL PRIMARY KEY,
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
    actual_goal_next5 INTEGER,
    actual_goal_next10 INTEGER,
    actual_goal_next15 INTEGER,
    actual_goal_minute INTEGER,
    actual_scored_by TEXT,
    actual_final_home INTEGER,
    actual_final_away INTEGER,
    outcome_checked INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    checked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_live_logs_match ON live_prediction_logs(match_id);
CREATE INDEX IF NOT EXISTS idx_live_logs_checked ON live_prediction_logs(outcome_checked);
`

async function runMigrations() {
  if (!usingPostgres()) {
    logger.info('[PG MIGRATIONS] Skipping — using SQLite')
    return { applied: 0, skipped: true }
  }

  try {
    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query(SCHEMA_SQL)
      logger.info('[PG MIGRATIONS] Full schema applied successfully')
    } finally {
      client.release()
    }

    try {
      const missingCols = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'matches' AND column_name = 'bsd_match_id'
      `)
      if (missingCols.rows.length === 0) {
        logger.info('[PG MIGRATIONS] Adding missing columns to matches table...')
        const addCol = (name, type) => query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS "${name}" ${type}`).catch(e => logger.warn(`[PG MIGRATIONS] Could not add ${name}: ${e.message}`))
        await addCol('tournament_id_official', 'TEXT')
        await addCol('home_attack_impact', 'REAL')
        await addCol('home_defense_impact', 'REAL')
        await addCol('away_attack_impact', 'REAL')
        await addCol('away_defense_impact', 'REAL')
        await addCol('referee_id', 'TEXT')
        await addCol('referee_yellow_avg', 'REAL')
        await addCol('referee_red_avg', 'REAL')
        await addCol('referee_penalties_avg', 'REAL')
        await addCol('odds_home_open', 'REAL')
        await addCol('odds_draw_open', 'REAL')
        await addCol('odds_away_open', 'REAL')
        await addCol('true_prob_home', 'REAL')
        await addCol('true_prob_draw', 'REAL')
        await addCol('true_prob_away', 'REAL')
        await addCol('true_prob_ou25', 'REAL')
        await addCol('true_prob_btts', 'REAL')
        await addCol('ev_draw', 'REAL')
        await addCol('ev_away', 'REAL')
        await addCol('clv_value', 'REAL')
        await addCol('kelly_stake', 'REAL')
        await addCol('news_sentiment', 'REAL')
        await addCol('is_missing_gk', 'INTEGER')
        await addCol('is_missing_scorer', 'INTEGER')
        await addCol('is_missing_captain', 'INTEGER')
        await addCol('is_missing_star', 'INTEGER')
        await addCol('home_market_value', 'REAL')
        await addCol('away_market_value', 'REAL')
        await addCol('referee_home_win_rate', 'REAL')
        await addCol('is_high_pressure', 'INTEGER')
        await addCol('motivation_signature', 'TEXT')
        await addCol('autopsy_result', 'TEXT')
        await addCol('is_autopsied', 'INTEGER DEFAULT 0')
        await addCol('bsd_match_id', 'TEXT')
        await addCol('best_odds_home', 'REAL')
        await addCol('best_odds_draw', 'REAL')
        await addCol('best_odds_away', 'REAL')
        await addCol('bsd_prediction', 'TEXT')
        await addCol('bsd_home_win_prob', 'REAL DEFAULT 0')
        await addCol('bsd_draw_prob', 'REAL DEFAULT 0')
        await addCol('bsd_away_win_prob', 'REAL DEFAULT 0')
        await addCol('bsd_confidence', 'REAL DEFAULT 0')
        logger.info('[PG MIGRATIONS] Missing columns added successfully')
      }
    } catch (e) {
      logger.warn(`[PG MIGRATIONS] Column check skipped: ${e.message}`)
    }

    // Backfill startTimestamp from "fullData" for rows where it's NULL (column name is case-sensitive)
    try {
      const backfillResult = await query(`
        UPDATE matches SET "startTimestamp" = SUBSTRING("fullData" FROM '"startTimestamp":([0-9]+)')::bigint
        WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL AND "fullData" ~ '"startTimestamp":[0-9]+'
      `)
      if (backfillResult.rowCount > 0) {
        logger.info(`[PG MIGRATIONS] Backfilled startTimestamp for ${backfillResult.rowCount} rows`)
      }
    } catch (e) {
      logger.warn(`[PG MIGRATIONS] startTimestamp backfill skipped: ${e.message}`)
    }

    return { applied: 1, skipped: false }
  } catch (err) {
    logger.error(`[PG MIGRATIONS] Failed: ${err.message}`)
    return { applied: 0, skipped: false, error: err.message }
  }
}

module.exports = { runMigrations, SCHEMA_SQL }
