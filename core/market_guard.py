"""
market_guard.py — Garde-fou de divergence marché + correctif biais domicile Asie (E17)

Contexte (audit 2026-09-12, 440 matchs du feed avec cotes réelles) :
- ASIE (J/K/Thai/V-League...) : écart moyen modèle - book deviggé = +16.8 pp
  en faveur du domicile (Gamba 69% vs book 27%) — archive ne contenant que
  3-8 matchs par tournoi asiatique, le HA data-driven est du bruit.
- AUTRES ligues : -1.2 pp en moyenne, MAIS 25 divergence >12 pp ponctuelles
  (cotes périmées, features asynchrones) -> le garde-fou sert aussi là.

Règles (config/divergence_guard.json) :
1) check_market_divergence : |p_modele - p_book_deviggee| > max_pp (défaut 12)
   sur AU MOINS UN des 3 signes 1X2, avec les 3 cotes réelles > 1 -> veto NO BET.
2) apply_asian_home_damp : si ligue familiale ASIE, p_home *= (1 - damp) puis
   renormalisation (ASIAN_HA_FIX=on par défaut, off = non-régression).
3) home_advantage_from_stats : pas de ratio HA calculé sur < min_rows matchs
   (échantillon bruit) -> repli par famille (ASIE 1.08 sinon 1.15).

Pures fonctions, zéro DB, zéro réseau — testables seules (pytest).
"""
import json
import os
from functools import lru_cache

DIVERGENCE_MAX_PP = 12.0
ASIAN_HOME_DAMP = 0.15
ASIAN_HA_DEFAULT = 1.08
NEUTRAL_HA_DEFAULT = 1.15
HA_MIN_ROWS = 30

DEFAULT_ASIAN_LEAGUES = [
    'j1 league', 'j2 league', 'j3 league', 'j-league', 'japan',
    'k league', 'k-league', 'korea',
    'thai league', 'v-league', 'vietnam',
    'china super', 'chinese super', 'indonesia', 'malaysia', 'singapore',
    'hong kong', 'philippines', 'myanmar', 'iraq', 'azerbaijan',
]

_CFG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'config', 'divergence_guard.json')


@lru_cache(maxsize=1)
def load_guard_config():
    cfg = {
        'max_divergence_pp': DIVERGENCE_MAX_PP,
        'asian_home_damp': ASIAN_HOME_DAMP,
        'asian_ha_default': ASIAN_HA_DEFAULT,
        'neutral_ha_default': NEUTRAL_HA_DEFAULT,
        'ha_min_rows': HA_MIN_ROWS,
        'asian_leagues': list(DEFAULT_ASIAN_LEAGUES),
    }
    try:
        with open(_CFG_PATH, 'r', encoding='utf-8') as f:
            user = json.load(f)
        for k, v in (user or {}).items():
            if k == 'asian_leagues' and isinstance(v, list):
                cfg['asian_leagues'] = list(v)
            elif k in cfg:
                cfg[k] = v
    except Exception:
        pass
    return cfg


def is_asian_league(league_name, cfg=None):
    s = str(league_name or '').lower()
    cfg = cfg or load_guard_config()
    return any(k in s for k in cfg['asian_leagues'])


def asian_home_damp_enabled():
    # E17 demandé explicitement : défaut ON (correctif du biais +16.8pp),
    # ASIAN_HA_FIX=off pour la non-régression stricte.
    return os.environ.get('ASIAN_HA_FIX', 'on').lower() != 'off'


def apply_asian_home_damp(p_h, p_d, p_a, match_obj, cfg=None):
    """Amortit le biais domicile des ligues asiatiques, renormalise. (0-1)."""
    if not asian_home_damp_enabled():
        return p_h, p_d, p_a
    cfg = cfg or load_guard_config()
    league = str(match_obj.get('league', '') or match_obj.get('tournament_name', ''))
    if not is_asian_league(league, cfg):
        return p_h, p_d, p_a
    damp = float(cfg['asian_home_damp'])
    if damp <= 0:
        return p_h, p_d, p_a
    nh = p_h * (1.0 - damp)
    s = nh + p_d + p_a
    if s <= 0:
        return p_h, p_d, p_a
    return nh / s, p_d / s, p_a / s


def check_market_divergence(p_h, p_d, p_a, odds_h, odds_d, odds_a, cfg=None):
    """
    p_* en 0-1, odds réelles 1X2. Retourne None si les 3 cotes ne sont pas
    exploitables ; sinon bloc {flagged, side, model_pct, book_pct, edge_pp,
    max_pp, edges_pp} avec le PIRE écart (valeur signée).
    Implicites dévigguées proportionnellement au surajustement (overround).
    """
    try:
        oh, od, oa = float(odds_h), float(odds_d), float(odds_a)
    except (TypeError, ValueError):
        return None
    if not (oh > 1 and od > 1 and oa > 1):
        return None
    cfg = cfg or load_guard_config()
    s = 1.0 / oh + 1.0 / od + 1.0 / oa
    book = {
        'home': (1.0 / oh) / s * 100.0,
        'draw': (1.0 / od) / s * 100.0,
        'away': (1.0 / oa) / s * 100.0,
    }
    model = {'home': p_h * 100.0, 'draw': p_d * 100.0, 'away': p_a * 100.0}
    edges = {k: model[k] - book[k] for k in book}
    worst = max(edges, key=lambda k: abs(edges[k]))
    max_pp = float(cfg['max_divergence_pp'])
    return {
        'flagged': abs(edges[worst]) > max_pp,
        'side': worst,
        'model_pct': round(model[worst], 1),
        'book_pct': round(book[worst], 1),
        'edge_pp': round(edges[worst], 1),
        'max_pp': max_pp,
        'edges_pp': {k: round(v, 1) for k, v in edges.items()},
    }


def home_advantage_from_stats(count, avg_h, avg_a, is_asian, cfg=None):
    """
    Ratio HA (avg_h/avg_a) fiable UNIQUEMENT sur >= ha_min_rows matchs ;
    sinon repli par famille (ASIE sous-coté par le 1.15 européen).
    """
    cfg = cfg or load_guard_config()
    try:
        c = int(count)
        ah = float(avg_h)
        aa = float(avg_a)
    except (TypeError, ValueError):
        return cfg['asian_ha_default'] if is_asian else cfg['neutral_ha_default']
    if c < int(cfg['ha_min_rows']) or ah <= 0 or aa <= 0:
        return cfg['asian_ha_default'] if is_asian else cfg['neutral_ha_default']
    # plafond de décence : ratio >2 sur un lobby de buts = bruit
    return max(0.90, min(1.45, ah / aa))
