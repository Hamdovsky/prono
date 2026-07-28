CREATE TABLE IF NOT EXISTS goal_model_parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_name TEXT NOT NULL,
  team_name TEXT,
  attack_rating REAL DEFAULT 0,
  defense_rating REAL DEFAULT 0,
  hfa REAL DEFAULT 0.25,
  rho REAL DEFAULT -0.12,
  mu REAL DEFAULT 0.13,
  gamma REAL DEFAULT 0.0,
  distribution_type TEXT DEFAULT 'poisson',
  num_matches INTEGER DEFAULT 0,
  model TEXT DEFAULT 'dixon_coles',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tournament_name, team_name)
);

CREATE INDEX IF NOT EXISTS idx_goal_model_tournament ON goal_model_parameters(tournament_name);
