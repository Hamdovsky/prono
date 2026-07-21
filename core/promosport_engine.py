"""
promosport_engine.py — Promosport prediction engine (standalone inference).
Uses the V553-enriched model for predictions.
"""
import os, sys, json, sqlite3
import numpy as np
import xgboost as xgb

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)
BASE_DIR = os.path.dirname(current_dir)

MODEL_PATH = os.path.join(BASE_DIR, 'models', 'promosport_v553_enriched.json')
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')

FEATURE_NAMES = [
    'home_win_rate_5', 'home_draw_rate_5', 'home_loss_rate_5',
    'away_win_rate_5', 'away_draw_rate_5', 'away_loss_rate_5',
    'home_win_rate_10', 'home_draw_rate_10', 'home_loss_rate_10',
    'away_win_rate_10', 'away_draw_rate_10', 'away_loss_rate_10',
    'home_win_rate_all', 'home_draw_rate_all', 'home_loss_rate_all',
    'away_win_rate_all', 'away_draw_rate_all', 'away_loss_rate_all',
    'vote_home', 'vote_draw', 'vote_away',
    'vote_home_norm', 'vote_draw_norm', 'vote_away_norm',
    'vote_advantage_home', 'vote_advantage_away',
    'h2h_home_wins', 'h2h_draws', 'h2h_away_wins', 'h2h_matches',
    'home_pts_per_match_10', 'away_pts_per_match_10',
    'home_pts_per_match_all', 'away_pts_per_match_all',
    'pts_diff_10', 'pts_diff_all',
    'home_avg_scored_5', 'home_avg_conceded_5',
    'away_avg_scored_5', 'away_avg_conceded_5',
    'home_avg_scored_10', 'home_avg_conceded_10',
    'away_avg_scored_10', 'away_avg_conceded_10',
    'home_form_score', 'away_form_score',
    'home_last_result', 'away_last_result',
    'home_matches_in_period', 'away_matches_in_period',
    'total_concours_for_pair',
    'form_diff', 'win_rate_diff_all', 'avg_scored_diff_10', 'avg_conceded_diff_10',
    'vote_x_home_form', 'vote_x_pts_diff', 'home_vote_x_winrate',
    'home_elo', 'away_elo', 'elo_diff',
    'home_win_streak', 'away_win_streak',
    'home_draw_streak', 'away_draw_streak',
    'home_loss_streak', 'away_loss_streak',
    'home_scoring_streak', 'away_scoring_streak',
    'home_clean_streak', 'away_clean_streak',
    'home_form_momentum', 'away_form_momentum',
    'home_form_trend', 'away_form_trend',
    'home_days_rest', 'away_days_rest',
    'home_recency_weighted_form', 'away_recency_weighted_form',
    'h2h_avg_goals', 'h2h_over25_rate',
    'home_momentum_vs_avg', 'away_momentum_vs_avg',
    'home_form_volatility', 'away_form_volatility',
]

_BOOSTER = None

def _load_model():
    global _BOOSTER
    if _BOOSTER is not None:
        return _BOOSTER
    if not os.path.exists(MODEL_PATH):
        return None
    _BOOSTER = xgb.Booster()
    _BOOSTER.load_model(MODEL_PATH)
    return _BOOSTER


def predict_match(match):
    """
    Predict a single match using the enriched promosport model.
    match: dict with homeTeam, awayTeam, optionally vote_home/vote_draw/vote_away
    Returns [home_prob, draw_prob, away_prob] or None
    """
    try:
        import scripts.train_promosport_v553_enriched as trainer
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row

        row = {
            'homeTeam': match.get('homeTeam', ''),
            'awayTeam': match.get('awayTeam', ''),
            'vote_home': match.get('vote_home', None),
            'vote_draw': match.get('vote_draw', None),
            'vote_away': match.get('vote_away', None),
            'archived_at': None,
        }

        features = trainer.extract_features(row, conn, [])
        vec = np.array([[features.get(k, 0.0) for k in FEATURE_NAMES]], dtype=np.float32)
        conn.close()

        booster = _load_model()
        if booster is None:
            return None

        dmat = xgb.DMatrix(vec)
        probs = booster.predict(dmat)[0]
        # Model outputs: [Away, Draw, Home]
        return [float(probs[2]), float(probs[1]), float(probs[0])]
    except Exception as e:
        print(f"[promosport_engine] Error: {e}", file=sys.stderr)
        return None
