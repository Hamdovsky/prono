-- PostgreSQL + TimescaleDB Schema for Titanium AI
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- A) event_log (Append-only event sourcing table)
CREATE TABLE IF NOT EXISTS event_log (
    event_id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    aggregate_id VARCHAR(100) NOT NULL, -- The match_id or team_id this event relates to
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_log_agg_time ON event_log(aggregate_id, created_at DESC);

-- B) matches_history (Temporal version of matches)
CREATE TABLE IF NOT EXISTS matches_history (
    id BIGSERIAL PRIMARY KEY,
    match_id VARCHAR(100) NOT NULL,
    home_team VARCHAR(100) NOT NULL,
    away_team VARCHAR(100) NOT NULL,
    league VARCHAR(100),
    status VARCHAR(50) NOT NULL,
    home_score INT DEFAULT 0,
    away_score INT DEFAULT 0,
    match_timestamp TIMESTAMPTZ NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to TIMESTAMPTZ DEFAULT '9999-12-31 23:59:59',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_matches_history_match_id ON matches_history(match_id, valid_from DESC);
CREATE INDEX idx_matches_history_time ON matches_history(match_timestamp DESC);

-- C) odds_ticks (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS odds_ticks (
    match_id VARCHAR(100) NOT NULL,
    bookmaker_id VARCHAR(50) DEFAULT 'Pinnacle',
    market_type VARCHAR(50) NOT NULL,
    home_odds DECIMAL(6,3),
    draw_odds DECIMAL(6,3),
    away_odds DECIMAL(6,3),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Create hypertable partitioned by recorded_at chunked into 7 days
SELECT create_hypertable('odds_ticks', 'recorded_at', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX idx_odds_ticks_match_id ON odds_ticks(match_id, recorded_at DESC);
-- BRIN index on recorded_at for fast time-range queries on large datasets
CREATE INDEX idx_odds_ticks_brin ON odds_ticks USING brin(recorded_at);

-- D) team_stats_snapshots (Temporal snapshots of statistics)
CREATE TABLE IF NOT EXISTS team_stats_snapshots (
    snapshot_id BIGSERIAL PRIMARY KEY,
    team_id VARCHAR(100) NOT NULL,
    match_id VARCHAR(100),
    rolling_xg DECIMAL(5,2),
    rolling_possession DECIMAL(5,2),
    rolling_shots_on_target DECIMAL(5,2),
    raw_stats JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_team_stats_team_time ON team_stats_snapshots(team_id, recorded_at DESC);
