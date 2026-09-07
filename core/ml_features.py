# -*- coding: utf-8 -*-
"""
FAÇADE ml_features — rétro-compatibilité totale après le split 2026-09-07.

Les 28 importeurs (`from ml_features import X`) ne changent pas.
Répartition réelle du code :
  - ml_feature_names.py : listes FEATURE_NAMES_* + FEATURE_VOLATILITY (pur déclaratif)
  - ml_history.py       : connexions DB, historique équipes, helpers analytiques
  - ml_tunisian.py      : features votes Tunisie (autonome)
  - ml_extract.py       : extract_ml_features + extract_v56_features
"""

from ml_feature_names import (
    FEATURE_NAMES,
    FEATURE_NAMES_V24,
    FEATURE_NAMES_V25,
    FEATURE_NAMES_V26,
    FEATURE_NAMES_V27,
    FEATURE_NAMES_V51,
    FEATURE_NAMES_V52,
    FEATURE_NAMES_V53,
    FEATURE_NAMES_V54,
    FEATURE_NAMES_V55,
    FEATURE_NAMES_V55_NOCLOSE,
    FEATURE_NAMES_V551,
    FEATURE_NAMES_V552,
    FEATURE_NAMES_V553,
    FEATURE_NAMES_V55_VISUAL,
    FEATURE_NAMES_V56,
    FEATURE_NAMES_TITANIUM,
    VISUAL_FEATURE_NAMES,
    CLOSING_DERIVED_FEATURES,
    SURGICAL_FEATURES,
    FEATURE_VOLATILITY,
    feature_names_excluding,
)
from ml_history import (
    DB_ARCHIVE_PATH,
    DB_TACTICAL_PATH,
    ELO_PATH,
    STYLES_PATH,
    ELO_RATINGS,
    TEAM_STYLES,
    load_json,
    _f,
    parse_pct,
    get_wc2026_team_data,
    get_db_connection,
    close_db_connection,
    extract_features_from_stats,
    get_team_history,
    calculate_rolling_averages,
    calculate_glicko_momentum,
    get_detailed_team_style,
    get_rolling_team_style,
    get_match_motivation_context,
    is_derby_match,
    get_h2h_advanced,
    calculate_data_completeness,
    calculate_momentum_trend,
    calculate_cumulative_fatigue,
    calculate_injury_impact,
    calculate_motivation,
    get_tactical_synergy,
    calculate_travel_fatigue,
)
from ml_tunisian import extract_tunisian_features
from ml_extract import extract_ml_features, extract_v56_features
