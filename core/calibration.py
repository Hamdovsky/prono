"""
calibration.py — Probability calibration for XGBoost outputs
Uses Platt scaling (logistic regression on model outputs) to produce
well-calibrated probabilities that reflect true outcome frequencies.

XGBoost raw probabilities tend to be over-confident (too close to 0 or 1).
Platt scaling fixes this by fitting: P(y=1|f) = 1/(1+exp(A*f+B))

To fit the calibrator: python -m core.calibration --fit
To see current calibration: python -m core.calibration --check
"""
import os, sys, json, math, pickle
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CALIBRATION_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'calibration_params.json')

# Default Platt params (A=scale, B=shift) — stored per model version
# |A| < 1 compresse les logits vers le centre (anti-overconfidence) :
# un favori à 75% est ramené vers ~69%, un outsider à 8% vers ~11%.
# (Un B>0 constant ne suffit pas : la renormalisation annule l'effet.)
DEFAULT_PARAMS = {
    'v23_home': {'A': -0.85, 'B': 0.0},
    'v23_draw': {'A': -0.90, 'B': 0.0},
    'v23_away': {'A': -0.85, 'B': 0.0},
    'v54_home': {'A': -0.85, 'B': 0.0},
    'v54_draw': {'A': -0.90, 'B': 0.0},
    'v54_away': {'A': -0.85, 'B': 0.0},
}

def load_calibration():
    if os.path.exists(CALIBRATION_PATH):
        try:
            with open(CALIBRATION_PATH, 'r') as f:
                return json.load(f)
        except:
            pass
    return dict(DEFAULT_PARAMS)

def save_calibration(params):
    os.makedirs(os.path.dirname(CALIBRATION_PATH), exist_ok=True)
    with open(CALIBRATION_PATH, 'w') as f:
        json.dump(params, f, indent=2)

def platt_scale(raw_prob, A, B):
    """Apply Platt scaling: calibrated = 1/(1+exp(A*logit(raw_prob) + B))"""
    if raw_prob <= 0 or raw_prob >= 1:
        return raw_prob
    logit = math.log(raw_prob / (1 - raw_prob))
    calibrated = 1.0 / (1.0 + math.exp(A * logit + B))
    return calibrated

def calibrate_probs(p_h, p_d, p_a, model_version='v54'):
    """Calibrate win/draw/away probabilities using fitted Platt params."""
    params = load_calibration()
    prefs = params.get(f'{model_version}_home', {'A': -1.0, 'B': 0.0})
    dprefs = params.get(f'{model_version}_draw', {'A': -1.0, 'B': 0.0})
    aprefs = params.get(f'{model_version}_away', {'A': -1.0, 'B': 0.0})

    c_h = platt_scale(p_h, prefs['A'], prefs['B'])
    c_d = platt_scale(p_d, dprefs['A'], dprefs['B'])
    c_a = platt_scale(p_a, aprefs['A'], aprefs['B'])

    total = c_h + c_d + c_a
    if total > 0:
        c_h, c_d, c_a = c_h / total, c_d / total, c_a / total

    return c_h, c_d, c_a

def fit_calibration(model_home_probs, model_draw_probs, model_away_probs, outcomes):
    """
    Fit Platt scaling parameters using scikit-learn's LogisticRegression.
    model_X_probs: list of raw XGBoost probability vectors
    outcomes: list of actual outcomes ('H', 'D', 'A')
    """
    from sklearn.linear_model import LogisticRegression

    params = load_calibration()

    for label, probs in [('home', model_home_probs), ('draw', model_draw_probs), ('away', model_away_probs)]:
        probs = np.array(probs)
        probs = np.clip(probs, 1e-7, 1 - 1e-7)
        logits = np.log(probs / (1 - probs))

        y = np.array([1 if o.lower() == label[0] else 0 for o in outcomes])

        lr = LogisticRegression(C=1e10, solver='lbfgs')
        lr.fit(logits.reshape(-1, 1), y)

        A = lr.coef_[0][0]
        B = lr.intercept_[0]
        # Negate because sklearn uses P=1/(1+exp(-(w*x+b))) while
        # platt_scale uses P=1/(1+exp(A*x+B))
        params[f'v54_{label}'] = {'A': round(-A, 4), 'B': round(-B, 4)}
        print(f"  {label}: raw_A={A:.4f} raw_B={B:.4f} -> calibrated A={-A:.4f} B={-B:.4f}")

    save_calibration(params)
    print(f"Saved calibration to {CALIBRATION_PATH}")
    return params

def check_calibration():
    """Show current calibration params."""
    params = load_calibration()
    print("Current calibration parameters:")
    for k, v in params.items():
        print(f"  {k}: A={v['A']:.4f}, B={v['B']:.4f}")

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--fit', action='store_true', help='Fit calibration from XGBoost training data')
    parser.add_argument('--check', action='store_true', help='Show current calibration params')
    args = parser.parse_args()
    if args.check:
        check_calibration()
    elif args.fit:
        from pg_connector import query, using_postgres
        if not using_postgres():
            print("DATABASE_URL required for fitting")
            sys.exit(1)
        print("Fitting calibration from Neon historical data (odds→probs proxy)...")
        probs = query("""
            SELECT odds_home, odds_draw, odds_away, goals_home, goals_away
            FROM soccer_fixtures
            WHERE odds_home IS NOT NULL AND odds_home > 0
              AND odds_draw IS NOT NULL AND odds_draw > 0
              AND odds_away IS NOT NULL AND odds_away > 0
              AND goals_home IS NOT NULL AND goals_away IS NOT NULL
            ORDER BY date DESC
            LIMIT 10000
        """)
        if probs and len(probs) > 100:
            import math
            home_probs, draw_probs, away_probs, outcomes = [], [], [], []
            for r in probs:
                oh = float(r['odds_home'])
                od = float(r['odds_draw'])
                oa = float(r['odds_away'])
                total_implied = 1.0/oh + 1.0/od + 1.0/oa
                home_probs.append((1.0/oh) / total_implied)
                draw_probs.append((1.0/od) / total_implied)
                away_probs.append((1.0/oa) / total_implied)
                gh = float(r['goals_home'])
                ga = float(r['goals_away'])
                outcomes.append('H' if gh > ga else ('A' if gh < ga else 'D'))
            fit_calibration(home_probs, draw_probs, away_probs, outcomes)
        else:
            print("Not enough calibration data. Using defaults.")
            save_calibration(DEFAULT_PARAMS)
            check_calibration()
    else:
        check_calibration()
