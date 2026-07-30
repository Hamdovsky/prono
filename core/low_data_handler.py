"""
low_data_handler.py — Zero-Data Bayesian handler for Club Friendlies, Cups, etc.
Integrates directly into prediction_engine.py as a pre-fail-fast rescue layer.

Pipeline:
  1. Detect low-data condition (no team history, unknown league, friendly/cup)
  2. Bayesian Hierarchical inference via penaltyblog (league-wide priors)
  3. Implied probabilities from bookmaker odds (if available)
  4. League category priors (hardcoded averages)
  5. Blend into a complete 1X2/BTTS/OU prediction
"""
import sys, os, logging

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'services'))

log = logging.getLogger('LowData')

_LOW_DATA_ENGINE = None


def _get_engine():
    global _LOW_DATA_ENGINE
    if _LOW_DATA_ENGINE is not None:
        return _LOW_DATA_ENGINE
    try:
        from penaltyblog_engine import BayesianLowDataHandler
        _LOW_DATA_ENGINE = BayesianLowDataHandler()
    except Exception as e:
        log.warning(f'Failed to load BayesianLowDataHandler: {e}')
        _LOW_DATA_ENGINE = False
    return _LOW_DATA_ENGINE


def is_low_data_scenario(match_obj):
    """Detect if a match qualifies as zero/low-data scenario."""
    league = str(match_obj.get('league', match_obj.get('tournament_name', ''))).lower()
    league_tier = str(match_obj.get('_league_tier', '')).lower()

    if league_tier == 'blacklist':
        return False

    h_hist = match_obj.get('_h_hist_len', 0)
    a_hist = match_obj.get('_a_hist_len', 0)
    data_completeness = match_obj.get('data_completeness', 0)

    is_friendly = any(k in league for k in ['friendly', 'friendlies', 'club friendly'])
    is_cup = any(k in league for k in ['cup', 'qualification', 'play-off'])
    is_unknown = league_tier == 'unknown'
    no_history = h_hist < 3 or a_hist < 3
    low_data = data_completeness < 15

    return (is_friendly or (is_unknown and no_history) or (is_cup and low_data))


def predict_low_data(match_obj):
    """Predict a low-data match using Bayesian Hierarchical + Implied Odds.

    Returns a complete prediction dict compatible with prediction_engine output,
    or None if prediction is not possible.
    """
    engine = _get_engine()
    if not engine:
        return None

    home = match_obj.get('homeTeam', match_obj.get('home_team', ''))
    away = match_obj.get('awayTeam', match_obj.get('away_team', ''))
    league = match_obj.get('league', match_obj.get('tournament_name', 'Unknown'))

    if not home or not away:
        return None

    bookmaker_odds = None
    odds_h = match_obj.get('odds_home') or match_obj.get('best_odds_home')
    odds_d = match_obj.get('odds_draw') or match_obj.get('best_odds_draw')
    odds_a = match_obj.get('odds_away') or match_obj.get('best_odds_away')

    if odds_h and odds_d and odds_a:
        try:
            bookmaker_odds = [float(odds_h), float(odds_d), float(odds_a)]
        except (ValueError, TypeError):
            pass

    result = engine.predict_zero_data(home, away, league, bookmaker_odds)
    if not result.get('success'):
        return None

    return {
        'success': True,
        'home_win': result['home_win'],
        'draw': result['draw'],
        'away_win': result['away_win'],
        'home_xg': result['home_xg'],
        'away_xg': result['away_xg'],
        'btts_yes': result['btts_yes'],
        'btts_no': result['btts_no'],
        'over_25': result['over_25'],
        'under_25': result['under_25'],

        'predicted_home_goals': round(result['home_xg'], 1),
        'predicted_away_goals': round(result['away_xg'], 1),

        'confidence': 30 if result.get('is_low_data') else 45,

        'prediction_source': f'low_data_{result["model"]}',
        'is_low_data_prediction': True,
        'model_used': result['model'],
        'league_prior_source': result.get('prior_source', 'default'),

        'analysis': {
            'method': f'Low-data Bayesian ({result["model"]})',
            'league': league,
            'zero_data_rescue': True,
        },
    }
