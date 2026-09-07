# -*- coding: utf-8 -*-
"""Listes FEATURE_NAMES (V24->V56, TITANIUM, VISUAL) + FEATURE_VOLATILITY.
Purement déclaratif — extrait de ml_features.py (split 2026-09-07)."""

# V23 Feature Names — Used by the existing trained model (stitch_v23_hybrid.json)
# DO NOT MODIFY: changing this list breaks XGBoost inference.
FEATURE_NAMES = [
    'home_elo', 'away_elo', 'elo_diff', 'home_motivation', 'away_motivation',
    'tactical_synergy', 'home_injury_impact', 'away_injury_impact',
    'h_pos', 'a_pos', 'pos_diff', 'h_pass_acc', 'a_pass_acc', 'pass_acc_diff',
    'h_xg', 'a_xg', 'xg_diff', 'h_bc', 'a_bc', 'bc_diff',
    'h_sot', 'a_sot', 'sot_diff', 'h_shots_off', 'a_shots_off', 'h_inner_shots', 'a_inner_shots',
    'h_int', 'a_int', 'int_diff', 'h_tackles', 'a_tackles', 'tackles_diff',
    'h_clear', 'a_clear', 'clear_diff', 'h_def_err', 'a_def_err', 'h_saves', 'a_saves',
    'h_ground_won', 'a_ground_won', 'h_aerial_won', 'a_aerial_won',
    'h_poss_lost', 'a_poss_lost', 'lost_diff', 'h_corners', 'a_corners', 'corner_diff',
    'h_fouls', 'a_fouls', 'foul_diff', 'h_cards', 'a_cards',
    'h_style_enc', 'a_style_enc', 'h_mom_gicko', 'a_mom_gicko',
    'h_att_imp', 'a_att_imp', 'news_sent', 'odds_h', 'odds_a', 'temp',
    'rest_h', 'rest_a', 'travel_f', 'is_cup'
]

# V24 Extended Feature Names — For future retraining with Top Analyst Market Intelligence.
# Use this list when training stitch_v24 or later models.
FEATURE_NAMES_V24 = FEATURE_NAMES + [
    # Top Analyst Engine Features (Sharp Money + Market Intelligence)
    'ta_true_prob_h', 'ta_true_prob_d', 'ta_true_prob_a',
    'ta_odds_change_speed_h', 'ta_odds_change_speed_a',
    'ta_sharp_money_h', 'ta_sharp_money_a', 'ta_sharp_money_d',
    'ta_sharp_money_indicator',
    'ta_xg_h', 'ta_xg_a',
    'ta_sot_h', 'ta_sot_a',
    'ta_news_impact', 'ta_news_sentiment',
    'ta_over_25_prob', 'ta_under_25_prob', 'ta_expected_total_goals',
    'ta_value_bet_flag', 'ta_highest_value_index',
    'ta_market_confidence_indicator', 'ta_team_strength_indicator',
    'ta_momentum_indicator', 'ta_goal_expectation_indicator',
    'ta_h_rating', 'ta_a_rating', 'ta_rating_diff'
]

# V25 Intelligence Feature Names — Adding Context & Reliability
FEATURE_NAMES_V25 = FEATURE_NAMES_V24 + [
    'motivation_context',
    'liquidity_index',
    'data_completeness'
]

# V26 Elite Intelligence Guard — Real-time Verification
FEATURE_NAMES_V26 = FEATURE_NAMES_V25 + [
    'v26_momentum_h',
    'v26_momentum_a',
    'v26_momentum_trend',
    'v26_lineups_confirmed'
]
# V27 Tactical Precision Feature Names (Phase 7)
FEATURE_NAMES_V27 = FEATURE_NAMES_V26 + [
    'ref_yellow_avg',
    'ref_red_avg',
    'ref_pen_avg',
    'weather_impact'
]

# V51 Real H2H Intelligence (Sofascore Integration)
FEATURE_NAMES_V51 = FEATURE_NAMES_V27 + [
    'h2h_home_win_rate',
    'h2h_away_win_rate',
    'h2h_draw_rate',
    'h2h_total_matches'
]

# V52 Line Movement Intelligence (Market Psychology)
FEATURE_NAMES_V52 = FEATURE_NAMES_V51 + [
    'h_odds_move_24h',
    'a_odds_move_24h',
    'd_odds_move_24h',
    'market_reliability'
]

# V53 Enhanced Features (xGA, xPTS, Efficiency, Streaks, H2H Advanced, Bayesian Shrink)
FEATURE_NAMES_V53 = FEATURE_NAMES_V52 + [
    'h_xga', 'a_xga', 'xga_diff',
    'h_xg_overperformance', 'a_xg_overperformance',
    'h_xpts', 'a_xpts',
    'h_conversion_rate', 'a_conversion_rate',
    'h_sot_rate', 'a_sot_rate',
    'h_shot_volume', 'a_shot_volume',
    'h_clean_streak', 'a_clean_streak',
    'h_scoring_streak', 'a_scoring_streak',
    'h_win_streak', 'a_win_streak',
    'h2h_avg_goals', 'h2h_over25_rate', 'h2h_avg_xg', 'h2h_archive_matches',
    'h_shrink_factor', 'a_shrink_factor',
    'day_of_week', 'kickoff_hour',
    'match_importance',
    'h_successful_dribbles', 'a_successful_dribbles',
    'h_accurate_long_balls', 'a_accurate_long_balls',
    'h_accurate_crosses', 'a_accurate_crosses',
    'h_opp_half_passes', 'a_opp_half_passes',
    'h_duels_won_pct', 'a_duels_won_pct',
    'h_errors_leading_to_shot', 'a_errors_leading_to_shot'
]

# V54 Enhanced Passing, Duels, Defensive (Against) + FBref Proxies
FEATURE_NAMES_V54 = FEATURE_NAMES_V53 + [
    'h_accurate_opp_half_passes', 'a_accurate_opp_half_passes',
    'h_opp_half_pass_pct', 'a_opp_half_pass_pct',
    'h_acc_own_half_passes', 'a_acc_own_half_passes',
    'h_long_ball_pct', 'a_long_ball_pct',
    'h_cross_pct', 'a_cross_pct',
    'h_ground_duels_won', 'a_ground_duels_won',
    'h_ground_duel_pct', 'a_ground_duel_pct',
    'h_aerial_duel_pct', 'a_aerial_duel_pct',
    'h_total_duels', 'a_total_duels',
    'h_ball_recovery', 'a_ball_recovery',
    'h_blocked_shots', 'a_blocked_shots',
    'h_assists', 'a_assists',
    'h_shots_faced', 'a_shots_faced',
    'h_sot_faced', 'a_sot_faced',
    'h_bc_conceded', 'a_bc_conceded',
    'h_key_passes_allowed', 'a_key_passes_allowed',
    'h_corners_conceded', 'a_corners_conceded',
    'h_dribbles_allowed', 'a_dribbles_allowed',
    'h_ppda', 'a_ppda',
    'h_prog_passes', 'a_prog_passes',
    'h_sca', 'a_sca'
]

# V55 Feature Crosses & Data Quality (Composite Intelligence)
FEATURE_NAMES_V55 = FEATURE_NAMES_V54 + [
    # xG per shot — shot quality
    'xg_per_shot_h', 'xg_per_shot_a',
    # SoT per possession — attacking intensity
    'sot_per_possession_h', 'sot_per_possession_a',
    # Goals per xG — finishing efficiency (regression towards mean)
    'goals_per_xg_h', 'goals_per_xg_a',
    # SoT conceded per possession — defensive discipline
    'sot_conceded_per_possession_h', 'sot_conceded_per_possession_a',
    # Shots faced per xG conceded — defensive quality
    'shots_faced_per_xg_h', 'shots_faced_per_xg_a',
    # Form × Momentum cross
    'form_x_momentum_h', 'form_x_momentum_a',
    # Elo × Home advantage
    'elo_x_home_advantage',
    # Market mispricing (odds implied - xG implied)
    'odds_implied_minus_xg_prob_h', 'odds_implied_minus_xg_prob_a',
    # Sharp money × odds movement
    'sharp_money_x_odds_move_h', 'sharp_money_x_odds_move_a',
    # Cyclical time encoding
    'day_sin', 'day_cos', 'month_sin', 'month_cos',
    # Data quality gates
    'has_actual_xg', 'has_actual_odds', 'has_match_stats',
    'is_modern_football_era', 'data_completeness_score'
]

# PixelRAG-lite: colonnes visuelles produites en amont par
# core/visual_features.py (injectées dans le payload par fastapi_server).
# Set NOUVEAU et séparé : on ne touche PAS à FEATURE_NAMES_V55/V553 car les
# boosters stitch_v55*/v553* sont liés à leur compte de features à l'entraînement.
# Un booster visuel (stitch_v55_visual.json) est le seul à consommer ces colonnes.
VISUAL_FEATURE_NAMES = [
    'visual_confidence', 'visual_tiles_n', 'visual_max_score', 'visual_mean_score',
    'visual_covers', 'visual_has_lineup', 'visual_has_form', 'visual_has_xg',
    'visual_wiki_confidence', 'visual_wiki_hits',
    'visual_wiki_has_squad', 'visual_wiki_has_history',
]

# V55 + contexte visuel : base d'un réentraînement dédié (voir train_v55 --visual).
FEATURE_NAMES_V55_VISUAL = FEATURE_NAMES_V55 + VISUAL_FEATURE_NAMES

# Features derivees des closing odds (odds_movement_24h) : presentes a l'entrainement
# (historique football-data), mais ~toujours absentes a l'inference live (closing odds
# n'existent pas avant le match) -> skewness train/serve (audit F1). A exclure du re-entrainement.
CLOSING_DERIVED_FEATURES = [
    'h_odds_move_24h', 'a_odds_move_24h', 'd_odds_move_24h',
    'sharp_money_x_odds_move_h', 'sharp_money_x_odds_move_a',
]


def feature_names_excluding(base, exclude):
    """Retourne une copie de `base` sans les features de `exclude` (ordre conserve)."""
    exclude_set = set(exclude)
    return [f for f in base if f not in exclude_set]


# V55 sans les features derivees des closing odds : aligne train et serve (feature
# absente des deux cotes -> fin du skewness). Utilise pour re-entrainer un artefact
# separe (ex: stitch_v55_noclose.json) sans ecraser le modele de production.
FEATURE_NAMES_V55_NOCLOSE = feature_names_excluding(FEATURE_NAMES_V55, CLOSING_DERIVED_FEATURES)

# V56 — Auto-Retrain Feature Set: simple match stats + form + H2H
# Designed for weekly auto-retrain from soccer_fixtures + soccer_match_stats
FEATURE_NAMES_V56 = [
    # Base stats (10)
    'pos_diff',
    'shots_diff',
    'sot_diff',
    'corners_diff',
    'fouls_diff',
    'yellow_diff',
    'red_diff',
    'inside_box_shots_diff',
    'xg_diff',
    'xg_per_shot_diff',
    # Team ratings (4)
    'home_attack_rating',
    'home_defense_rating',
    'attack_x_defense',
    'odds_ratio',
    # Form & H2H (8)
    'form_diff',
    'h2h_home_win_rate',
    'h2h_total_matches',
    'form_shots_diff',
    'form_sot_diff',
    'form_corners_diff',
    'form_poss_h',
    'form_poss_a',
    # Efficiency ratios (4)
    'sot_ratio_h',
    'sot_ratio_a',
    'possession_efficiency_h',
    'possession_efficiency_a',
    # Temporal (4)
    'month_sin',
    'month_cos',
    'home_avg_goals_scored',
    'away_avg_goals_conceded',
]

# V551 — Pruned V55: only features that proved valuable (xg_per_shot + market mispricing)
FEATURE_NAMES_V551 = FEATURE_NAMES_V54 + [
    'xg_per_shot_h', 'xg_per_shot_a',
    'odds_implied_minus_xg_prob_h', 'odds_implied_minus_xg_prob_a',
    'data_completeness_score'
]

# V552 — Same features as V551, trained with chronological split (2022-2026) + V54-like hyperparams
FEATURE_NAMES_V552 = FEATURE_NAMES_V551

# V553 — WC2026 Context Features: FIFA ranking, squad value, age, confederation
FEATURE_NAMES_V553 = FEATURE_NAMES_V552 + [
    'fifa_rank_h', 'fifa_rank_a',
    'fifa_pts_h', 'fifa_pts_a',
    'squad_value_h', 'squad_value_a',
    'squad_size_h', 'squad_size_a',
    'avg_age_h', 'avg_age_a',
    'fifa_rank_diff', 'squad_value_diff',
    'conf_uefa_h', 'conf_conmebol_h',
    'conf_uefa_a', 'conf_conmebol_a'
]

# [TITANIUM V3] ELITE AI FEATURES - Full Environmental Intelligence (V54) + Tunisia Crowdsourcing
FEATURE_NAMES_TITANIUM = FEATURE_NAMES_V54 + [
    'h_pts', 'a_pts', 'pts_diff',
    'humidity',
    'ip_h', 'ip_d', 'ip_a',
    'is_extreme_weather',
    'news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star',
    'odds_velocity', 'is_derby',
    # Tunisia Crowdsourcing Features
    'h_tn_vote_consent', 'a_tn_vote_consent', 'tn_vote_consent_diff',
    'h_tn_vote_sentiment', 'a_tn_vote_sentiment', 'tn_vote_sentiment_diff',
    'h_tn_vote_divergence', 'a_tn_vote_divergence', 'tn_vote_divergence_diff',
    'h_tn_vote_volatility', 'a_tn_vote_volatility', 'tn_vote_volatility_diff',
    'h_tn_jackpot_pressure', 'a_tn_jackpot_pressure', 'tn_jackpot_pressure_diff',
    'h_tn_crowd_conviction', 'a_tn_crowd_conviction', 'tn_crowd_conviction_diff'
]



# V46/V47 Features - Used by the Surgical Intelligence Module (not for raw XGBoost)
SURGICAL_FEATURES = [
    'news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star',
    'h_mkt_val', 'a_mkt_val', 'ref_bias', 'is_pressure'
]

# V20 Volatility Tiers (Quantum)
# Tags features by their expected variance to inform Monte Carlo injection.
FEATURE_VOLATILITY = {
    # Low Volatility (Fixed/Slow-moving)
    "home_elo": 0.01, "away_elo": 0.01, "h_mkt_val": 0.02, "a_mkt_val": 0.02,
    "h2h_home_win_rate": 0.04, "h2h_away_win_rate": 0.04, "h2h_draw_rate": 0.04,
    "market_reliability": 0.01,
    
    # Medium Volatility (Statistical averages / Performance)
    "h_pos": 0.07, "a_pos": 0.07, "h_xg": 0.12, "a_xg": 0.12, 
    "h_sot": 0.15, "a_sot": 0.15, "h_bc": 0.18, "a_bc": 0.18,
    "h_pass_acc": 0.06, "a_pass_acc": 0.06,
    "h_int": 0.12, "h_tackles": 0.12, "h_clear": 0.15,
    "xg_elo_delta_h": 0.08, "xg_elo_delta_a": 0.08,
    
    # High Volatility (Psychological/News/Momentum/Disrupted)
    "home_motivation": 0.22, "away_motivation": 0.22, 
    "news_sent": 0.35, "v26_momentum_trend": 0.45,
    "is_pressure": 0.35, "home_injury_impact": 0.40, "away_injury_impact": 0.40,
    "h_odds_move_24h": 0.20, "a_odds_move_24h": 0.20,
    "h_def_err": 0.50, "a_def_err": 0.50,  # High volatility on mistakes
    
    # V53 Enhanced Features
    "h_xga": 0.12, "a_xga": 0.12, "xga_diff": 0.15,
    "h_xg_overperformance": 0.35, "a_xg_overperformance": 0.35,
    "h_xpts": 0.18, "a_xpts": 0.18,
    "h_conversion_rate": 0.25, "a_conversion_rate": 0.25,
    "h_sot_rate": 0.12, "a_sot_rate": 0.12,
    "h_shot_volume": 0.10, "a_shot_volume": 0.10,
    "h_clean_streak": 0.30, "a_clean_streak": 0.30,
    "h_scoring_streak": 0.25, "a_scoring_streak": 0.25,
    "h_win_streak": 0.30, "a_win_streak": 0.30,
    "h2h_avg_goals": 0.20, "h2h_over25_rate": 0.18, "h2h_avg_xg": 0.18, "h2h_archive_matches": 0.05,
    "h_shrink_factor": 0.02, "a_shrink_factor": 0.02,
    "day_of_week": 0.05, "kickoff_hour": 0.08,
    "match_importance": 0.25,
    "h_successful_dribbles": 0.18, "a_successful_dribbles": 0.18,
    "h_accurate_long_balls": 0.14, "a_accurate_long_balls": 0.14,
    "h_accurate_crosses": 0.16, "a_accurate_crosses": 0.16,
    "h_opp_half_passes": 0.10, "a_opp_half_passes": 0.10,
    "h_duels_won_pct": 0.08, "a_duels_won_pct": 0.08,
    "h_errors_leading_to_shot": 0.40, "a_errors_leading_to_shot": 0.40,

    # V54 Enhanced Passing Detail
    "h_accurate_opp_half_passes": 0.10, "a_accurate_opp_half_passes": 0.10,
    "h_opp_half_pass_pct": 0.06, "a_opp_half_pass_pct": 0.06,
    "h_acc_own_half_passes": 0.08, "a_acc_own_half_passes": 0.08,
    "h_long_ball_pct": 0.10, "a_long_ball_pct": 0.10,
    "h_cross_pct": 0.12, "a_cross_pct": 0.12,

    # V54 Ground & Aerial Duels
    "h_ground_duels_won": 0.14, "a_ground_duels_won": 0.14,
    "h_ground_duel_pct": 0.08, "a_ground_duel_pct": 0.08,
    "h_aerial_duel_pct": 0.10, "a_aerial_duel_pct": 0.10,
    "h_total_duels": 0.08, "a_total_duels": 0.08,

    # V54 Ball Recovery & Blocks
    "h_ball_recovery": 0.12, "a_ball_recovery": 0.12,
    "h_blocked_shots": 0.15, "a_blocked_shots": 0.15,
    "h_assists": 0.18, "a_assists": 0.18,

    # V54 Defensive (Against)
    "h_shots_faced": 0.12, "a_shots_faced": 0.12,
    "h_sot_faced": 0.12, "a_sot_faced": 0.12,
    "h_bc_conceded": 0.18, "a_bc_conceded": 0.18,
    "h_key_passes_allowed": 0.14, "a_key_passes_allowed": 0.14,
    "h_corners_conceded": 0.10, "a_corners_conceded": 0.10,
    "h_dribbles_allowed": 0.14, "a_dribbles_allowed": 0.14,

    # V54 Computed Proxies
    "h_ppda": 0.12, "a_ppda": 0.12,
    "h_prog_passes": 0.10, "a_prog_passes": 0.10,
    "h_sca": 0.16, "a_sca": 0.16,

    # Titanium-Specific Features
    "h_pts": 0.01, "a_pts": 0.01, "pts_diff": 0.02,
    "humidity": 0.05, "is_extreme_weather": 0.15,
    "ip_h": 0.02, "ip_d": 0.02, "ip_a": 0.02,
    "news_is_missing_gk": 0.25, "news_is_missing_scorer": 0.25,
    "news_is_missing_captain": 0.25, "news_is_missing_star": 0.30,
    "odds_velocity": 0.20, "is_derby": 0.08,

    # V55 Feature Crosses & Composites
    "xg_per_shot_h": 0.10, "xg_per_shot_a": 0.10,
    "sot_per_possession_h": 0.08, "sot_per_possession_a": 0.08,
    "goals_per_xg_h": 0.30, "goals_per_xg_a": 0.30,
    "sot_conceded_per_possession_h": 0.10, "sot_conceded_per_possession_a": 0.10,
    "shots_faced_per_xg_h": 0.12, "shots_faced_per_xg_a": 0.12,
    "form_x_momentum_h": 0.30, "form_x_momentum_a": 0.30,
    "elo_x_home_advantage": 0.02,
    "odds_implied_minus_xg_prob_h": 0.12, "odds_implied_minus_xg_prob_a": 0.12,
    "sharp_money_x_odds_move_h": 0.30, "sharp_money_x_odds_move_a": 0.30,
    "day_sin": 0.05, "day_cos": 0.05, "month_sin": 0.05, "month_cos": 0.05,
    "has_actual_xg": 0.01, "has_actual_odds": 0.01, "has_match_stats": 0.01,
    "is_modern_football_era": 0.01, "data_completeness_score": 0.02,

    # PixelRAG-lite visual context (medium: capture depends on scrape freshness)
    "visual_confidence": 0.10, "visual_tiles_n": 0.10,
    "visual_max_score": 0.10, "visual_mean_score": 0.10,
    "visual_covers": 0.05, "visual_has_lineup": 0.15,
    "visual_has_form": 0.15, "visual_has_xg": 0.15,
    "visual_wiki_confidence": 0.10, "visual_wiki_hits": 0.10,
    "visual_wiki_has_squad": 0.15, "visual_wiki_has_history": 0.15,

    # Legacy Derived Diffs (low volatility — noise cancels out)
    "elo_diff": 0.02, "tactical_synergy": 0.04,
    "pos_diff": 0.04, "pass_acc_diff": 0.04, "xg_diff": 0.04,
    "bc_diff": 0.04, "sot_diff": 0.04, "int_diff": 0.04,
    "tackles_diff": 0.04, "clear_diff": 0.04, "foul_diff": 0.04,
    "corner_diff": 0.04, "lost_diff": 0.04,
    "h2h_total_matches": 0.02,
    "h_style_enc": 0.03, "a_style_enc": 0.03,
    "d_odds_move_24h": 0.20,
    "liquidity_index": 0.02, "data_completeness": 0.02,
    "motivation_context": 0.22,

    # Legacy Per-Match Stats (medium volatility)
    "h_shots_off": 0.15, "a_shots_off": 0.15,
    "h_inner_shots": 0.14, "a_inner_shots": 0.14,
    "a_int": 0.12, "a_tackles": 0.12, "a_clear": 0.15,
    "h_saves": 0.18, "a_saves": 0.18,
    "h_ground_won": 0.10, "a_ground_won": 0.10,
    "h_aerial_won": 0.12, "a_aerial_won": 0.12,
    "h_poss_lost": 0.10, "a_poss_lost": 0.10,
    "h_corners": 0.08, "a_corners": 0.08,
    "h_fouls": 0.10, "a_fouls": 0.10,
    "h_cards": 0.12, "a_cards": 0.12,
    "h_mom_gicko": 0.15, "a_mom_gicko": 0.15,
    "h_att_imp": 0.06, "a_att_imp": 0.06,

    # Market & Environmental
    "odds_h": 0.08, "odds_a": 0.08,
    "temp": 0.05, "rest_h": 0.08, "rest_a": 0.08,
    "travel_f": 0.10, "is_cup": 0.15,
    "ref_yellow_avg": 0.06, "ref_red_avg": 0.06, "ref_pen_avg": 0.06,
    "weather_impact": 0.10,
    "v26_momentum_h": 0.30, "v26_momentum_a": 0.30,
    "v26_lineups_confirmed": 0.20,

    # Top Analyst Market Intelligence
    "ta_true_prob_h": 0.08, "ta_true_prob_d": 0.08, "ta_true_prob_a": 0.08,
    "ta_odds_change_speed_h": 0.25, "ta_odds_change_speed_a": 0.25,
    "ta_sharp_money_h": 0.20, "ta_sharp_money_a": 0.20, "ta_sharp_money_d": 0.20,
    "ta_sharp_money_indicator": 0.15,
    "ta_xg_h": 0.12, "ta_xg_a": 0.12,
    "ta_sot_h": 0.15, "ta_sot_a": 0.15,
    "ta_news_impact": 0.30, "ta_news_sentiment": 0.35,
    "ta_over_25_prob": 0.10, "ta_under_25_prob": 0.10,
    "ta_expected_total_goals": 0.10,
    "ta_value_bet_flag": 0.20, "ta_highest_value_index": 0.15,
    "ta_market_confidence_indicator": 0.08,
    "ta_team_strength_indicator": 0.06, "ta_momentum_indicator": 0.20,
    "ta_goal_expectation_indicator": 0.10,
    "ta_h_rating": 0.06, "ta_a_rating": 0.06, "ta_rating_diff": 0.08,

    # Tunisia Crowdsourcing Features (TITANIUM V3)
    # High volatility: crowd sentiment changes rapidly, influenced by news
    "h_tn_vote_consent": 0.25, "a_tn_vote_consent": 0.25, "tn_vote_consent_diff": 0.30,
    "h_tn_vote_sentiment": 0.30, "a_tn_vote_sentiment": 0.30, "tn_vote_sentiment_diff": 0.35,
    "h_tn_vote_divergence": 0.20, "a_tn_vote_divergence": 0.20, "tn_vote_divergence_diff": 0.25,
    "h_tn_vote_volatility": 0.35, "a_tn_vote_volatility": 0.35, "tn_vote_volatility_diff": 0.40,
    "h_tn_jackpot_pressure": 0.15, "a_tn_jackpot_pressure": 0.15, "tn_jackpot_pressure_diff": 0.20,
    "h_tn_crowd_conviction": 0.28, "a_tn_crowd_conviction": 0.28, "tn_crowd_conviction_diff": 0.32,

    # Raw Promosport vote percentages
    "vote_home_pct": 0.20, "vote_draw_pct": 0.20, "vote_away_pct": 0.20,
    "vote_advantage_home": 0.25, "vote_home_norm": 0.20,
}
