"""
external_xgb.py — External ensemble member: XGBoost from msoczi/football_predictions
Replicates the feature engineering of scripts/main_script.py (football-data.co.uk CSV →
form aggregates → league table → FIFA ratings) and predicts via a modern XGBoost Booster.

Active only for the 5 supported leagues (PremierLeague, Bundesliga, SerieA, LaLiga, Ligue1).
Return None whenever the league, a team or the data is unavailable so the rest of the
pipeline is completely unaffected.
"""
import os
import io
import sys
import threading
import time
import re
import unicodedata
import difflib

import numpy as np
import pandas as pd
import yaml
import xgboost
import requests

_DIR = os.path.dirname(os.path.abspath(__file__))
EXTERNAL_DIR = os.path.normpath(os.path.join(_DIR, '..', 'external', 'soccer_xgb'))
DATA_DIR = os.path.join(EXTERNAL_DIR, 'data')

SEASON = '2526'
CSV_NAMES = {
    'PremierLeague': 'E0',
    'Bundesliga': 'D1',
    'SerieA': 'I1',
    'LaLiga': 'SP1',
    'Ligue1': 'F1',
}
_CSV_TTL = 6 * 3600  # 6h

_STITCH_LEAGUE_HINTS = {
    'premierleague': 'PremierLeague',
    'premier league': 'PremierLeague',
    'epl': 'PremierLeague',
    'bundesliga': 'Bundesliga',
    'seriea': 'SerieA',
    'serie a': 'SerieA',
    'laliga': 'LaLiga',
    'la liga': 'LaLiga',
    'ligue1': 'Ligue1',
    'ligue 1': 'Ligue1',
    'ligue 1 uber eats': 'Ligue1',
}

_lock = threading.Lock()
_cache = {}


# ---------------------------------------------------------------------------
# Loaders (lazy singletons)
# ---------------------------------------------------------------------------
def _load_config():
    if 'config' not in _cache:
        with open(os.path.join(EXTERNAL_DIR, 'config.yaml'), 'r', encoding='utf-8') as f:
            _cache['config'] = yaml.safe_load(f)
    return _cache['config']


def _load_booster():
    if 'booster' not in _cache:
        _cache['booster'] = xgboost.Booster(
            model_file=os.path.join(EXTERNAL_DIR, 'xgb_model.json'))
    return _cache['booster']


def _load_tree():
    if 'tree' not in _cache:
        import pickle
        with open(os.path.join(EXTERNAL_DIR, 'tree_model.pkl'), 'rb') as f:
            _cache['tree'] = pickle.load(f)
    return _cache['tree']


def _load_fifa(league):
    key = 'fifa_' + league
    if key not in _cache:
        path = os.path.join(EXTERNAL_DIR, 'fifa_ratings', 'fifa_rating_{}_23.csv'.format(league))
        df = pd.read_csv(path, sep=';')
        df = df.rename(columns={'Name': 'name'})
        df['name'] = df['name'].astype(str).str.strip()
        _cache[key] = df
    return _cache[key]


# ---------------------------------------------------------------------------
# Name normalization / translation
# ---------------------------------------------------------------------------
def _norm(s):
    s = unicodedata.normalize('NFKD', str(s or ''))
    s = s.encode('ascii', 'ignore').decode('ascii')
    s = re.sub(r'[^a-z0-9]', '', s.lower())
    return s


def _canonical_names(league):
    """Return set of canonical team names (values of teams_names_dict ∪ CSV teams)."""
    if ('canon_' + league) not in _cache:
        cfg = _load_config()
        names = set((cfg.get('teams_names_dict') or {}).get(league, {}).values())
        csv = _get_csv(league, refresh_ok=False)
        if csv is not None:
            names |= set(csv['HomeTeam'].astype(str).str.strip().unique())
            names |= set(csv['AwayTeam'].astype(str).str.strip().unique())
        _cache['canon_' + league] = names
    return _cache['canon_' + league]


def _fifa_to_canonical(league):
    """Map normalized FIFA name -> canonical name for the league."""
    key = 'fifa2canon_' + league
    if key not in _cache:
        cfg = _load_config()
        replace = (cfg.get('fifa_rating_teams_dict') or {}).get(league, {})
        canon = _canonical_names(league)
        canon_norm = {_norm(c): c for c in canon}
        mapping = {}
        fifa = _load_fifa(league)
        for name in fifa['name'].unique():
            if name in replace:
                mapping[_norm(name)] = replace[name]
                continue
            n = _norm(name)
            if n in canon_norm:
                mapping[n] = canon_norm[n]
                continue
            close = difflib.get_close_matches(n, list(canon_norm.keys()), n=1, cutoff=0.8)
            if close:
                mapping[n] = canon_norm[close[0]]
            else:
                mapping[n] = name  # keep original as last resort
        _cache[key] = mapping
    return _cache[key]


def translate_team(league, team):
    """Translate an incoming stitch team name to the canonical external name."""
    if not team:
        return None
    cfg = _load_config()
    teams_dict = (cfg.get('teams_names_dict') or {}).get(league, {})
    canon = _canonical_names(league)
    canon_norm = {_norm(c): c for c in canon}
    n = _norm(team)

    # direct canonical
    if n in canon_norm:
        return canon_norm[n]
    # teams_names_dict: incoming matches a value (canonical) or a key (sky name)
    for k, v in teams_dict.items():
        if _norm(k) == n:
            return v
    # fifa mapping
    fifa_map = _fifa_to_canonical(league)
    if n in fifa_map:
        return fifa_map[n]
    # fuzzy against canonical
    close = difflib.get_close_matches(n, list(canon_norm.keys()), n=1, cutoff=0.8)
    if close:
        return canon_norm[close[0]]
    return None


def league_key(league_name):
    if not league_name:
        return None
    n = _norm(league_name)
    if n in _STITCH_LEAGUE_HINTS:
        return _STITCH_LEAGUE_HINTS[n]
    for k in _STITCH_LEAGUE_HINTS:
        if k in n:
            return _STITCH_LEAGUE_HINTS[k]
    return None


# ---------------------------------------------------------------------------
# Current-season data (football-data.co.uk CSV), cached to disk
# ---------------------------------------------------------------------------
def _get_csv(league, refresh_ok=True):
    path = os.path.join(DATA_DIR, league + '.csv')
    now = time.time()
    try:
        age = now - os.path.getmtime(path) if os.path.exists(path) else _CSV_TTL + 1
    except OSError:
        age = _CSV_TTL + 1
    if os.path.exists(path) and age < _CSV_TTL:
        return pd.read_csv(path, encoding='utf-8-sig')
    if not refresh_ok:
        if os.path.exists(path):
            return pd.read_csv(path, encoding='utf-8-sig')
        return None
    try:
        url = 'https://www.football-data.co.uk/mmz4281/{}/{}.csv'.format(SEASON, CSV_NAMES[league])
        r = requests.get(url, timeout=15)
        if r.status_code == 200 and b'Div' in r.content[:30]:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(path, 'wb') as f:
                f.write(r.content)
            return pd.read_csv(path, encoding='utf-8-sig')
    except Exception as exc:
        sys.stderr.write('[external_xgb] CSV refresh failed for {}: {}\n'.format(league, exc))
    if os.path.exists(path):
        return pd.read_csv(path, encoding='utf-8-sig')
    return None


# ---------------------------------------------------------------------------
# Feature engineering (faithful port of scripts/main_script.py)
# ---------------------------------------------------------------------------
def _import_aggvar():
    if 'aggvar' in _cache:
        return _cache['aggvar']
    path = os.path.join(EXTERNAL_DIR, 'aggvarfun.py')
    import importlib.util
    spec = importlib.util.spec_from_file_location('soccer_xgb_aggvarfun', path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['soccer_xgb_aggvarfun'] = mod
    spec.loader.exec_module(mod)
    _cache['aggvar'] = mod.create_agg_var
    return _cache['aggvar']


def _build_features(results, home, away, league):
    """Replicates calc_features() of the external repo (prediction path)."""
    create_agg_var = _import_aggvar()

    # --- per-match stats from both home & away perspective ---
    res = results[['Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'FTR',
                   'HS', 'AS', 'HST', 'AST', 'HC', 'AC', 'HY', 'AY', 'HR', 'AR']].copy()
    res['HoA'] = 'H'
    res2 = res.copy()
    res2['HoA'] = 'A'
    res2 = res2.rename(columns={'AwayTeam': '_t', 'HomeTeam': 'AwayTeam'})
    res2['HomeTeam'] = res2['_t']
    res2 = res2.drop(columns=['_t'])
    frame = pd.concat([res, res2], axis=0, ignore_index=True)
    frame = frame.rename(columns={'HomeTeam': 'Team'})
    frame['Date'] = pd.to_datetime(frame['Date'], dayfirst=True, errors='coerce')
    frame = frame.sort_values(by=['Date'], ascending=False)

    def pts(row):
        if row.FTR == 'D':
            return 1
        if row.FTR == row.HoA:
            return 3
        return 0

    def pick(row, away_col, home_col):
        return row[away_col] if row.HoA == 'A' else row[home_col]

    frame['pts'] = frame.apply(pts, axis=1)
    frame['goal_zdob'] = frame.apply(lambda r: pick(r, 'FTAG', 'FTHG'), axis=1)
    frame['goal_strc'] = frame.apply(lambda r: pick(r, 'FTHG', 'FTAG'), axis=1)
    frame['sh_odd'] = frame.apply(lambda r: pick(r, 'AS', 'HS'), axis=1)
    frame['sh_otrz'] = frame.apply(lambda r: pick(r, 'HS', 'AS'), axis=1)
    frame['sot_odd'] = frame.apply(lambda r: pick(r, 'AST', 'HST'), axis=1)
    frame['sot_otrz'] = frame.apply(lambda r: pick(r, 'HST', 'AST'), axis=1)
    frame['cor_wyk'] = frame.apply(lambda r: pick(r, 'AC', 'HC'), axis=1)
    frame['cor_bro'] = frame.apply(lambda r: pick(r, 'HC', 'AC'), axis=1)
    frame['yel_card'] = frame.apply(lambda r: pick(r, 'AY', 'HY'), axis=1)
    frame['red_card'] = frame.apply(lambda r: pick(r, 'HY', 'AY'), axis=1)

    form_var = create_agg_var(results=frame)

    # --- league table vars ---
    res_t = results[['Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'FTR',
                     'HS', 'AS', 'HST', 'AST', 'HC', 'AC']].copy()

    def hp(row):
        return 3 if row.FTR == 'H' else (0 if row.FTR == 'A' else 1)

    def ap(row):
        return 0 if row.FTR == 'H' else (3 if row.FTR == 'A' else 1)

    res_t['H_pts'] = res_t.apply(hp, axis=1)
    res_t['A_pts'] = res_t.apply(ap, axis=1)

    home_table = res_t.groupby('HomeTeam').sum()[['FTHG', 'FTAG', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC', 'H_pts']]
    away_table = res_t.groupby('AwayTeam').sum()[['FTHG', 'FTAG', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC', 'A_pts']]
    home_table.columns = ['H_goal_zdob', 'H_goal_strc', 'H_strzaly_oddane', 'H_strzaly_dopuszczone',
                          'H_strz_cel_oddane', 'H_strz_cel_dopuszczone', 'H_kornery_wyk', 'H_kornery_bro', 'H_pts']
    away_table.columns = ['A_goal_strc', 'A_goal_zdob', 'A_strzaly_dopuszczone', 'A_strzaly_oddane',
                          'A_strz_cel_oddane', 'A_strz_cel_dopuszczone', 'A_kornery_wyk', 'A_kornery_bro', 'A_pts']

    table = pd.concat([home_table, away_table], axis=1)
    table['goal_zdob'] = table.H_goal_zdob + table.A_goal_zdob
    table['goal_strc'] = table.H_goal_strc + table.A_goal_strc
    table['goal_bilans'] = table.goal_zdob - table.goal_strc
    table['pts'] = table.H_pts + table.A_pts
    table['strzaly_oddane'] = table.H_strzaly_oddane + table.A_strzaly_oddane
    table['strzaly_dopuszczone'] = table.H_strzaly_dopuszczone + table.A_strzaly_dopuszczone
    table['strz_cel_oddane'] = table.H_strz_cel_oddane + table.A_strz_cel_oddane
    table['strz_cel_dopuszczone'] = table.H_strz_cel_dopuszczone + table.A_strz_cel_dopuszczone
    table['cor_wyk'] = table.H_kornery_wyk + table.A_kornery_wyk
    table['cor_bro'] = table.H_kornery_bro + table.A_kornery_bro
    table.sort_values(by=['pts', 'goal_bilans', 'goal_zdob'], inplace=True, ascending=(False, False, False))
    table['H_nmatch'] = res_t.groupby('HomeTeam').size()
    table['A_nmatch'] = res_t.groupby('AwayTeam').size()
    table['n_match'] = table['H_nmatch'] + table['A_nmatch']
    table['pts_per_math'] = table.pts / table.n_match
    table['gz'] = table.goal_zdob / table.n_match
    table['gs'] = table.goal_strc / table.n_match
    table['sh_od'] = table.strzaly_oddane / table.n_match
    table['sh_ot'] = table.strzaly_dopuszczone / table.n_match
    table['cw'] = table.cor_wyk / table.n_match
    table['cb'] = table.cor_bro / table.n_match
    table['pozycja'] = range(1, len(table) + 1)

    # --- FIFA ratings (translate names to canonical like training did) ---
    fifa = _load_fifa(league)
    fifa_map = _fifa_to_canonical(league)
    fifa['canon'] = fifa['name'].map(lambda n: fifa_map.get(_norm(n), n))
    fifa = fifa.set_index('canon')
    fifa = fifa[['ATT', 'MID', 'DEF', 'OVR']].copy()

    # --- merge ---
    output = pd.concat([form_var,
                        table[['pts_per_math', 'gz', 'gs', 'sh_od', 'sh_ot', 'cw', 'cb', 'pozycja']],
                        fifa], axis=1)

    def side(team):
        if team not in output.index:
            return None
        row = output.loc[[team]]
        row.columns = [('h_' if team == home else 'a_') + c for c in row.columns]
        row.index = [0]
        return row

    h_var = side(home)
    a_var = side(away)
    if h_var is None or a_var is None:
        return None

    out = pd.concat([h_var, a_var], axis=1)
    out['position_dst'] = abs(out['h_pozycja'] - out['a_pozycja'])
    out['ATT_dst'] = abs(out['h_ATT'] - out['a_ATT'])
    out['MID_dst'] = abs(out['h_MID'] - out['a_MID'])
    out['DEF_dst'] = abs(out['h_DEF'] - out['a_DEF'])
    out['OVR_dst'] = abs(out['h_OVR'] - out['a_OVR'])
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def predict_external(league_name, home_team, away_team, results=None):
    """
    Return {'xgb': {...}, 'tree': {...}, 'tree_label': 'H'|'D'|'A'} or None.
    None = league/team/data unavailable (member disabled, pipeline unchanged).

    `results` (optional): pre-filtered football-data.co.uk DataFrame used for
    feature building instead of the cached season CSV. Used for leak-free
    backtesting (matches strictly before the target match). When None, the
    standard cached/refreshed CSV is used (production path, unchanged).
    """
    key = league_key(league_name)
    if key is None:
        return None

    h = translate_team(key, home_team)
    a = translate_team(key, away_team)
    if h is None or a is None:
        return None

    results = _get_csv(key, refresh_ok=True) if results is None else results
    if results is None or len(results) < 5:
        return None

    with _lock:
        try:
            feats = _build_features(results, h, a, key)
            if feats is None:
                return None
            booster = _load_booster()
            feature_names = booster.feature_names
            # The external aggvarfun has a legacy naming quirk (yc_wz7 named yc_std7),
            # producing duplicate labels. The VALUE ORDER is correct though — XGBoost
            # splits on feature index, so align positionally to the model's feature list.
            if feats.shape[1] != len(feature_names):
                return None
            row = feats.values.astype(float).reshape(1, -1)
            dmat = xgboost.DMatrix(row, feature_names=feature_names)
            proba = booster.predict(dmat)[0]
            xgb_h, xgb_d, xgb_a = float(proba[0]), float(proba[1]), float(proba[2])

            tree = _load_tree()
            tree_raw = tree.predict_proba(np.array([[xgb_h, xgb_d, xgb_a]]))[0]
            tree_sum = float(np.sum(tree_raw))
            tree_proba = tree_raw / tree_sum if tree_sum > 0 else np.array([0.34, 0.33, 0.33])
            tree_label = tree.predict(np.array([[xgb_h, xgb_d, xgb_a]]))[0]
            labels = {0: 'H', 1: 'D', 2: 'A'}
            return {
                'xgb': {'home': xgb_h, 'draw': xgb_d, 'away': xgb_a},
                'tree': {
                    'home': float(tree_proba[0]),
                    'draw': float(tree_proba[1]),
                    'away': float(tree_proba[2]),
                },
                'tree_label': labels.get(int(tree_label), 'H'),
            }
        except Exception as exc:
            sys.stderr.write('[external_xgb] predict failed: {}\n'.format(exc))
            return None