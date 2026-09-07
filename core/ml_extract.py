# -*- coding: utf-8 -*-
"""extract_ml_features (V55 complet) + extract_v56_features.
Extrait de ml_features.py (split 2026-09-07) — le _f dupliqué (ex-ligne 2025)
a été supprimé : le _f de ml_history, strictement identique, le remplace."""
import json
import os
import math
import functools

from ml_history import (
    _f, parse_pct, load_json, ELO_RATINGS, TEAM_STYLES,
    DB_ARCHIVE_PATH, DB_TACTICAL_PATH, ELO_PATH, STYLES_PATH,
    using_postgres, get_pg_connection, pg_query, get_league_params,
    get_db_connection, close_db_connection, extract_features_from_stats,
    get_wc2026_team_data, _load_xg_models, _predict_xg_h, _predict_xg_a,
    _get_team_history_pg, _get_team_history_master, get_team_history,
    calculate_rolling_averages, calculate_glicko_momentum,
    get_detailed_team_style, get_rolling_team_style, get_match_motivation_context,
    is_derby_match, _compute_streak, _hist_rate, _get_h2h_advanced_pg,
    get_h2h_advanced, calculate_data_completeness, calculate_momentum_trend,
    calculate_cumulative_fatigue, calculate_injury_impact, calculate_motivation,
    get_tactical_synergy, calculate_travel_fatigue,
)
from ml_tunisian import extract_tunisian_features
from ml_feature_names import VISUAL_FEATURE_NAMES

def extract_ml_features(row, fetch_history=True, current_match_ts=None):
    features = {}
    
    home_name = row.get('homeTeam', 'Home')
    away_name = row.get('awayTeam', 'Away')
    _league_name = row.get('league', '') or row.get('tournament_name', '')

    # 0. Elo Ratings
    features['home_elo'] = _f(ELO_RATINGS.get(home_name), 1500)
    features['away_elo'] = _f(ELO_RATINGS.get(away_name), 1500)
    features['elo_diff'] = features['home_elo'] - features['away_elo']

    # 1. Motivation (ULTRA)
    form_ctx = row.get('form_context')
    if not form_ctx: form_ctx = {}
    if isinstance(form_ctx, str):
        try: form_ctx = json.loads(form_ctx)
        except: form_ctx = {}
    if not isinstance(form_ctx, dict): form_ctx = {}
    
    h_form = form_ctx.get('home') or {}
    a_form = form_ctx.get('away') or {}
    
    features['home_motivation'] = calculate_motivation(h_form.get('standing'))
    features['away_motivation'] = calculate_motivation(a_form.get('standing'))

    # 2. Tactical Synergy (ULTRA)
    features['tactical_synergy'] = get_tactical_synergy(home_name, away_name)

    # 3. Squad Depth (ULTRA)
    news_data = row.get('news_data')
    features['home_injury_impact'] = calculate_injury_impact(news_data, home_name)
    features['away_injury_impact'] = calculate_injury_impact(news_data, away_name)

    # 4. Momentum (Rolling Averages)
    if fetch_history:
        h_hist = get_team_history(home_name, limit=20, current_match_ts=current_match_ts)
        a_hist = get_team_history(away_name, limit=20, current_match_ts=current_match_ts)
    else:
        h_hist = row.get('history_home', [])
        a_hist = row.get('history_away', [])

    h_roll_g3, h_roll_p3 = calculate_rolling_averages(h_hist, window=3, league_name=_league_name)
    a_roll_g3, a_roll_p3 = calculate_rolling_averages(a_hist, window=3, league_name=_league_name)
    features['home_momentum_goals'] = h_roll_g3
    features['home_momentum_points'] = h_roll_p3
    features['away_momentum_goals'] = a_roll_g3
    features['away_momentum_points'] = a_roll_p3
    
    # 5. Cumulative Fatigue (ULTRA)
    if fetch_history:
        features['h_fatigue_cumulative'] = calculate_cumulative_fatigue(h_hist)
        features['a_fatigue_cumulative'] = calculate_cumulative_fatigue(a_hist)
    else:
        features['h_fatigue_cumulative'] = 1.0
        features['a_fatigue_cumulative'] = 1.0
    
    # V13 Advanced Momentum
    features['home_glicko_momentum'] = calculate_glicko_momentum(h_hist)
    features['away_glicko_momentum'] = calculate_glicko_momentum(a_hist)
    # Fallback to teamStats if history is empty (early season)
    team_stats_raw = row.get('teamStats')
    if team_stats_raw is None: team_stats_raw = '{}'
    
    try:
        ts = json.loads(team_stats_raw) if isinstance(team_stats_raw, str) else team_stats_raw
    except:
        ts = {}
        
    if not isinstance(ts, dict): ts = {}
    ts_h = ts.get('home') if isinstance(ts.get('home'), dict) else {}
    ts_a = ts.get('away') if isinstance(ts.get('away'), dict) else {}

    # [V54 ROW-LEVEL FALLBACK] Inject archive columns into ts_h/ts_a
    # so _get_avg_hist / _get_decayed_avg find real values when teamStats missing
    _ROW_FALLBACK = {
        'avgPossession':       ('home_possession', 'away_possession'),
        'avgShots':            ('home_shots', 'away_shots'),
        'avgShotsOnTarget':    ('home_shots_on_target', 'away_shots_on_target'),
        'avgShotsOffTarget':   ('home_shots_off', 'away_shots_off'),
        'avgCorners':          ('home_corners', 'away_corners'),
        'avgFouls':            ('home_fouls', 'away_fouls'),
        'expectedGoals':       ('home_xg', 'away_xg'),
        'goalsAgainst':        ('home_goals_conceded', 'away_goals_conceded'),
    }
    for ts_key, (h_col, a_col) in _ROW_FALLBACK.items():
        if ts_key not in ts_h:
            try:
                v = row.get(h_col)
                if v is not None: ts_h[ts_key] = float(v)
            except: pass
        if ts_key not in ts_a:
            try:
                v = row.get(a_col)
                if v is not None: ts_a[ts_key] = float(v)
            except: pass

    def _resolve_key(hist, key):
        """Try both title-case (teamStats list format) and snake_case (stats_blob dict format)."""
        if isinstance(hist, list) and len(hist) > 0 and isinstance(hist[0], dict):
            if key in hist[0]:
                return key
            snake = key.lower().replace(' ', '_').replace("'", '').replace('-', '_')
            if snake in hist[0]:
                return snake
        return key

    def _get_avg_hist(hist, key, ts_dict, ts_key, default=0.0):
        # Extracts from history arrays, falling back to team season stats if history fails
        resolved = _resolve_key(hist, key)
        if isinstance(hist, list) and len(hist) > 0 and isinstance(hist[0], dict) and resolved in hist[0]:
            vals = [m.get(resolved, default) for m in hist if isinstance(m, dict)]
            return sum(vals)/len(vals) if vals else default
        
        # Safe access to ts_dict
        if isinstance(ts_dict, dict):
            try:
                return float(ts_dict.get(ts_key, default))
            except (ValueError, TypeError):
                return float(default)
        return float(default)

    def _get_decayed_avg(hist, key, ts_dict, ts_key, default=0.0, alpha=0.20):
        """Time-decayed weighted average — recent matches matter more."""
        resolved = _resolve_key(hist, key)
        if isinstance(hist, list) and len(hist) > 0 and isinstance(hist[0], dict) and resolved in hist[0]:
            vals = [m.get(resolved, default) for m in hist if isinstance(m, dict)]
            if not vals: return default
            weights = [math.pow(1 - alpha, i) for i in range(len(vals))]
            tw = sum(weights)
            if tw == 0: return sum(vals) / len(vals)
            return sum(v * w for v, w in zip(vals, weights)) / tw
        if isinstance(ts_dict, dict):
            try:
                return float(ts_dict.get(ts_key, default))
            except:
                return float(default)
        return float(default)

    # 🌍 [STITCH V19 TITANIUM] Expanded Micro-Statistics (115+ Variables)
    # This section extracts deep tactical metrics for advanced pattern recognition.
    
    def _get_dual_stat(feat_dict, cat, ts_dict, ts_key, default=0.0):
        h = _get_avg_hist(h_hist, f'{cat}_home', ts_h, ts_key, default)
        a = _get_avg_hist(a_hist, f'{cat}_away', ts_a, ts_key, default)
        diff = h - a
        return h, a, diff

    # 1. Possession & Precision
    features['h_pos'], features['a_pos'], features['pos_diff'] = _get_dual_stat(features, 'Ball possession', ts_h, 'avgPossession', 50.0)
    features['h_pass_acc'], features['a_pass_acc'], features['pass_acc_diff'] = _get_dual_stat(features, 'Accurate passes', ts_h, 'passAccuracyPct', 80.0)
    
    # 2. Attack Dynamics
    h_xg_raw = row.get('home_xg') or ts_h.get('expectedGoals')
    a_xg_raw = row.get('away_xg') or ts_a.get('expectedGoals')
    if not h_xg_raw:
        h_xg_raw = _predict_xg_h(row, ts_h)
    if not a_xg_raw:
        a_xg_raw = _predict_xg_a(row, ts_a)
    features['h_xg'] = _f(h_xg_raw, 1.0)
    features['a_xg'] = _f(a_xg_raw, 1.0)
    features['xg_diff'] = features['h_xg'] - features['a_xg']
    features['h_bc'], features['a_bc'], features['bc_diff'] = _get_dual_stat(features, 'Big chances', ts_h, 'avgBigChances', 1.5)
    features['h_sot'], features['a_sot'], features['sot_diff'] = _get_dual_stat(features, 'Shots on target', ts_h, 'avgShotsOnTarget', 4.0)
    features['h_shots_off'], features['a_shots_off'], _ = _get_dual_stat(features, 'Shots off target', ts_h, 'avgShotsOffTarget', 5.0)
    features['h_inner_shots'], features['a_inner_shots'], _ = _get_dual_stat(features, 'Shots from inside box', ts_h, 'avgShotsInsideBox', 6.0)

    # 3. Defensive & Disruptive
    features['h_int'], features['a_int'], features['int_diff'] = _get_dual_stat(features, 'Interceptions', ts_h, 'avgInterceptions', 10.0)
    features['h_tackles'], features['a_tackles'], features['tackles_diff'] = _get_dual_stat(features, 'Tackles', ts_h, 'avgTackles', 15.0)
    features['h_clear'], features['a_clear'], features['clear_diff'] = _get_dual_stat(features, 'Clearances', ts_h, 'avgClearances', 18.0)
    features['h_def_err'], features['a_def_err'], _ = _get_dual_stat(features, 'Errors leading to goal', ts_h, 'errorsLeadingToGoal', 0.0)
    features['h_saves'], features['a_saves'], _ = _get_dual_stat(features, 'Goalkeeper saves', ts_h, 'avgSaves', 3.0)

    # 4. Duel & Physicality
    features['h_ground_won'], features['a_ground_won'], _ = _get_dual_stat(features, 'Ground duels won', ts_h, 'avgGroundDuelsWon', 40.0)
    features['h_aerial_won'], features['a_aerial_won'], _ = _get_dual_stat(features, 'Aerial duels won', ts_h, 'avgAerialDuelsWon', 15.0)
    features['h_poss_lost'], features['a_poss_lost'], features['lost_diff'] = _get_dual_stat(features, 'Possession lost', ts_h, 'avgPossessionLost', 130.0)

    # 5. Discipline & Set Pieces
    features['h_corners'], features['a_corners'], features['corner_diff'] = _get_dual_stat(features, 'Corner kicks', ts_h, 'avgCorners', 4.5)
    features['h_fouls'], features['a_fouls'], features['foul_diff'] = _get_dual_stat(features, 'Fouls', ts_h, 'avgFouls', 12.0)
    h_y = _get_avg_hist(h_hist, 'Yellow cards_home', ts_h, 'avgYellowCards', 2.0)
    a_y = _get_avg_hist(a_hist, 'Yellow cards_away', ts_a, 'avgYellowCards', 2.0)
    features['h_cards'], features['a_cards'] = h_y, a_y

    # 6. Stylistic & Momentum (V13/V19 Fusion)
    # V55 FIX: Use rolling window of last 5 matches for style detection (single match too noisy)
    h_style_matches = h_hist[:5] if h_hist else []
    a_style_matches = a_hist[:5] if a_hist else []
    h_style = get_rolling_team_style(h_style_matches)
    a_style = get_rolling_team_style(a_style_matches)
    _STYLE_MAP = {"Balanced": 0, "Possession": 1, "Counter-Attack": 2, "High Press": 3, "Low Block": 4}
    features['h_style_enc'] = _STYLE_MAP.get(h_style, 0)
    features['a_style_enc'] = _STYLE_MAP.get(a_style, 0)
    features['h_mom_gicko'] = calculate_glicko_momentum(h_hist)
    features['a_mom_gicko'] = calculate_glicko_momentum(a_hist)

    # 6b. V53 SofaScore Advanced Stats (already in teamStats, time-decayed)
    features['h_successful_dribbles'] = _get_decayed_avg(h_hist, 'Successful dribbles_home', ts_h, 'avgSuccessfulDribbles', 5.0)
    features['a_successful_dribbles'] = _get_decayed_avg(a_hist, 'Successful dribbles_away', ts_a, 'avgSuccessfulDribbles', 5.0)
    features['h_accurate_long_balls'] = _get_decayed_avg(h_hist, 'Accurate long balls_home', ts_h, 'avgAccurateLongBalls', 15.0)
    features['a_accurate_long_balls'] = _get_decayed_avg(a_hist, 'Accurate long balls_away', ts_a, 'avgAccurateLongBalls', 15.0)
    features['h_accurate_crosses'] = _get_decayed_avg(h_hist, 'Accurate crosses_home', ts_h, 'avgAccurateCrosses', 3.0)
    features['a_accurate_crosses'] = _get_decayed_avg(a_hist, 'Accurate crosses_away', ts_a, 'avgAccurateCrosses', 3.0)
    features['h_opp_half_passes'] = _get_decayed_avg(h_hist, 'Opposition half passes_home', ts_h, 'avgOppositionHalfPasses', 150.0)
    features['a_opp_half_passes'] = _get_decayed_avg(a_hist, 'Opposition half passes_away', ts_a, 'avgOppositionHalfPasses', 150.0)
    features['h_duels_won_pct'] = _get_decayed_avg(h_hist, 'Duels won percentage_home', ts_h, 'duelsWonPct', 50.0)
    features['a_duels_won_pct'] = _get_decayed_avg(a_hist, 'Duels won percentage_away', ts_a, 'duelsWonPct', 50.0)
    features['h_errors_leading_to_shot'] = _get_decayed_avg(h_hist, 'Errors leading to shot_home', ts_h, 'errorsLeadingToShot', 0.5)
    features['a_errors_leading_to_shot'] = _get_decayed_avg(a_hist, 'Errors leading to shot_away', ts_a, 'errorsLeadingToShot', 0.5)

    # 6c. V54 Enhanced Passing Detail
    features['h_accurate_opp_half_passes'] = _get_decayed_avg(h_hist, 'Accurate opposition half passes_home', ts_h, 'avgAccurateOppositionHalfPasses', 80.0)
    features['a_accurate_opp_half_passes'] = _get_decayed_avg(a_hist, 'Accurate opposition half passes_away', ts_a, 'avgAccurateOppositionHalfPasses', 80.0)
    features['h_opp_half_pass_pct'] = _get_decayed_avg(h_hist, 'Accurate opposition half passes percentage_home', ts_h, 'accurateOppositionHalfPassesPct', 80.0)
    features['a_opp_half_pass_pct'] = _get_decayed_avg(a_hist, 'Accurate opposition half passes percentage_away', ts_a, 'accurateOppositionHalfPassesPct', 80.0)
    features['h_acc_own_half_passes'] = _get_decayed_avg(h_hist, 'Accurate own half passes_home', ts_h, 'avgAccurateOwnHalfPasses', 150.0)
    features['a_acc_own_half_passes'] = _get_decayed_avg(a_hist, 'Accurate own half passes_away', ts_a, 'avgAccurateOwnHalfPasses', 150.0)
    features['h_long_ball_pct'] = _get_decayed_avg(h_hist, 'Accurate long balls percentage_home', ts_h, 'accurateLongBallsPct', 50.0)
    features['a_long_ball_pct'] = _get_decayed_avg(a_hist, 'Accurate long balls percentage_away', ts_a, 'accurateLongBallsPct', 50.0)
    features['h_cross_pct'] = _get_decayed_avg(h_hist, 'Accurate crosses percentage_home', ts_h, 'accurateCrossesPct', 25.0)
    features['a_cross_pct'] = _get_decayed_avg(a_hist, 'Accurate crosses percentage_away', ts_a, 'accurateCrossesPct', 25.0)

    # 6d. V54 Ground & Aerial Duel Detail
    features['h_ground_duels_won'] = _get_decayed_avg(h_hist, 'Ground duels won_home', ts_h, 'avgGroundDuelsWon', 20.0)
    features['a_ground_duels_won'] = _get_decayed_avg(a_hist, 'Ground duels won_away', ts_a, 'avgGroundDuelsWon', 20.0)
    features['h_ground_duel_pct'] = _get_decayed_avg(h_hist, 'Ground duels won percentage_home', ts_h, 'groundDuelsWonPct', 50.0)
    features['a_ground_duel_pct'] = _get_decayed_avg(a_hist, 'Ground duels won percentage_away', ts_a, 'groundDuelsWonPct', 50.0)
    features['h_aerial_duel_pct'] = _get_decayed_avg(h_hist, 'Aerial duels won percentage_home', ts_h, 'aerialDuelsWonPct', 50.0)
    features['a_aerial_duel_pct'] = _get_decayed_avg(a_hist, 'Aerial duels won percentage_away', ts_a, 'aerialDuelsWonPct', 50.0)
    features['h_total_duels'] = _get_decayed_avg(h_hist, 'Total duels_home', ts_h, 'avgTotalDuels', 40.0)
    features['a_total_duels'] = _get_decayed_avg(a_hist, 'Total duels_away', ts_a, 'avgTotalDuels', 40.0)

    # 6e. V54 Ball Recovery & Blocks
    features['h_ball_recovery'] = _get_decayed_avg(h_hist, 'Ball recovery_home', ts_h, 'avgBallRecovery', 20.0)
    features['a_ball_recovery'] = _get_decayed_avg(a_hist, 'Ball recovery_away', ts_a, 'avgBallRecovery', 20.0)
    features['h_blocked_shots'] = _get_decayed_avg(h_hist, 'Blocked scoring attempt_home', ts_h, 'avgBlockedScoringAttempt', 3.0)
    features['a_blocked_shots'] = _get_decayed_avg(a_hist, 'Blocked scoring attempt_away', ts_a, 'avgBlockedScoringAttempt', 3.0)
    features['h_assists'] = _get_decayed_avg(h_hist, 'Assists_home', ts_h, 'avgAssists', 1.5)
    features['a_assists'] = _get_decayed_avg(a_hist, 'Assists_away', ts_a, 'avgAssists', 1.5)

    # 6f. V54 Defensive "Against" (opponent perspective — how much pressure a team faces)
    features['h_shots_faced'] = _get_decayed_avg(h_hist, 'Shots against_home', ts_h, 'avgShotsAgainst', 10.0)
    features['a_shots_faced'] = _get_decayed_avg(a_hist, 'Shots against_away', ts_a, 'avgShotsAgainst', 10.0)
    features['h_sot_faced'] = _get_decayed_avg(h_hist, 'Shots on target against_home', ts_h, 'avgShotsOnTargetAgainst', 4.0)
    features['a_sot_faced'] = _get_decayed_avg(a_hist, 'Shots on target against_away', ts_a, 'avgShotsOnTargetAgainst', 4.0)
    features['h_bc_conceded'] = _get_decayed_avg(h_hist, 'Big chances against_home', ts_h, 'avgBigChancesAgainst', 2.0)
    features['a_bc_conceded'] = _get_decayed_avg(a_hist, 'Big chances against_away', ts_a, 'avgBigChancesAgainst', 2.0)
    features['h_key_passes_allowed'] = _get_decayed_avg(h_hist, 'Key passes against_home', ts_h, 'avgKeyPassesAgainst', 5.0)
    features['a_key_passes_allowed'] = _get_decayed_avg(a_hist, 'Key passes against_away', ts_a, 'avgKeyPassesAgainst', 5.0)
    features['h_corners_conceded'] = _get_decayed_avg(h_hist, 'Corners against_home', ts_h, 'avgCornersAgainst', 5.0)
    features['a_corners_conceded'] = _get_decayed_avg(a_hist, 'Corners against_away', ts_a, 'avgCornersAgainst', 5.0)
    features['h_dribbles_allowed'] = _get_decayed_avg(h_hist, 'Dribble attempts won against_home', ts_h, 'avgDribbleAttemptsWonAgainst', 5.0)
    features['a_dribbles_allowed'] = _get_decayed_avg(a_hist, 'Dribble attempts won against_away', ts_a, 'avgDribbleAttemptsWonAgainst', 5.0)

    # 6g. V54 Computed Proxies (FBref replacements)
    features['h_ppda'] = _get_decayed_avg(h_hist, 'PPDA proxy_home', ts_h, 'ppdaProxy', 15.0)
    features['a_ppda'] = _get_decayed_avg(a_hist, 'PPDA proxy_away', ts_a, 'ppdaProxy', 15.0)
    features['h_prog_passes'] = _get_decayed_avg(h_hist, 'Progressive passes proxy_home', ts_h, 'progressivePassesProxy', 20.0)
    features['a_prog_passes'] = _get_decayed_avg(a_hist, 'Progressive passes proxy_away', ts_a, 'progressivePassesProxy', 20.0)
    features['h_sca'] = _get_decayed_avg(h_hist, 'Shot-creating actions proxy_home', ts_h, 'shotCreatingActionsProxy', 5.0)
    features['a_sca'] = _get_decayed_avg(a_hist, 'Shot-creating actions proxy_away', ts_a, 'shotCreatingActionsProxy', 5.0)

    # 7. Market & Environmental (TITANIUM)
    features['h_att_imp'] = float(row.get('home_att') or 1.0)
    features['a_att_imp'] = float(row.get('away_att') or 1.0)
    features['news_sent'] = float(row.get('news_sentiment') or 0)
    features['odds_h'] = float(row.get('odds_home') or 1.5)
    features['odds_a'] = float(row.get('odds_away') or 1.5)
    features['temp'] = float(row.get('weather_temp') or 20.0)
    
    # 8. Fatigue & Readiness
    features['rest_h'] = float(row.get('days_since_last_match_home') or 7)
    features['rest_a'] = float(row.get('days_since_last_match_away') or 7)
    
    h_team = str(row.get('homeTeam') or '')
    a_team = str(row.get('awayTeam') or '')
    features['travel_f'] = calculate_travel_fatigue(h_team, a_team) if h_team and a_team else 0.0
    features['is_cup'] = 1.0 if any(x in str(row.get('tournament_name','')).lower() for x in ['cup', 'coupe', 'pokal', 'copa', 'trophy']) else 0.0
    
    # [V102] Derby Awareness
    features['is_derby'] = 1.0 if is_derby_match(h_team, a_team) else 0.0

    # 9. V46 News Intelligence (Deep Parsing)
    news = row.get('news_data') or {}
    if isinstance(news, str):
        try: news = json.loads(news)
        except: news = {}
    h_intel = (news.get('home') or {}).get('intelligence', {}).get('features', {})
    a_intel = (news.get('away') or {}).get('intelligence', {}).get('features', {})
    
    features['news_is_missing_gk'] = float(h_intel.get('is_missing_gk', 0) - a_intel.get('is_missing_gk', 0))
    features['news_is_missing_scorer'] = float(h_intel.get('is_missing_scorer', 0) - a_intel.get('is_missing_scorer', 0))
    features['news_is_missing_captain'] = float(h_intel.get('is_missing_captain', 0) - a_intel.get('is_missing_captain', 0))
    features['news_is_missing_star'] = float(h_intel.get('is_missing_star', 0) - a_intel.get('is_missing_star', 0))

    # 10. V47 Strategic Features (Market & Psychology)
    v70 = row.get('v70_analytics') or {}
    if isinstance(v70, str):
        try: v70 = json.loads(v70)
        except: v70 = {}
    features['odds_velocity'] = _f((v70.get('odds_velocity') or {}).get('velocity_h'), 0)
    features['h_mkt_val'] = _f(row.get('home_market_value'), 50.0)
    features['a_mkt_val'] = _f(row.get('away_market_value'), 50.0)
    features['ref_bias'] = _f(row.get('referee_home_win_rate'), 0.45)
    features['is_pressure'] = _f(row.get('is_high_pressure'), 0)

    # 10.1 Titanium AI Pipeline (Environmental + Form Points)
    features['h_pts'] = _f(row.get('home_form_pts'), 0.0)
    features['a_pts'] = _f(row.get('away_form_pts'), 0.0)
    features['pts_diff'] = features['h_pts'] - features['a_pts']
    
    features['humidity'] = _f(row.get('weather_humidity'), 50.0)
    features['temp'] = _f(row.get('weather_temp'), 20.0)
    
    # Odds Implied Probabilities
    oh = float(row.get('odds_home') or row.get('odds_h') or 2.5)
    od = float(row.get('odds_draw') or 3.2)
    oa = float(row.get('odds_away') or row.get('odds_a') or 2.8)
    
    ipH = 1.0 / oh if oh > 0 else 0.33
    ipD = 1.0 / od if od > 0 else 0.33
    ipA = 1.0 / oa if oa > 0 else 0.33
    
    total_ip = ipH + ipD + ipA
    features['ip_h'] = ipH / total_ip
    features['ip_d'] = ipD / total_ip
    features['ip_a'] = ipA / total_ip
    
    temp = float(row.get('weather_temp') or 20.0)
    w_desc = str(row.get('weather_desc','')).lower()
    features['is_extreme_weather'] = 1.0 if (temp > 35 or temp < 5 or "heavy" in w_desc or "rain" in w_desc or "snow" in w_desc) else 0.0

    # --- V26 ELITE INTELLIGENCE ADDITIONS ---
    graph = row.get('match_graph')
    if isinstance(graph, str):
        try: graph = json.loads(graph)
        except: graph = {}
    
    h_mom, a_mom, mom_trend = calculate_momentum_trend(graph)
    features['v26_momentum_h'] = h_mom
    features['v26_momentum_a'] = a_mom
    features['v26_momentum_trend'] = mom_trend
    features['v26_lineups_confirmed'] = 1.0 if row.get('lineups_confirmed') else 0.0

    # [BOOST] V90 EXPLOSIVE MOMENTUM: Detects if a team is accelerating their performance
    h_accel = h_roll_p3 - calculate_rolling_averages(h_hist[3:6] if len(h_hist) >= 6 else [])[1]
    a_accel = a_roll_p3 - calculate_rolling_averages(a_hist[3:6] if len(a_hist) >= 6 else [])[1]
    features['explosive_momentum_h'] = h_accel if h_accel > 0 else 0.0
    features['explosive_momentum_a'] = a_accel if a_accel > 0 else 0.0

    # --- V27 TACTICAL PRECISION (Phase 7) ---
    features['ref_yellow_avg'] = float(row.get('referee_yellow_avg') or 3.8)
    features['ref_red_avg'] = float(row.get('referee_red_avg') or 0.15)
    features['ref_pen_avg'] = float(row.get('referee_penalties_avg') or 0.25)
    
    # [V55] Environmental Impact Scaling
    w_impact = 1.0
    w_desc = str(row.get('weather_desc','')).lower()
    temp = float(row.get('weather_temp') or 20.0)
    
    if 'rain' in w_desc or 'pluie' in w_desc: w_impact += 0.1
    if temp > 32: w_impact += 0.15
    if 'snow' in w_desc or 'neige' in w_desc: w_impact += 0.2
    
    features['weather_impact'] = w_impact
    
    # 11. [V51] REAL H2H INTELLIGENCE (Sofascore Integration)
    h2h = row.get('h2h_data')
    if isinstance(h2h, str):
        try: h2h = json.loads(h2h)
        except: h2h = {}
    if not isinstance(h2h, dict):
        h2h = {}
    
    duel = h2h.get('teamDuel', {})
    h2_h_w = float(duel.get('homeWins', 0))
    h2_a_w = float(duel.get('awayWins', 0))
    h2_d = float(duel.get('draws', 0))
    h2_total = h2_h_w + h2_a_w + h2_d
    
    features['h2h_home_win_rate'] = h2_h_w / h2_total if h2_total > 0 else 0.33
    features['h2h_away_win_rate'] = h2_a_w / h2_total if h2_total > 0 else 0.33
    features['h2h_draw_rate'] = h2_d / h2_total if h2_total > 0 else 0.34
    features['h2h_total_matches'] = h2_total

    # 12. [V52] LINE MOVEMENT INTELLIGENCE (24h Market Delta)
    move = row.get('odds_movement_24h') or {}
    if isinstance(move, str):
        try: move = json.loads(move)
        except: move = {}
    if not isinstance(move, dict):
        move = {}
    
    features['h_odds_move_24h'] = float(move.get('h_pct', 0))
    features['a_odds_move_24h'] = float(move.get('a_pct', 0))
    features['d_odds_move_24h'] = float(move.get('d_pct', 0))
    features['market_reliability'] = 1.0 if move.get('is_reliable') else 0.0

    # [V95] ODDS ACCELERATION: Detects rapid changes in the last hour
    move_1h = row.get('odds_movement_1h') or {}
    if isinstance(move_1h, str):
        try: move_1h = json.loads(move_1h)
        except: move_1h = {}
    
    h_accel = float(move_1h.get('h_pct', 0))
    a_accel = float(move_1h.get('a_pct', 0))
    # If 1h movement is faster than 24h movement (normalized), acceleration is high
    features['odds_acceleration_h'] = h_accel if abs(h_accel) > abs(features['h_odds_move_24h'] / 24) else 0.0
    features['odds_acceleration_a'] = a_accel if abs(a_accel) > abs(features['a_odds_move_24h'] / 24) else 0.0


    # Existing V25 indicators (syncing with V26/V27)
    mot_val, _ = get_match_motivation_context(row)
    volume = float(row.get('market_volume') or 50000.0)
    features['motivation_context'] = mot_val
    features['liquidity_index'] = min(1.0, volume / 100000.0)
    features['data_completeness'] = calculate_data_completeness(features)

    # --- V53 ENHANCED FEATURES (xGA, xPTS, Efficiency, Streaks, H2H Advanced, Bayesian) ---

    # 1. xGA (Expected Goals Against) — avg opponent xG in recent matches (time-decayed)
    h_xga_val = _get_decayed_avg(h_hist, 'Expected goals_away', ts_h, 'goalsAgainst', 1.2)
    a_xga_val = _get_decayed_avg(a_hist, 'Expected goals_away', ts_a, 'goalsAgainst', 1.2)
    features['h_xga'] = h_xga_val
    features['a_xga'] = a_xga_val
    features['xga_diff'] = h_xga_val - a_xga_val

    # 2. xG Overperformance (actual goals - xG) — >0 = regression to come (time-decayed)
    h_xg_avg = _get_decayed_avg(h_hist, 'Expected goals_home', ts_h, 'expectedGoals', 1.0)
    a_xg_avg = _get_decayed_avg(a_hist, 'Expected goals_home', ts_a, 'expectedGoals', 1.0)
    h_goals_avg = _get_decayed_avg(h_hist, 'score_for', ts_h, 'avgGoals', 1.2)
    a_goals_avg = _get_decayed_avg(a_hist, 'score_for', ts_a, 'avgGoals', 1.2)
    features['h_xg_overperformance'] = h_goals_avg - h_xg_avg
    features['a_xg_overperformance'] = a_goals_avg - a_xg_avg

    # 3. xPTS (Expected Points proxy) — from xG_diff converted to expected win/draw/loss
    def _xpts_proxy(team_xg, opp_xg):
        if team_xg + opp_xg == 0: return 1.0
        p_win = team_xg / (team_xg + opp_xg) * 0.6
        p_draw = 0.25
        return p_win * 3.0 + p_draw * 1.0

    features['h_xpts'] = _xpts_proxy(features['h_xg'], features['a_xg'])
    features['a_xpts'] = _xpts_proxy(features['a_xg'], features['h_xg'])

    # 4. Conversion & Efficiency
    features['h_conversion_rate'] = _hist_rate(h_hist, 'score_for', 'Total shots_home', 0.1)
    features['a_conversion_rate'] = _hist_rate(a_hist, 'score_for', 'Total shots_away', 0.1)
    features['h_sot_rate'] = _hist_rate(h_hist, 'Shots on target_home', 'Total shots_home', 0.4)
    features['a_sot_rate'] = _hist_rate(a_hist, 'Shots on target_away', 'Total shots_away', 0.4)
    h_shots_vol = _get_decayed_avg(h_hist, 'Total shots_home', ts_h, 'avgShots', 10.0)
    a_shots_vol = _get_decayed_avg(a_hist, 'Total shots_away', ts_a, 'avgShots', 10.0)
    features['h_shot_volume'] = h_shots_vol
    features['a_shot_volume'] = a_shots_vol

    # 5. Streaks (momentum)
    features['h_clean_streak'] = _compute_streak(h_hist, lambda m: m.get('score_against', 0) == 0)
    features['a_clean_streak'] = _compute_streak(a_hist, lambda m: m.get('score_against', 0) == 0)
    features['h_scoring_streak'] = _compute_streak(h_hist, lambda m: m.get('score_for', 0) > 0)
    features['a_scoring_streak'] = _compute_streak(a_hist, lambda m: m.get('score_for', 0) > 0)
    features['h_win_streak'] = _compute_streak(h_hist, lambda m: m.get('points', 0) == 3)
    features['a_win_streak'] = _compute_streak(a_hist, lambda m: m.get('points', 0) == 3)

    # 6. H2H Advanced (from archive)
    h2h_adv = get_h2h_advanced(home_name, away_name, current_match_ts)
    features['h2h_avg_goals'] = h2h_adv.get('avg_total_goals', 0.0)
    features['h2h_over25_rate'] = h2h_adv.get('over25_rate', 0.5)
    features['h2h_avg_xg'] = h2h_adv.get('avg_xg', 0.0)
    features['h2h_archive_matches'] = float(h2h_adv.get('total_matches', 0))

    # 7. Bayesian Shrink Factors (weight by sample size)
    h_shrink = min(1.0, len(h_hist) / 10.0)
    a_shrink = min(1.0, len(a_hist) / 10.0)
    features['h_shrink_factor'] = h_shrink
    features['a_shrink_factor'] = a_shrink

    # 8. Time context
    ts = row.get('startTimestamp') or row.get('match_date') or 0
    try:
        ts = int(ts)
        import datetime
        dt = datetime.datetime.fromtimestamp(ts)
        features['day_of_week'] = float(dt.weekday())
        features['kickoff_hour'] = float(dt.hour)
    except:
        features['day_of_week'] = -1.0
        features['kickoff_hour'] = -1.0

    # 9. Enhanced match importance
    imp_score = features.get('motivation_context', 1.0)
    if features.get('is_cup', 0) > 0: imp_score += 0.3
    if abs(features.get('pts_diff', 0)) < 0.5 and features.get('h_pts', 0) > 0: imp_score += 0.2
    features['match_importance'] = imp_score

    # 10. Tunisia Crowdsourcing Features (TITANIUM V3)
    tn_features = extract_tunisian_features(home_name, away_name)
    features.update(tn_features)

    # 10b. Raw Promosport vote percentages (from match data)
    vh = _f(row.get('vote_home'), -1)
    vd = _f(row.get('vote_draw'), -1)
    va = _f(row.get('vote_away'), -1)
    if vh >= 0 and vd >= 0 and va >= 0:
        total = vh + vd + va
        features['vote_home_pct'] = vh / total if total > 0 else 0.5
        features['vote_draw_pct'] = vd / total if total > 0 else 0.33
        features['vote_away_pct'] = va / total if total > 0 else 0.17
        features['vote_advantage_home'] = vh - va
        features['vote_home_norm'] = features['vote_home_pct']
    else:
        features['vote_home_pct'] = 0.5
        features['vote_draw_pct'] = 0.33
        features['vote_away_pct'] = 0.17
        features['vote_advantage_home'] = 0.0
        features['vote_home_norm'] = 0.5

    # --- V55 FEATURE CROSSES & COMPOSITE METRICS ---
    def _safe_div(a, b):
        return a / b if b and b != 0 else 0.0

    # xG per shot — shot quality indicator
    features['xg_per_shot_h'] = _safe_div(features.get('h_xg', 0), features.get('h_shot_volume', 1))
    features['xg_per_shot_a'] = _safe_div(features.get('a_xg', 0), features.get('a_shot_volume', 1))

    # SoT per possession — attacking intensity
    features['sot_per_possession_h'] = _safe_div(features.get('h_sot', 1), features.get('h_pos', 50))
    features['sot_per_possession_a'] = _safe_div(features.get('a_sot', 1), features.get('a_pos', 50))

    # Goals per xG — finishing efficiency (regression signal)
    h_goals_avg = _get_decayed_avg(h_hist, 'score_for', ts_h, 'avgGoals', 1.2)
    a_goals_avg = _get_decayed_avg(a_hist, 'score_for', ts_a, 'avgGoals', 1.2)
    features['goals_per_xg_h'] = _safe_div(h_goals_avg, features.get('h_xg', 1))
    features['goals_per_xg_a'] = _safe_div(a_goals_avg, features.get('a_xg', 1))

    # SoT conceded per possession — defensive pressure resistance
    features['sot_conceded_per_possession_h'] = _safe_div(features.get('h_sot_faced', 1), features.get('h_pos', 50))
    features['sot_conceded_per_possession_a'] = _safe_div(features.get('a_sot_faced', 1), features.get('a_pos', 50))

    # Shots faced per xG conceded — opponent chance quality
    features['shots_faced_per_xg_h'] = _safe_div(features.get('h_shots_faced', 1), features.get('h_xga', 1))
    features['shots_faced_per_xg_a'] = _safe_div(features.get('a_shots_faced', 1), features.get('a_xga', 1))


    # Form × Momentum interaction
    features['form_x_momentum_h'] = features.get('home_momentum_points', 0) * features.get('explosive_momentum_h', 0)
    features['form_x_momentum_a'] = features.get('away_momentum_points', 0) * features.get('explosive_momentum_a', 0)

    # Elo × Home advantage interaction
    is_home_stronger = 1.0 if features.get('elo_diff', 0) > 50 else 0.0
    features['elo_x_home_advantage'] = 1.0 if is_home_stronger > 0 else 0.0

    # Odds-implied probability minus xG-derived probability (market mispricing)
    odds_implied_h = features.get('ip_h', 0.33)
    odds_implied_a = features.get('ip_a', 0.33)
    xg_implied_h = _safe_div(features.get('h_xg', 1), features.get('h_xg', 1) + features.get('a_xg', 1)) if features.get('h_xg', 0) + features.get('a_xg', 0) > 0 else 0.5
    xg_implied_a = 1.0 - xg_implied_h
    features['odds_implied_minus_xg_prob_h'] = odds_implied_h - xg_implied_h
    features['odds_implied_minus_xg_prob_a'] = odds_implied_a - xg_implied_a

    # Sharp money × odds movement interaction
    features['sharp_money_x_odds_move_h'] = features.get('ta_sharp_money_h', 0) * features.get('h_odds_move_24h', 0)
    features['sharp_money_x_odds_move_a'] = features.get('ta_sharp_money_a', 0) * features.get('a_odds_move_24h', 0)

    # Cyclical time encoding
    try:
        ts = int(row.get('startTimestamp') or row.get('match_date') or 0)
        import datetime
        dt = datetime.datetime.fromtimestamp(ts)
        features['day_sin'] = float(math.sin(2 * math.pi * dt.weekday() / 7))
        features['day_cos'] = float(math.cos(2 * math.pi * dt.weekday() / 7))
        features['month_sin'] = float(math.sin(2 * math.pi * (dt.month - 1) / 12))
        features['month_cos'] = float(math.cos(2 * math.pi * (dt.month - 1) / 12))
    except:
        features['day_sin'] = 0.0
        features['day_cos'] = 0.0
        features['month_sin'] = 0.0
        features['month_cos'] = 0.0

    # Data quality flags
    features['has_actual_xg'] = 1.0 if (float(row.get('home_xg') or 0) > 0 or float(row.get('away_xg') or 0) > 0 or float(row.get('home_shots_on_goal') or 0) > 0 or float(row.get('away_shots_on_goal') or 0) > 0) else 0.0
    features['has_actual_odds'] = 1.0 if (float(row.get('odds_home') or 0) > 1.0 and float(row.get('odds_away') or 0) > 1.0) else 0.0
    features['has_match_stats'] = 1.0 if (features.get('h_pos', 0) > 0 or features.get('a_pos', 0) > 0) else 0.0
    try:
        match_year = int(dt.year)
        features['is_modern_football_era'] = 1.0 if match_year >= 2015 else 0.0
    except:
        features['is_modern_football_era'] = 1.0
    features['data_completeness_score'] = features.get('data_completeness', 0.5)

    # --- V553 WC2026-SPECIFIC FEATURES ---
    wc26_teams = get_wc2026_team_data()
    h_name_key = h_team.strip().lower() if h_team else ''
    a_name_key = a_team.strip().lower() if a_team else ''
    h_wc = wc26_teams.get(h_name_key, {})
    a_wc = wc26_teams.get(a_name_key, {})
    features['fifa_rank_h'] = h_wc.get('fifa_rank', 999)
    features['fifa_rank_a'] = a_wc.get('fifa_rank', 999)
    features['fifa_pts_h'] = h_wc.get('fifa_points', 0)
    features['fifa_pts_a'] = a_wc.get('fifa_points', 0)
    features['squad_value_h'] = h_wc.get('squad_value', 0)
    features['squad_value_a'] = a_wc.get('squad_value', 0)
    features['squad_size_h'] = h_wc.get('squad_size', 26)
    features['squad_size_a'] = a_wc.get('squad_size', 26)
    features['avg_age_h'] = h_wc.get('avg_age', 27)
    features['avg_age_a'] = a_wc.get('avg_age', 27)
    features['fifa_rank_diff'] = features['fifa_rank_h'] - features['fifa_rank_a']
    features['squad_value_diff'] = features['squad_value_h'] - features['squad_value_a']
    conf_h = (h_wc.get('confederation') or '').upper()
    conf_a = (a_wc.get('confederation') or '').upper()
    features['conf_uefa_h'] = 1.0 if conf_h == 'UEFA' else 0.0
    features['conf_conmebol_h'] = 1.0 if conf_h == 'CONMEBOL' else 0.0
    features['conf_uefa_a'] = 1.0 if conf_a == 'UEFA' else 0.0
    features['conf_conmebol_a'] = 1.0 if conf_a == 'CONMEBOL' else 0.0

    # --- [DPM-LIGHT] Draw Pattern Features (Deadlock + Defensive Equilibrium) ---
    if h_hist and a_hist:
        h_cs = sum(1 for m in h_hist if m.get('score_against', 1) == 0) / max(len(h_hist), 1)
        a_cs = sum(1 for m in a_hist if m.get('score_against', 1) == 0) / max(len(a_hist), 1)
        h_ga = sum(m.get('score_against', 0) for m in h_hist) / max(len(h_hist), 1)
        a_ga = sum(m.get('score_against', 0) for m in a_hist) / max(len(a_hist), 1)
        h_gf = sum(m.get('score_for', 0) for m in h_hist) / max(len(h_hist), 1)
        a_gf = sum(m.get('score_for', 0) for m in a_hist) / max(len(a_hist), 1)

        deadlock_ga = (h_ga + a_ga) / 2.0
        cs_avg = (h_cs + a_cs) / 2.0
        if cs_avg > 0.30 and deadlock_ga < 1.5:
            features['draw_deadlock'] = min(1.0, max(0.0, (1.5 - deadlock_ga) * cs_avg * 2.0))
        else:
            features['draw_deadlock'] = 0.0

        eq_h = abs(h_gf - a_ga)
        eq_a = abs(a_gf - h_ga)
        eq_raw = (eq_h + eq_a) / 2.0
        features['draw_defensive_eq'] = max(0.0, min(1.0, 1.0 - eq_raw * 0.35))
    else:
        features['draw_deadlock'] = 0.0
        features['draw_defensive_eq'] = 0.0

    # --- PixelRAG-lite: propager les colonnes visual_* du payload vers features ---
    # (extract_visual_features les a injectées dans row en amont ; sans cette boucle
    # elles n'atteindraient jamais le vecteur, ni l'entraînement ni l'inférence.)
    for _vk in VISUAL_FEATURE_NAMES:
        features[_vk] = _f(row.get(_vk), 0.0)

    # --- V52 STABILITY GUARD: Final NaN/None Cleanup ---
    for k, v in list(features.items()):
        if v is None or (isinstance(v, float) and math.isnan(v)):
            features[k] = 0.0
        else:
            try:
                features[k] = float(v)
            except (ValueError, TypeError):
                features[k] = 0.0

    # --- GNN-lite Graph Features (transitive strength, PageRank, community) ---
    try:
        from graph_engine import compute_graph_features, GRAPH_FEATURE_NAMES
        graph_feats = compute_graph_features(home_name, away_name, _league_name)
        features.update(graph_feats)
    except Exception:
        for fn in GRAPH_FEATURE_NAMES:
            features.setdefault(fn, 0.0)

    # --- DEX Prediction Markets (smart money flow, Polymarket/Azuro) ---
    try:
        from dex_tracker import compute_dex_signals, DEX_FEATURE_NAMES
        dex_feats = compute_dex_signals(
            home_name, away_name,
            odds_home=_f(row.get('odds_home'), 0),
            odds_draw=_f(row.get('odds_draw'), 0),
            odds_away=_f(row.get('odds_away'), 0),
        )
        features.update(dex_feats)
    except Exception:
        for fn in DEX_FEATURE_NAMES:
            features.setdefault(fn, 0.0)

    return features

def extract_v56_features(row_or_feats, rows=None, match_idx=None):
    """Extract V56 feature vector (30 floats matching FEATURE_NAMES_V56).

    Two modes:
    1. Training: pass raw (row, rows, match_idx) for temporal feature engineering
    2. Inference: pass features dict from extract_ml_features() as row_or_feats

    Inference mode maps from the rich features dict to V56 features.
    Training mode computes form + H2H from historical rows.
    """

    # Detect mode: if rows are provided, it's training mode (raw row)
    if rows is not None and match_idx is not None:
        row = row_or_feats
        # Base stats
        _pos_diff = _f(row.get('home_possession'), 50) - _f(row.get('away_possession'), 50)
        _shots_diff = _f(row.get('home_shots') or row.get('home_shots_total')) - _f(row.get('away_shots') or row.get('away_shots_total'))
        _sot_diff = _f(row.get('home_shots_on_goal') or row.get('home_shots_on_target')) - _f(row.get('away_shots_on_goal') or row.get('away_shots_on_target'))
        _corners_diff = _f(row.get('home_corners')) - _f(row.get('away_corners'))
        _fouls_diff = _f(row.get('home_fouls')) - _f(row.get('away_fouls'))
        _yellow_diff = _f(row.get('home_yellow_cards')) - _f(row.get('away_yellow_cards'))
        _red_diff = _f(row.get('home_red_cards')) - _f(row.get('away_red_cards'))
        _inside_box_shots_diff = _f(row.get('home_shots_inside_box')) - _f(row.get('away_shots_inside_box'))
        h_xg = _f(row.get('home_xg'), 0)
        a_xg = _f(row.get('away_xg'), 0)
        _xg_diff = h_xg - a_xg
        h_shots_total = _f(row.get('home_shots') or row.get('home_shots_total'), 1)
        a_shots_total = _f(row.get('away_shots') or row.get('away_shots_total'), 1)
        _xg_per_shot_diff = (h_xg / max(h_shots_total, 0.01)) - (a_xg / max(a_shots_total, 0.01))

        # Team ratings
        _home_attack_rating = _f(row.get('home_attack_rating'), 1.0)
        _home_defense_rating = _f(row.get('home_defense_rating'), 1.0)
        _away_attack_rating = _f(row.get('away_attack_rating'), 1.0)
        _away_defense_rating = _f(row.get('away_defense_rating'), 1.0)
        _attack_x_defense = _home_attack_rating * (1.0 / max(_away_defense_rating, 0.1))
        _odds_h = _f(row.get('odds_home'), 2.0)
        _odds_a = _f(row.get('odds_away'), 2.0)
        _odds_ratio = _odds_a / max(_odds_h, 0.01)

        # Efficiency ratios (from current match only — form versions from loops)
        h_sot_val = _f(row.get('home_shots_on_goal') or row.get('home_shots_on_target'), 0)
        a_sot_val = _f(row.get('away_shots_on_goal') or row.get('away_shots_on_target'), 0)
        h_poss_val = _f(row.get('home_possession'), 50)
        a_poss_val = _f(row.get('away_possession'), 50)
        _sot_ratio_h = h_sot_val / max(h_shots_total, 0.01)
        _sot_ratio_a = a_sot_val / max(a_shots_total, 0.01)
        _possession_efficiency_h = h_xg / max(h_poss_val / 100.0, 0.01)
        _possession_efficiency_a = a_xg / max(a_poss_val / 100.0, 0.01)

        # Form state (will be computed from historical rows)
        _form_diff = 0.0
        _h2h_win_rate = 0.0
        _h2h_total = 0
        _form_shots_diff = 0.0
        _form_sot_diff = 0.0
        _form_corners_diff = 0.0
        _form_poss_h = 50.0
        _form_poss_a = 50.0
        _home_avg_goals_scored = 0.0
        _away_avg_goals_conceded = 0.0
        _month_sin = 0.0
        _month_cos = 0.0

        if match_idx > 10:
            home_team = str(row.get('home_team', '') or row.get('homeTeam', ''))
            away_team = str(row.get('away_team', '') or row.get('awayTeam', ''))

            h_shots, a_shots = [], []
            h_sot, a_sot = [], []
            h_corners, a_corners = [], []
            h_poss, a_poss = [], []
            h_goals_scored, a_goals_scored = [], []
            h_goals_conceded, a_goals_conceded = [], []
            h_xg_list, a_xg_list = [], []
            h_wins, a_wins = 0, 0
            h_games, a_games = 0, 0
            h2h_h_wins = 0
            h2h_total = 0

            for i in range(match_idx - 1, max(-1, match_idx - 50), -1):
                r = rows[i]
                r_home = str(r.get('home_team', '') or r.get('homeTeam', ''))
                r_away = str(r.get('away_team', '') or r.get('awayTeam', ''))
                gh = _f(r.get('goals_home') or r.get('scoreHome') or r.get('score_home'))
                ga = _f(r.get('goals_away') or r.get('scoreAway') or r.get('score_away'))
                if gh + ga == 0:
                    continue

                if r_home == home_team:
                    h_shots.append(_f(r.get('home_shots') or r.get('home_shots_total')))
                    h_sot.append(_f(r.get('home_shots_on_goal') or r.get('home_shots_on_target')))
                    h_corners.append(_f(r.get('home_corners')))
                    h_poss.append(_f(r.get('home_possession'), 50))
                    h_goals_scored.append(gh)
                    h_goals_conceded.append(ga)
                    h_xg_list.append(_f(r.get('home_xg'), 0))
                    h_games += 1
                    if gh > ga: h_wins += 1
                elif r_away == home_team:
                    h_shots.append(_f(r.get('away_shots') or r.get('away_shots_total')))
                    h_sot.append(_f(r.get('away_shots_on_goal') or r.get('away_shots_on_target')))
                    h_corners.append(_f(r.get('away_corners')))
                    h_poss.append(_f(r.get('away_possession'), 50))
                    h_goals_scored.append(ga)
                    h_goals_conceded.append(gh)
                    h_xg_list.append(_f(r.get('away_xg'), 0))
                    h_games += 1
                    if ga > gh: h_wins += 1

                if r_home == away_team:
                    a_shots.append(_f(r.get('home_shots') or r.get('home_shots_total')))
                    a_sot.append(_f(r.get('home_shots_on_goal') or r.get('home_shots_on_target')))
                    a_corners.append(_f(r.get('home_corners')))
                    a_poss.append(_f(r.get('home_possession'), 50))
                    a_goals_scored.append(gh)
                    a_goals_conceded.append(ga)
                    a_games += 1
                    if gh > ga: a_wins += 1
                elif r_away == away_team:
                    a_shots.append(_f(r.get('away_shots') or r.get('away_shots_total')))
                    a_sot.append(_f(r.get('away_shots_on_goal') or r.get('away_shots_on_target')))
                    a_corners.append(_f(r.get('away_corners')))
                    a_poss.append(_f(r.get('away_possession'), 50))
                    a_goals_scored.append(ga)
                    a_goals_conceded.append(gh)
                    a_games += 1
                    if ga > gh: a_wins += 1

                if (r_home == home_team and r_away == away_team) or (r_home == away_team and r_away == home_team):
                    h2h_total += 1
                    if (r_home == home_team and gh > ga) or (r_home == away_team and ga > gh):
                        h2h_h_wins += 1

                if len(h_shots) >= 5 and len(a_shots) >= 5 and h2h_total >= 3:
                    break

            if h_shots:
                recent_h = h_shots[-5:]
                _form_shots_diff = (sum(recent_h) / len(recent_h)) - (sum(a_shots[-5:]) / len(a_shots[-5:]) if a_shots else 0)
            if h_sot:
                _form_sot_diff = (sum(h_sot[-5:]) / len(h_sot[-5:])) - (sum(a_sot[-5:]) / len(a_sot[-5:]) if a_sot else 0)
            if h_corners:
                _form_corners_diff = (sum(h_corners[-5:]) / len(h_corners[-5:])) - (sum(a_corners[-5:]) / len(a_corners[-5:]) if a_corners else 0)
            if h_poss:
                _form_poss_h = sum(h_poss[-5:]) / len(h_poss[-5:])
            if a_poss:
                _form_poss_a = sum(a_poss[-5:]) / len(a_poss[-5:])
            if h_goals_scored:
                _home_avg_goals_scored = sum(h_goals_scored[-5:]) / len(h_goals_scored[-5:])
            if a_goals_conceded:
                _away_avg_goals_conceded = sum(a_goals_conceded[-5:]) / len(a_goals_conceded[-5:])

            _form_diff = (h_wins / max(h_games, 1)) - (a_wins / max(a_games, 1))
            _h2h_win_rate = h2h_h_wins / max(h2h_total, 1)
            _h2h_total = h2h_total

        date_str = str(row.get('date', '') or row.get('match_date', '') or row.get('startTimestamp', ''))
        if date_str and len(date_str) >= 7 and '-' in date_str:
            try:
                month = int(date_str[5:7])
                _month_sin = math.sin(2 * math.pi * month / 12)
                _month_cos = math.cos(2 * math.pi * month / 12)
            except:
                pass
    else:
        feats = row_or_feats
        # Base stats
        _pos_diff = _f(feats.get('pos_diff'), 0)
        _shots_diff = _f(feats.get('shots_diff'), 0)
        _sot_diff = _f(feats.get('sot_diff'), 0)
        _corners_diff = _f(feats.get('corner_diff'), 0)
        _fouls_diff = _f(feats.get('foul_diff'), 0)
        _yellow_diff = _f(feats.get('yellow_diff'), 0)
        _red_diff = _f(feats.get('red_diff'), 0)
        _inside_box_shots_diff = _f(feats.get('h_inner_shots'), 0) - _f(feats.get('a_inner_shots'), 0)
        h_xg = _f(feats.get('h_xg'), 0)
        a_xg = _f(feats.get('a_xg'), 0)
        _xg_diff = h_xg - a_xg
        _xg_per_shot_diff = _f(feats.get('xg_per_shot_diff'), 0)
        # Team ratings
        _home_attack_rating = _f(feats.get('h_att_imp', feats.get('ta_h_rating', 1.0)), 1.0)
        _home_defense_rating = _f(feats.get('h_def_imp', feats.get('ta_h_rating', 1.0)), 1.0)
        _away_defense_rating = _f(feats.get('a_def_imp', feats.get('ta_a_rating', 1.0)), 1.0)
        _attack_x_defense = _home_attack_rating / max(_away_defense_rating, 0.1)
        _odds_h = _f(feats.get('odds_h'), 2.0)
        _odds_a = _f(feats.get('odds_a'), 2.0)
        _odds_ratio = _odds_a / max(_odds_h, 0.01)
        # Efficiency
        _sot_ratio_h = _f(feats.get('sot_ratio_h', 0), 0)
        _sot_ratio_a = _f(feats.get('sot_ratio_a', 0), 0)
        _possession_efficiency_h = _f(feats.get('poss_eff_h', feats.get('possession_efficiency_h', 0)), 0)
        _possession_efficiency_a = _f(feats.get('poss_eff_a', feats.get('possession_efficiency_a', 0)), 0)
        # Form & H2H
        _form_diff = _f(feats.get('h_mom_gicko', feats.get('form_diff', 0)), 0)
        _h2h_win_rate = _f(feats.get('h2h_home_win_rate', feats.get('h2h_win_rate', 0)), 0)
        _h2h_total = int(_f(feats.get('h2h_total_matches', feats.get('h2h_total', 0)), 0))
        _form_shots_diff = _f(feats.get('form_shots_diff', 0), 0)
        _form_sot_diff = _f(feats.get('form_sot_diff', 0), 0)
        _form_corners_diff = _f(feats.get('form_corners_diff', 0), 0)
        _form_poss_h = _f(feats.get('form_poss_h', 50), 50)
        _form_poss_a = _f(feats.get('form_poss_a', 50), 50)
        _home_avg_goals_scored = _f(feats.get('home_avg_goals_scored', 0), 0)
        _away_avg_goals_conceded = _f(feats.get('away_avg_goals_conceded', 0), 0)
        # Temporal
        _month_sin = _f(feats.get('month_sin'), 0)
        _month_cos = _f(feats.get('month_cos'), 0)

    return [
        _pos_diff, _shots_diff, _sot_diff, _corners_diff,
        _fouls_diff, _yellow_diff, _red_diff, _inside_box_shots_diff,
        _xg_diff, _xg_per_shot_diff,
        _home_attack_rating, _home_defense_rating,
        _attack_x_defense, _odds_ratio,
        _form_diff, _h2h_win_rate, float(_h2h_total),
        _form_shots_diff, _form_sot_diff, _form_corners_diff,
        _form_poss_h, _form_poss_a,
        _sot_ratio_h, _sot_ratio_a,
        _possession_efficiency_h, _possession_efficiency_a,
        _month_sin, _month_cos,
        _home_avg_goals_scored, _away_avg_goals_conceded,
    ]
