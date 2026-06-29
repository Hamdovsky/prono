import numpy as np
import math
import os
import pickle
import json
import time
from datetime import datetime, timedelta

try:
    from scipy.optimize import minimize
    from scipy.special import gammaln
    _HAS_SCIPY = True
except Exception:
    _HAS_SCIPY = False
    gammaln = math.lgamma

# Cache directory for fitted parameters
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data')
CACHE_FILE = os.path.join(CACHE_DIR, 'goalmodel_parameters_cache.pkl')
CACHE_TTL_HOURS = 24


def ensure_cache_dir():
    if not os.path.exists(CACHE_DIR):
        os.makedirs(CACHE_DIR, exist_ok=True)


# ─── TIME WEIGHTS (Dixon-Coles exponential decay) ─────────────
def calculate_time_weights(match_days, half_life=365):
    if half_life <= 0:
        return np.ones_like(np.array(match_days, dtype=float))
    lambda_decay = math.log(2) / half_life
    return np.array([math.exp(-lambda_decay * d) for d in match_days], dtype=float)


# ─── POISSON PMF ──────────────────────────────────────────────
def poisson_pmf(lam, k):
    if k < 0:
        return 0.0
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return (math.exp(-lam) * (lam ** k)) / math.factorial(k)


# ─── NEGATIVE BINOMIAL PMF (overdispersion) ───────────────────
def negbin_pmf(mu, theta, k):
    if k < 0 or mu <= 0 or theta <= 0:
        return 0.0
    coeff = math.exp(gammaln(k + theta) - gammaln(k + 1) - gammaln(theta))
    prob = coeff * ((theta / (theta + mu)) ** theta) * ((mu / (theta + mu)) ** k)
    return prob


# ─── CONWAY-MAXWELL-POISSON PMF (under/over dispersion) ────
def cmp_pmf(lam, nu, k, max_k=25):
    if k < 0 or lam <= 0:
        return 0.0
    if nu <= 0:
        nu = 1.0
    log_probs = []
    for j in range(max_k + 1):
        lp = j * math.log(lam) - nu * math.lgamma(j + 1)
        log_probs.append(lp)
    max_lp = max(log_probs)
    probs = [math.exp(lp - max_lp) for lp in log_probs]
    z = sum(probs)
    if z <= 0:
        return 0.0
    return probs[k] / z


# ─── DIXON-COLES ADJUSTMENT ───────────────────────────────────
def get_dixon_coles_adjustment(lh, la, h, a, rho):
    if h == 0 and a == 0:
        return 1.0 - (lh * la * rho)
    elif h == 1 and a == 0:
        return 1.0 + (la * rho)
    elif h == 0 and a == 1:
        return 1.0 + (lh * rho)
    elif h == 1 and a == 1:
        return 1.0 - rho
    return 1.0


# ─── RUE-SALVESEN ADJUSTMENT ──────────────────────────────────
def get_rue_salvesen_lambda(mu, hfa, att_h, deff_h, att_a, deff_a, gamma):
    """Return (λ_home, λ_away) adjusted by Rue-Salvesen (2001)."""
    log_lh = mu + hfa + att_h - deff_a
    log_la = mu + att_a - deff_h
    delta = (att_h + deff_h - att_a - deff_a) / 2.0
    log_lh_adj = log_lh - gamma * delta
    log_la_adj = log_la + gamma * delta
    return math.exp(min(log_lh_adj, 10.0)), math.exp(min(log_la_adj, 10.0))


# ─── CORE NEGATIVE LOG-LIKELIHOOD ─────────────────────────────
def _nll_base(params, matches, time_weights, num_teams, team_map,
              mu_fixed=None, hfa_fixed=None, rho_fixed=None, gamma_fixed=None,
              att_fixed=None, deff_fixed=None):
    """Flexible NLL that handles fixed params by shifting indices."""
    idx = 0
    mu = mu_fixed if mu_fixed is not None else params[idx]; idx += 0 if mu_fixed is not None else 1
    hfa = hfa_fixed if hfa_fixed is not None else params[idx]; idx += 0 if hfa_fixed is not None else 1
    rho = rho_fixed if rho_fixed is not None else params[idx]; idx += 0 if rho_fixed is not None else 1
    gamma = gamma_fixed if gamma_fixed is not None else params[idx]; idx += 0 if gamma_fixed is not None else 1

    use_dc = rho_fixed is None
    use_rs = gamma_fixed is None

    att = np.zeros(num_teams)
    deff = np.zeros(num_teams)
    for i in range(num_teams):
        att[i] = att_fixed[i] if att_fixed is not None else params[idx + i]
        deff[i] = deff_fixed[i] if deff_fixed is not None else params[idx + num_teams + i]

    log_like = 0.0
    for i, m in enumerate(matches):
        h_idx = team_map[m['home']]
        a_idx = team_map[m['away']]
        hg = m['home_goals']
        ag = m['away_goals']
        w = time_weights[i] if i < len(time_weights) else 1.0

        if use_rs:
            lh, la = get_rue_salvesen_lambda(mu, hfa, att[h_idx], deff[h_idx],
                                              att[a_idx], deff[a_idx], gamma)
        else:
            log_lh = mu + hfa + att[h_idx] - deff[a_idx]
            log_la = mu + att[a_idx] - deff[h_idx]
            lh = math.exp(min(log_lh, 10.0))
            la = math.exp(min(log_la, 10.0))

        p_hg = poisson_pmf(lh, hg)
        p_ag = poisson_pmf(la, ag)
        adj = get_dixon_coles_adjustment(lh, la, hg, ag, rho) if use_dc else 1.0

        prob = p_hg * p_ag * adj
        if prob > 1e-15:
            log_like += w * math.log(prob)
        else:
            log_like -= 100.0 * w

    return -log_like


# ─── MLE: BASE POISSON (no adjustment) ────────────────────────
def fit_base_poisson(matches, time_weights=None):
    """Fit the base Poisson model (mu, hfa, attack, defense). No DC/RS."""
    if not _HAS_SCIPY:
        return {'success': False, 'error': 'scipy not available'}
    if len(matches) < 10:
        return {'success': False, 'error': 'Not enough matches'}

    teams, team_map, num_teams = _build_team_index(matches)
    if time_weights is None:
        time_weights = np.ones(len(matches), dtype=float)

    n_params = 2 + 2 * num_teams
    x0 = np.zeros(n_params, dtype=float)
    x0[0] = 0.13
    x0[1] = 0.25

    cons = ({'type': 'eq', 'fun': lambda p: float(np.sum(p[2:2 + num_teams]))})
    bounds = [(None, None), (0.0, 1.0)] + [(-3.0, 3.0)] * (2 * num_teams)

    try:
        res = minimize(
            lambda p: _nll_base(p, matches, time_weights, num_teams, team_map,
                               rho_fixed=0.0, gamma_fixed=0.0),
            x0, method='SLSQP', constraints=cons, bounds=bounds,
            options={'maxiter': 500, 'ftol': 1e-6})
        if res.success:
            fitted = res.x
            return {
                'success': True, 'mu': float(fitted[0]), 'hfa': float(fitted[1]),
                'attack': {teams[i]: float(fitted[2 + i]) for i in range(num_teams)},
                'defense': {teams[i]: float(fitted[2 + num_teams + i]) for i in range(num_teams)},
                'teams': teams, 'num_matches': len(matches), 'model': 'poisson'
            }
        return {'success': False, 'error': f'Optimizer failed: {res.message}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def _build_team_index(matches):
    teams = []
    seen = set()
    for m in matches:
        for t in (m['home'], m['away']):
            if t not in seen:
                seen.add(t)
                teams.append(t)
    return teams, {t: i for i, t in enumerate(teams)}, len(teams)


# ─── MLE: DIXON-COLES (fits mu, hfa, rho, attack, defense) ───
def fit_dixon_coles(matches, time_weights=None):
    if not _HAS_SCIPY:
        return {'success': False, 'error': 'scipy not available'}
    if len(matches) < 10:
        return {'success': False, 'error': 'Not enough matches'}

    teams, team_map, num_teams = _build_team_index(matches)
    if time_weights is None:
        time_weights = np.ones(len(matches), dtype=float)

    n_params = 3 + 2 * num_teams
    x0 = np.zeros(n_params, dtype=float)
    x0[0] = 0.13
    x0[1] = 0.25
    x0[2] = -0.10

    cons = ({'type': 'eq', 'fun': lambda p: float(np.sum(p[3:3 + num_teams]))})
    bounds = [(None, None), (0.0, 1.0), (-0.3, 0.3)] + [(-3.0, 3.0)] * (2 * num_teams)

    try:
        res = minimize(
            lambda p: _nll_base(p, matches, time_weights, num_teams, team_map,
                               gamma_fixed=0.0),
            x0, method='SLSQP', constraints=cons, bounds=bounds,
            options={'maxiter': 500, 'ftol': 1e-6})
        if res.success:
            fitted = res.x
            return {
                'success': True, 'mu': float(fitted[0]), 'hfa': float(fitted[1]),
                'rho': float(fitted[2]),
                'attack': {teams[i]: float(fitted[3 + i]) for i in range(num_teams)},
                'defense': {teams[i]: float(fitted[3 + num_teams + i]) for i in range(num_teams)},
                'teams': teams, 'num_matches': len(matches), 'model': 'dixon_coles'
            }
        return {'success': False, 'error': f'Optimizer failed: {res.message}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── MLE: RUE-SALVESEN (fits mu, hfa, gamma, attack, defense) ─
def fit_rue_salvesen(matches, time_weights=None):
    if not _HAS_SCIPY:
        return {'success': False, 'error': 'scipy not available'}
    if len(matches) < 10:
        return {'success': False, 'error': 'Not enough matches'}

    teams, team_map, num_teams = _build_team_index(matches)
    if time_weights is None:
        time_weights = np.ones(len(matches), dtype=float)

    n_params = 3 + 2 * num_teams
    x0 = np.zeros(n_params, dtype=float)
    x0[0] = 0.13
    x0[1] = 0.25
    x0[2] = 0.05

    cons = ({'type': 'eq', 'fun': lambda p: float(np.sum(p[3:3 + num_teams]))})
    bounds = [(None, None), (0.0, 1.0), (0.0, 0.5)] + [(-3.0, 3.0)] * (2 * num_teams)

    try:
        res = minimize(
            lambda p: _nll_base(p, matches, time_weights, num_teams, team_map,
                               rho_fixed=0.0),
            x0, method='SLSQP', constraints=cons, bounds=bounds,
            options={'maxiter': 500, 'ftol': 1e-6})
        if res.success:
            fitted = res.x
            return {
                'success': True, 'mu': float(fitted[0]), 'hfa': float(fitted[1]),
                'gamma': float(fitted[2]),
                'attack': {teams[i]: float(fitted[3 + i]) for i in range(num_teams)},
                'defense': {teams[i]: float(fitted[3 + num_teams + i]) for i in range(num_teams)},
                'teams': teams, 'num_matches': len(matches), 'model': 'rue_salvesen'
            }
        return {'success': False, 'error': f'Optimizer failed: {res.message}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── TWO-STEP ESTIMATION ─────────────────────────────────────
def fit_two_step(matches, time_weights=None, second_step='dc'):
    """1) Fit base Poisson. 2) Fix att/def/mu/hfa, estimate rho or gamma only."""
    base = fit_base_poisson(matches, time_weights)
    if not base.get('success'):
        return base

    teams, team_map, num_teams = _build_team_index(matches)
    if time_weights is None:
        time_weights = np.ones(len(matches), dtype=float)

    att_fixed = np.array([base['attack'][t] for t in teams])
    deff_fixed = np.array([base['defense'][t] for t in teams])
    mu_fixed = base['mu']
    hfa_fixed = base['hfa']

    if second_step == 'dc':
        x0 = np.array([-0.10])
        bounds = [(-0.3, 0.3)]
        rho_fixed = None
        gamma_fixed = 0.0
    else:
        x0 = np.array([0.05])
        bounds = [(0.0, 0.5)]
        rho_fixed = 0.0
        gamma_fixed = None

    try:
        res = minimize(
            lambda p: _nll_base(p, matches, time_weights, num_teams, team_map,
                               mu_fixed=mu_fixed, hfa_fixed=hfa_fixed,
                               rho_fixed=rho_fixed, gamma_fixed=gamma_fixed,
                               att_fixed=att_fixed, deff_fixed=deff_fixed),
            x0, method='L-BFGS-B', bounds=bounds,
            options={'maxiter': 200, 'ftol': 1e-6})
        result = {
            'success': res.success,
            'mu': mu_fixed, 'hfa': hfa_fixed,
            'attack': base['attack'], 'defense': base['defense'],
            'teams': teams, 'num_matches': len(matches),
            'model': f'poisson+{second_step}'
        }
        if res.success:
            if second_step == 'dc':
                result['rho'] = float(res.x[0])
            else:
                result['gamma'] = float(res.x[0])
        else:
            result['rho'] = -0.12
            result['gamma'] = 0.0
        return result
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── REVERSE-ENGINEER xG FROM 1X2 PROBABILITIES ──────────────
def expg_from_probabilities(p_home, p_draw, p_away, rho=-0.12):
    """Find (λ_h, λ_a) that best match the given 1x2 probabilities under Poisson + DC."""
    if not _HAS_SCIPY:
        return {'success': False, 'error': 'scipy not available'}
    from scipy.optimize import minimize

    def _probs(lh, la):
        p1, pd, p2 = 0.0, 0.0, 0.0
        for h in range(12):
            ph = poisson_pmf(lh, h)
            for a in range(12):
                pa = poisson_pmf(la, a)
                adj = get_dixon_coles_adjustment(lh, la, h, a, rho)
                prob = ph * pa * adj
                if h > a:
                    p1 += prob
                elif h == a:
                    pd += prob
                else:
                    p2 += prob
        total = p1 + pd + p2
        if total > 0:
            p1 /= total; pd /= total; p2 /= total
        return p1, pd, p2

    def objective(x):
        lh, la = max(0.01, x[0]), max(0.01, x[1])
        p1, pd, p2 = _probs(lh, la)
        return (p1 - p_home)**2 + (pd - p_draw)**2 + (p2 - p_away)**2

    res = minimize(objective, [1.5, 1.2], method='Nelder-Mead',
                   options={'maxiter': 1000, 'xatol': 1e-6, 'fatol': 1e-6})
    if res.success:
        lh, la = max(0.01, res.x[0]), max(0.01, res.x[1])
        p1, pd, p2 = _probs(lh, la)
        return {
            'success': True, 'expg_home': float(lh), 'expg_away': float(la),
            'fitted_probs': {'home': p1, 'draw': pd, 'away': p2},
            'error': float(res.fun)
        }
    return {'success': False, 'error': f'Optimizer failed: {res.message}'}


# ─── PICKLE CACHE ─────────────────────────────────────────────
def load_cache():
    ensure_cache_dir()
    if not os.path.exists(CACHE_FILE):
        return {}
    try:
        with open(CACHE_FILE, 'rb') as f:
            data = pickle.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        return {}
    return {}


def save_cache(cache):
    ensure_cache_dir()
    try:
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump(cache, f, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception as e:
        print(f"[GOALMODEL] Cache save failed: {e}")


def load_or_fit_goalmodel_parameters(league_name, db_conn=None, force_refit=False):
    cache = load_cache()
    entry = cache.get(league_name)

    if not force_refit and entry is not None:
        ts = entry.get('updated_at', 0)
        age_hours = (time.time() - ts) / 3600
        if age_hours < CACHE_TTL_HOURS:
            return entry

    if db_conn is None:
        return _fallback_params(league_name)

    try:
        cursor = db_conn.cursor()
        cursor.execute("CREATE TABLE IF NOT EXISTS historical_matches (id TEXT PRIMARY KEY, homeTeam TEXT, awayTeam TEXT, scoreHome INTEGER, scoreAway INTEGER, league TEXT, fullData TEXT, timestamp TEXT, archived_at DATETIME DEFAULT CURRENT_TIMESTAMP)")
        rows = cursor.execute(
            """SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp
               FROM historical_matches
               WHERE league = ?
               ORDER BY timestamp DESC LIMIT 200""",
            (league_name,)
        ).fetchall()

        if not rows or len(rows) < 10:
            return _fallback_params(league_name)

        matches = []
        now = datetime.utcnow()
        for r in rows:
            home = r[0] if r[0] else ''
            away = r[1] if r[1] else ''
            sh = int(r[2]) if r[2] is not None else 0
            sa = int(r[3]) if r[3] is not None else 0
            ts_str = r[4] if r[4] else ''
            match_date = None
            if ts_str:
                try:
                    match_date = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                except Exception:
                    match_date = None
            days_ago = 365
            if match_date:
                days_ago = max(0, (now - match_date).days)
            matches.append({
                'home': home,
                'away': away,
                'home_goals': sh,
                'away_goals': sa,
                'days_ago': days_ago
            })

        if len(matches) < 10:
            return _fallback_params(league_name)

        match_days = [m['days_ago'] for m in matches]
        time_weights = calculate_time_weights(match_days)
        result = fit_dixon_coles(matches, time_weights)

        if result.get('success'):
            result['league'] = league_name
            result['updated_at'] = time.time()
            result['distribution_type'] = _choose_distribution(matches)
            cache[league_name] = result
            save_cache(cache)
            return result

        return _fallback_params(league_name)

    except Exception as e:
        print(f"[GOALMODEL] Error fitting {league_name}: {e}")
        return _fallback_params(league_name)


def _fallback_params(league_name):
    return {
        'success': False,
        'league': league_name,
        'rho': -0.12,
        'gamma': 0.0,
        'hfa': 0.25,
        'mu': 0.13,
        'attack': {},
        'defense': {},
        'distribution_type': 'poisson',
        'model': 'poisson',
        'updated_at': 0
    }


def _choose_distribution(matches):
    goals = []
    for m in matches:
        goals.append(m['home_goals'])
        goals.append(m['away_goals'])
    if len(goals) < 4:
        return 'poisson'
    mean_g = np.mean(goals)
    var_g = np.var(goals)
    if mean_g <= 0:
        return 'poisson'
    vmr = var_g / mean_g
    if vmr > 1.15:
        return 'negbin'
    elif vmr < 0.85:
        return 'cmp'
    return 'poisson'


# ─── RANKED PROBABILITY SCORE (RPS) ──────────────────────────
def calculate_rps(probs, outcome_idx):
    p = np.array(probs, dtype=float)
    obs = np.zeros(3, dtype=float)
    obs[outcome_idx] = 1.0
    cum_p = np.cumsum(p)
    cum_obs = np.cumsum(obs)
    return float(np.sum((cum_p[:2] - cum_obs[:2]) ** 2) / 2.0)


def log_rps_to_accuracy_log(match_id, home_team, away_team, league_name,
                            probs, actual_outcome, predicted_selection):
    fpath = os.path.join(CACHE_DIR, 'accuracy_log.json')
    entry = {
        'matchId': match_id,
        'match': f"{home_team} vs {away_team}",
        'league': league_name,
        'homeP': round(probs[0] * 100, 1),
        'drawP': round(probs[1] * 100, 1),
        'awayP': round(probs[2] * 100, 1),
        'predicted': predicted_selection,
        'rps': round(calculate_rps(probs, actual_outcome), 4),
        'date': datetime.utcnow().isoformat()
    }
    try:
        existing_data = {}
        if os.path.exists(fpath):
            with open(fpath, 'r', encoding='utf-8') as f:
                existing_data = json.load(f)
        rps_log = existing_data.get('rps_log', [])
        rps_log.append(entry)
        rps_log = rps_log[-5000:]
        existing_data['rps_log'] = rps_log
        with open(fpath, 'w', encoding='utf-8') as f:
            json.dump(existing_data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return entry['rps']


# ─── ENSEMBLE MONTE CARLO (Poisson / NegBin / CMP) ──────────
def monte_carlo_simulation_goalmodel(xg_h, xg_a, distribution='poisson',
                                     theta=2.0, nu=1.0, rho=-0.12, gamma=0.0, iterations=1000):
    # Apply Rue-Salvesen gamma correction to xG (amplify/regress based on strength)
    if abs(gamma) > 0.001:
        _strength_ratio = (xg_h - xg_a) / max(xg_h + xg_a, 0.01)
        xg_h *= math.exp(-gamma * _strength_ratio)
        xg_a *= math.exp(gamma * _strength_ratio)

    h_wins = 0
    draws = 0
    a_wins = 0
    total_goals_list = []
    btts_count = 0

    cov = 0.15 * min(max(0.0, xg_h), max(0.0, xg_a))
    base_h = max(0.0, xg_h - cov)
    base_a = max(0.0, xg_a - cov)

    if distribution == 'negbin':
        p_success_h = theta / (theta + base_h) if base_h > 0 else 1.0
        p_success_a = theta / (theta + base_a) if base_a > 0 else 1.0
        n_success = theta
        home_goals = np.random.negative_binomial(n_success, p_success_h, iterations)
        away_goals = np.random.negative_binomial(n_success, p_success_a, iterations)
    elif distribution == 'cmp':
        def sample_cmp(lam, nu_val, max_k=25):
            k = 0
            while True:
                k = min(k, max_k)
                pk = cmp_pmf(lam, nu_val, k)
                if pk <= 0:
                    k = 0
                    continue
                if np.random.random() < pk:
                    return k
                k += 1
        home_goals = np.array([sample_cmp(base_h, nu) for _ in range(iterations)])
        away_goals = np.array([sample_cmp(base_a, nu) for _ in range(iterations)])
    else:
        home_goals = np.random.poisson(base_h, iterations)
        away_goals = np.random.poisson(base_a, iterations)

    shared_goals = np.random.poisson(cov, iterations)

    for i in range(iterations):
        gh = int(home_goals[i]) + int(shared_goals[i])
        ga = int(away_goals[i]) + int(shared_goals[i])
        if gh > ga:
            h_wins += 1
        elif gh < ga:
            a_wins += 1
        else:
            draws += 1
        total_goals_list.append(gh + ga)
        if gh > 0 and ga > 0:
            btts_count += 1

    return {
        "p_h": h_wins / iterations,
        "p_d": draws / iterations,
        "p_a": a_wins / iterations,
        "avg_total_goals": float(np.mean(total_goals_list)),
        "btts_prob": btts_count / iterations,
        "ou_25_prob": sum(1 for g in total_goals_list if g > 2.5) / iterations,
        "ou_15_prob": sum(1 for g in total_goals_list if g > 1.5) / iterations,
        "ou_35_prob": sum(1 for g in total_goals_list if g > 3.5) / iterations
    }


def calculate_most_likely_score_goalmodel(xg_h, xg_a, distribution='poisson',
                                          theta=2.0, nu=1.0, rho=-0.12, gamma=0.0):
    # Apply Rue-Salvesen gamma correction to xG
    if abs(gamma) > 0.001:
        _strength_ratio = (xg_h - xg_a) / max(xg_h + xg_a, 0.01)
        xg_h *= math.exp(-gamma * _strength_ratio)
        xg_a *= math.exp(gamma * _strength_ratio)
    best_score = (1, 1)
    best_prob = -1.0
    for h in range(8):
        for a in range(8):
            if distribution == 'negbin':
                prob = negbin_pmf(xg_h, theta, h) * negbin_pmf(xg_a, theta, a)
            elif distribution == 'cmp':
                prob = cmp_pmf(xg_h, nu, h) * cmp_pmf(xg_a, nu, a)
            else:
                prob = poisson_pmf(xg_h, h) * poisson_pmf(xg_a, a)
            prob *= get_dixon_coles_adjustment(xg_h, xg_a, h, a, rho)
            if prob > best_prob:
                best_prob = prob
                best_score = (h, a)
    return f"{best_score[0]} - {best_score[1]}"


# ─── STANDALONE BTTS / O/U PREDICTORS ──────────────────────────

def predict_btts(xg_h, xg_a, distribution='poisson', theta=2.0, nu=1.0, rho=-0.12, gamma=0.0):
    """Calculate both teams to score probability directly from xG."""
    if abs(gamma) > 0.001:
        _strength_ratio = (xg_h - xg_a) / max(xg_h + xg_a, 0.01)
        xg_h *= math.exp(-gamma * _strength_ratio)
        xg_a *= math.exp(gamma * _strength_ratio)
    btts = 0.0
    for h in range(15):
        for a in range(15):
            if h > 0 and a > 0:
                if distribution == 'negbin':
                    prob = negbin_pmf(xg_h, theta, h) * negbin_pmf(xg_a, theta, a)
                elif distribution == 'cmp':
                    prob = cmp_pmf(xg_h, nu, h) * cmp_pmf(xg_a, nu, a)
                else:
                    prob = poisson_pmf(xg_h, h) * poisson_pmf(xg_a, a)
                prob *= get_dixon_coles_adjustment(xg_h, xg_a, h, a, rho)
                btts += prob
    return min(btts, 1.0)


def predict_ou(xg_h, xg_a, threshold=2.5, distribution='poisson', theta=2.0, nu=1.0, rho=-0.12, gamma=0.0):
    """Calculate over/under threshold probability directly from xG."""
    if abs(gamma) > 0.001:
        _strength_ratio = (xg_h - xg_a) / max(xg_h + xg_a, 0.01)
        xg_h *= math.exp(-gamma * _strength_ratio)
        xg_a *= math.exp(gamma * _strength_ratio)
    over = 0.0
    for h in range(15):
        for a in range(15):
            if h + a > threshold:
                if distribution == 'negbin':
                    prob = negbin_pmf(xg_h, theta, h) * negbin_pmf(xg_a, theta, a)
                elif distribution == 'cmp':
                    prob = cmp_pmf(xg_h, nu, h) * cmp_pmf(xg_a, nu, a)
                else:
                    prob = poisson_pmf(xg_h, h) * poisson_pmf(xg_a, a)
                prob *= get_dixon_coles_adjustment(xg_h, xg_a, h, a, rho)
                over += prob
    return min(over, 1.0)


# ─── CMP TOOLKIT ───────────────────────────────────────────────

def eCMP(lam, nu, max_k=25):
    """Expected value of CMP distribution (numeric approximation)."""
    total_prob = 0.0
    expected = 0.0
    for k in range(max_k + 1):
        pk = cmp_pmf(lam, nu, k, max_k)
        total_prob += pk
        expected += k * pk
    return expected / max(total_prob, 1e-10)


def lambdaCMP(mu, nu, max_k=25):
    """Find λ for CMP given target mean μ and dispersion ν (Newton-Raphson)."""
    lam = max(mu, 0.1)
    for _ in range(50):
        f_val = eCMP(lam, nu, max_k) - mu
        if abs(f_val) < 1e-6:
            break
        eps = max(lam * 1e-4, 1e-6)
        df = (eCMP(lam + eps, nu, max_k) - eCMP(lam - eps, nu, max_k)) / (2 * eps)
        if abs(df) < 1e-12:
            break
        lam -= f_val / df
        lam = max(lam, 0.001)
    return lam


def pCMP(lam, nu, k, lower_tail=True, max_k=25):
    """CDF of CMP distribution. If lower_tail=True, returns P(X ≤ k)."""
    total = 0.0
    if lower_tail:
        for j in range(k + 1):
            total += cmp_pmf(lam, nu, j, max_k)
    else:
        for j in range(k + 1, max_k + 1):
            total += cmp_pmf(lam, nu, j, max_k)
    return min(total, 1.0)


# ─── HURDLE MODEL (separate 0-0 probability) ───────────────────

def predict_hurdle(xg_h, xg_a, pi0=0.08, distribution='poisson', theta=2.0, nu=1.0, rho=-0.12, gamma=0.0):
    """Hurdle model: separate inflation for 0-0 draws.
    pi0 is the extra probability mass on 0-0 beyond the base Poisson.
    Returns full probability table adjusted for zero-inflation.
    """
    if abs(gamma) > 0.001:
        _strength_ratio = (xg_h - xg_a) / max(xg_h + xg_a, 0.01)
        xg_h *= math.exp(-gamma * _strength_ratio)
        xg_a *= math.exp(gamma * _strength_ratio)

    # Compute base Poisson probabilities
    total = 0.0
    probs = {}
    for h in range(12):
        for a in range(12):
            if distribution == 'negbin':
                ph = negbin_pmf(xg_h, theta, h)
                pa = negbin_pmf(xg_a, theta, a)
            elif distribution == 'cmp':
                ph = cmp_pmf(xg_h, nu, h)
                pa = cmp_pmf(xg_a, nu, a)
            else:
                ph = poisson_pmf(xg_h, h)
                pa = poisson_pmf(xg_a, a)
            prob = ph * pa * get_dixon_coles_adjustment(xg_h, xg_a, h, a, rho)
            probs[(h, a)] = prob
            total += prob

    # Normalize and apply hurdle
    if total > 0:
        for k in probs:
            probs[k] /= total

    base_00 = probs.get((0, 0), 0.0)
    inflated_00 = base_00 + pi0 * (1.0 - base_00)
    scaling = (1.0 - inflated_00) / max(1.0 - base_00, 1e-10)

    result = {}
    total_check = 0.0
    for (h, a), prob in probs.items():
        if h == 0 and a == 0:
            result[(h, a)] = inflated_00
        else:
            result[(h, a)] = prob * scaling
        total_check += result[(h, a)]

    # Renormalize
    if total_check > 0:
        for k in result:
            result[k] /= total_check

    # Aggregate
    p_home = sum(prob for (h, a), prob in result.items() if h > a)
    p_draw = sum(prob for (h, a), prob in result.items() if h == a)
    p_away = sum(prob for (h, a), prob in result.items() if h < a)
    btts = sum(prob for (h, a), prob in result.items() if h > 0 and a > 0)

    return {
        'p_home': p_home, 'p_draw': p_draw, 'p_away': p_away,
        'btts': btts, 'p_00': result.get((0, 0), 0.0),
        'full_table': result
    }


# ─── ADDITIONAL COVARIATES MODEL ───────────────────────────────

def fit_covariate_model(matches, covariates, time_weights=None):
    """Fit Poisson model with additional external covariates (x1, x2 per match).
    covariates: list of dicts with 'x1', 'x2' per match.
    Returns: fitted parameters including beta1, beta2 for the covariates.
    """
    if not _HAS_SCIPY:
        return {'success': False, 'error': 'scipy not available'}
    if len(matches) < 10:
        return {'success': False, 'error': 'Not enough matches'}
    if len(matches) != len(covariates):
        return {'success': False, 'error': 'Covariates length mismatch'}

    teams, team_map, num_teams = _build_team_index(matches)
    if time_weights is None:
        time_weights = np.ones(len(matches), dtype=float)

    def _nll_cov(params):
        mu = params[0]
        hfa = max(0, params[1])
        beta1 = params[2]
        beta2 = params[3]
        att = np.zeros(num_teams)
        deff = np.zeros(num_teams)
        for i in range(num_teams):
            att[i] = params[4 + i]
            deff[i] = params[4 + num_teams + i]
        log_like = 0.0
        for i, m in enumerate(matches):
            h_idx = team_map[m['home']]
            a_idx = team_map[m['away']]
            hg = m['home_goals']
            ag = m['away_goals']
            w = time_weights[i] if i < len(time_weights) else 1.0
            x1 = covariates[i].get('x1', 0.0)
            x2 = covariates[i].get('x2', 0.0)
            log_lh = mu + hfa + att[h_idx] - deff[a_idx] + beta1 * x1 + beta2 * x2
            log_la = mu + att[a_idx] - deff[h_idx] + beta1 * x2 + beta2 * x1
            lh = math.exp(min(log_lh, 10.0))
            la = math.exp(min(log_la, 10.0))
            ph = poisson_pmf(lh, hg)
            pa = poisson_pmf(la, ag)
            prob = ph * pa
            if prob > 1e-15:
                log_like += w * math.log(prob)
            else:
                log_like -= 100.0 * w
        return -log_like

    n_params = 4 + 2 * num_teams
    x0 = np.zeros(n_params, dtype=float)
    x0[0] = 0.13
    x0[1] = 0.25
    x0[2] = 0.0
    x0[3] = 0.0

    cons = ({'type': 'eq', 'fun': lambda p: float(np.sum(p[4:4 + num_teams]))})
    bounds = [(None, None), (0.0, 1.0), (None, None), (None, None)] + [(-3.0, 3.0)] * (2 * num_teams)

    try:
        res = minimize(_nll_cov, x0, method='SLSQP', constraints=cons, bounds=bounds,
                       options={'maxiter': 500, 'ftol': 1e-6})
        if res.success:
            fitted = res.x
            return {
                'success': True, 'mu': float(fitted[0]), 'hfa': float(fitted[1]),
                'beta1': float(fitted[2]), 'beta2': float(fitted[3]),
                'attack': {teams[i]: float(fitted[4 + i]) for i in range(num_teams)},
                'defense': {teams[i]: float(fitted[4 + num_teams + i]) for i in range(num_teams)},
                'teams': teams, 'num_matches': len(matches), 'model': 'covariate'
            }
        return {'success': False, 'error': f'Optimizer failed: {res.message}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ─── OFFSET (EXTRA TIME / PROLONGATIONS) ──────────────────────

def apply_offset(xg_h, xg_a, offset_minutes=90, standard_minutes=90):
    """Scale xG for different match durations (e.g., extra time, shortened matches)."""
    if offset_minutes <= 0 or standard_minutes <= 0:
        return xg_h, xg_a
    factor = offset_minutes / standard_minutes
    return xg_h * factor, xg_a * factor
