"""
calibration_iso.py — Calibration 1X2 (Platt scaling).

E50 (2026-09-16) — DEUX changements majeurs vs la version isotonic :

1. SOURCE PAR MARCHÉ. Le fit 1X2 lit désormais `calibrationCurveByMarket['1X2']`
   du rapport unifié (accuracyEngine) au lieu de la courbe MIXTE tous marchés.
   La courbe mixte contient ~70% de DC et ~95% de OU : une "confidence 40%"
   y est en majorité un DC (gagne ~80%) et non un 1X2 (~28%). C'est ce qui
   produisait la bande 30-40 → 82.3% (du DC, pas du 1X2) et la non-monotonie
   en 40-50 → 61.5% / 50-60 → 46.1% que le fit interprétait comme du signal.

2. MÉTHODE PLATT au lieu d'ISOTONIC. À n=85 picks 1X2 (9-49 par bande),
   IsotonicRegression est structurellement trop flexible : elle peut produire
   une carte non-monotone ou du bruit sur de petits échantillons. Platt
   (régression logistique 1 paramètre sur logit(confidence)) est MONOTONE PAR
   CONSTRUCTION (coef A > 0 imposé) et adaptée aux petits volumes.

   Limite assumée : Platt ne peut pas reproduire une courbe en escalier ;
   la correction des bandes hautes (80-90 → 65.8%) est perdue. Acceptable tant
   que le volume 1X2 reste < quelques centaines de picks. Retour à isotonic
   possible plus tard si le volume le justifie.

En dessous de MIN_SAMPLES, isotonic_calibrate() retombe sur Platt.

Fichiers produits (models/) :
  isotonic_model.pkl   — objet PlattCalibrator (predict([[X en 0-100]]))
  isotonic_params.json — fitted_at, n_samples, coefs A/B, brier avant/après, status

Usage :
  python -m core.calibration_iso --fit      # après le backtest quotidien
  python -m core.calibration_iso --check    # état actuel + histogramme
"""
import os
import sys
import json
import pickle

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCURACY_LOG_PATH = os.path.join(ROOT, 'data', 'accuracy_log.json')
BACKTEST_PATH = os.path.join(ROOT, 'data', 'backtest_results.json')
ACCURACY_REPORT_PATH = os.path.join(ROOT, 'data', 'accuracy_report.json')
MODEL_PATH = os.path.join(ROOT, 'models', 'isotonic_model.pkl')
PARAMS_PATH = os.path.join(ROOT, 'models', 'isotonic_params.json')

MIN_SAMPLES = 30
AGG_WEIGHT = 0.5  # poids relatif des agrégats bracket (évite double-comptage)
PICK_MIN = 0.03
PICK_MAX = 0.97


class PlattCalibrator:
    """Régression logistique 1 paramètre sur logit(confidence) — monotone par
    construction. Interface compatible sklearn : `predict([[x]])` renvoie un
    array de probabilités calibrées.

    Modèle : P(win | p) = sigmoid(A * logit(p) + B)  avec A > 0 imposé.
    """

    def __init__(self, A, B):
        self.A = float(A)
        self.B = float(B)

    def predict(self, X):
        arr = np.asarray(X, dtype=np.float64).ravel()
        p = np.clip(arr / 100.0, 1e-6, 1 - 1e-6)
        z = np.log(p / (1.0 - p))
        out = 1.0 / (1.0 + np.exp(-(self.A * z + self.B)))
        return np.clip(out, 0.0, 1.0)


def _load_json(fpath, default=None):
    if not os.path.exists(fpath):
        return default
    try:
        with open(fpath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def _iter_accuracy_entries():
    """Yield (confidence, is_correct) per-pick for market 1X2, deduped."""
    log = _load_json(ACCURACY_LOG_PATH, {}) or {}
    if not isinstance(log, dict):
        return
    seen = set()
    groups = []
    if isinstance(log.get('byLeague'), dict):
        groups.append(log['byLeague'])
    if isinstance(log.get('entries'), list):
        groups.append({'__flat__': log['entries']})
    for group in groups:
        for entries in group.values():
            if not isinstance(entries, list):
                continue
            for e in entries:
                if not isinstance(e, dict) or e.get('market') != '1X2':
                    continue
                mid = e.get('match_id')
                if mid:
                    if mid in seen:
                        continue
                    seen.add(mid)
                conf = e.get('confidence')
                if not isinstance(conf, (int, float)) or conf <= 0:
                    continue
                is_correct = e.get('is_correct')
                if not isinstance(is_correct, bool):
                    continue
                yield conf, is_correct


def _bracket_aggregates():
    """Yield (midpoint_conf, win_rate, weight) from backtest bracketAccuracy.

    Audit V1 (2026-08-24) — garde anti-contamination : les brackets ne sont
    ingérés QUE si le rapport provient du chemin normal (prédictions
    enregistrées en base locale, snapshot fiable, flag provisional=False).
    L'ancien comportement avalait le rapport 'archived-fallback' non-snapshot
    (37% vs 66% rolling) : le modèle fitted le 2026-08-23T03:51:31 — cinq
    secondes après l'écriture du fallback (03:51:26) — en porte la trace.
    """
    report = _load_json(BACKTEST_PATH, {}) or {}
    brackets = report.get('bracketAccuracy') if isinstance(report, dict) else None
    if not isinstance(brackets, dict):
        return

    methodology = report.get('methodology')
    provisional = report.get('provisional')
    if methodology != 'local-db-72h-recorded-predictions' or provisional is not False:
        sys.stderr.write(
            '[ISO-CAL] brackets ignorés (source non-snapshot/provisional: '
            f'methodology={methodology!r}, provisional={provisional!r})\n'
        )
        return

    bounds = {'0-50': 25, '50-60': 55, '60-70': 65, '70-80': 75, '80-90': 85, '90+': 95}
    for band, mid in bounds.items():
        b = brackets.get(band)
        if not isinstance(b, dict):
            continue
        acc = b.get('accuracy')
        count = b.get('count')
        if not isinstance(acc, (int, float)) or not isinstance(count, (int, float)):
            continue
        if count < 1:
            continue
        yield mid, min(1.0, max(0.0, acc / 100.0)), float(count)


def _accuracy_report_aggregates(market='1X2'):
    """E50 — source unique accuracyEngine, COURBE PAR MARCHÉ.

    Yield (midpoint_conf, win_rate, weight) depuis
    `rolling.last30days.calibrationCurveByMarket[market]` (nouveau, E50) ;
    fallback sur la courbe globale si la ventilation par marché est absente
    (rétrocompat rapports pré-E50) — avec avertissement explicite, car la
    courbe globale mélange DC/OU et fausserait le fit 1X2.
    """
    report = _load_json(ACCURACY_REPORT_PATH, {}) or {}
    rolling = report.get('rolling', {}).get('last30days', {}) if isinstance(report, dict) else {}
    by_market = rolling.get('calibrationCurveByMarket') if isinstance(rolling, dict) else None
    curve = None
    if isinstance(by_market, dict) and isinstance(by_market.get(market), list):
        curve = by_market[market]
    else:
        curve = rolling.get('calibrationCurve') if isinstance(rolling, dict) else None
        if isinstance(curve, list):
            sys.stderr.write(
                f'[ISO-CAL] calibrationCurveByMarket[{market!r}] absente — repli sur la '
                'courbe GLOBALE (mélange DC/OU/1X2, fit potentiellement biaisé)\n'
            )
    if not isinstance(curve, list):
        sys.stderr.write('[ISO-CAL] accuracy_report.json: aucune courbe exploitable\n')
        return
    for band in curve:
        if not isinstance(band, dict):
            continue
        raw = str(band.get('band', ''))
        parts = raw.split('-')
        if len(parts) != 2:
            continue
        try:
            lo, hi = int(parts[0]), int(parts[1])
            acc = float(band.get('accuracy'))
            count = float(band.get('count') or 0)
        except (TypeError, ValueError):
            continue
        if count < MIN_SAMPLES:
            continue
        mid = (lo + hi) / 2.0
        yield mid, min(1.0, max(0.0, acc / 100.0)), count


def _platt_fit(Z, Y, W):
    """Fit Platt scaling (A, B) par minimisation de la log-loss PONDÉRÉE.

    Z = logit(confidence/100). Y = issues (0/1 par pick, ou taux pour un
    agrégat). W = poids. Contrainte A >= 1e-6 (monotone croissant en p).
    L-BFGS-B sur 2 paramètres — stable à n=85.
    """
    from scipy.optimize import minimize

    def nll(params):
        A, B = params
        z = A * Z + B
        p = 1.0 / (1.0 + np.exp(-np.clip(z, -60.0, 60.0)))
        p = np.clip(p, 1e-12, 1 - 1e-12)
        return -float(np.sum(W * (Y * np.log(p) + (1.0 - Y) * np.log(1.0 - p))))

    res = minimize(nll, [1.0, 0.0], method='L-BFGS-B', bounds=[(1e-6, None), (None, None)])
    return float(res.x[0]), float(res.x[1])


def fit():
    """Fit Platt (A, B) sur l'historique 1X2. Returns params dict."""
    X, y, w = [], [], []
    for conf, ok in _iter_accuracy_entries():
        X.append(float(conf))
        y.append(1.0 if ok else 0.0)
        w.append(1.0)
    # E50 : par défaut on lit la courbe 1X2 du rapport unifié (source unique,
    # ventilée par marché). ISO_SOURCE=brackets force l'ancienne source
    # (backtest_results.json), conservée pour compatibilité/diagnostic.
    iso_source = os.environ.get('ISO_SOURCE', 'accuracy_report').strip().lower()
    if iso_source == 'brackets':
        sys.stderr.write('[ISO-CAL] ISO_SOURCE=brackets — agrégats legacy backtest_results\n')
        aggregates = _bracket_aggregates()
    else:
        sys.stderr.write(
            '[ISO-CAL] ISO_SOURCE=accuracy_report — agrégats 1X2 depuis accuracyEngine\n'
        )
        aggregates = _accuracy_report_aggregates('1X2')
    for mid, rate, count in aggregates:
        X.append(float(mid))
        y.append(float(rate))
        w.append(float(count) * AGG_WEIGHT)

    n_samples = len(y)
    if n_samples < MIN_SAMPLES:
        msg = f'skipped: only {n_samples} 1X2 samples (< {MIN_SAMPLES})'
        sys.stderr.write(f'[ISO-CAL] {msg}\n')
        params = _load_json(PARAMS_PATH, {}) or {}
        params.update({'status': 'insufficient', 'n_samples': n_samples, 'note': msg})
        with open(PARAMS_PATH, 'w', encoding='utf-8') as f:
            json.dump(params, f, indent=2)
        return params

    X = np.array(X, dtype=np.float64)
    y = np.array(y, dtype=np.float64)
    w = np.array(w, dtype=np.float64)

    # Logit de la confiance (clip serré pour éviter ±inf sur p→0 ou 1).
    p = np.clip(X / 100.0, 1e-4, 1 - 1e-4)
    Z = np.log(p / (1.0 - p))

    A, B = _platt_fit(Z, y, w)
    model = PlattCalibrator(A, B)

    fitted = model.predict(X)
    brier_before = float(np.average((y - X / 100.0) ** 2, weights=w))
    brier_after = float(np.average((y - fitted) ** 2, weights=w))

    params = {
        'fitted_at': np.datetime64('now').item().isoformat(),
        'method': 'platt',
        'n_samples': n_samples,
        'A': round(A, 6),
        'B': round(B, 6),
        'min_conf': float(np.min(X)),
        'max_conf': float(np.max(X)),
        'brier_before': round(brier_before, 6),
        'brier_after': round(brier_after, 6),
        'status': 'fitted',
    }

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, 'wb') as f:
        pickle.dump(model, f)
    with open(PARAMS_PATH, 'w', encoding='utf-8') as f:
        json.dump(params, f, indent=2)

    print(f'[ISO-CAL] Platt fit on {n_samples} 1X2 samples  (A={A:.4f}, B={B:.4f})')
    print(f'   Brier before={brier_before:.4f} -> after={brier_after:.4f}')
    print(_calibration_probe(model))
    return params


def _calibration_probe(iso):
    lines = []
    for lo, hi in [(0, 50), (50, 60), (60, 70), (70, 80), (80, 90), (90, 101)]:
        c = (lo + hi) / 2.0
        if hi == 101:
            c = 95.0
        p = float(iso.predict([[c]])[0])
        lines.append(f'   conf {lo:>2}-{hi:<2}% -> calibrated {p*100:5.1f}%')
    return '\n'.join(lines)


def _load_model():
    if not os.path.exists(MODEL_PATH):
        return None
    try:
        with open(MODEL_PATH, 'rb') as f:
            return pickle.load(f)
    except Exception:
        return None


BACKTEST_MAX_AGE_DAYS = int(os.environ.get('ISO_BACKTEST_MAX_AGE_DAYS', '7'))


def _backtest_is_fresh():
    """True if data/backtest_results.json exists, has an 'updated' timestamp,
    and is at most ISO_BACKTEST_MAX_AGE_DAYS old. A stale backtest means the
    isotonic map was fit on outdated observations -> calibration must be
    neutralized to avoid miscalibrating served probabilities."""
    data = _load_json(BACKTEST_PATH)
    if not data:
        return False
    updated = data.get('updated')
    if not updated:
        return False
    try:
        from datetime import datetime
        ts = datetime.fromisoformat(str(updated).replace('Z', '+00:00'))
        now = datetime.now(ts.tzinfo) if ts.tzinfo else datetime.now()
        age_days = (now - ts).days
    except Exception:
        return False
    return age_days <= BACKTEST_MAX_AGE_DAYS


def isotonic_calibrate(p_h, p_d, p_a):
    """Apply the isotonic map to the top pick, then scale the two lower probs
    to fill the remaining mass (their relative ratio is preserved).
    Falls back to Platt when the model is absent (data insufficient).

    Audit gel cascade (2026-08-24) : tant que ISO_RUNTIME_APPLY=false, aucune
    transformation n'est appliquée (identité) — le modèle actuel est fité sur
    des données pré-fix ; seul le gate ISO (check_iso_gate.js --activate)
    réactive une calibration après refit sur données propres."""
    if os.environ.get('ISO_RUNTIME_APPLY', 'true').strip().lower() == 'false':
        return p_h, p_d, p_a
    model = _load_model()
    if model is None:
        try:
            from calibration import calibrate_probs
            return calibrate_probs(p_h, p_d, p_a, model_version='v54')
        except Exception:
            return p_h, p_d, p_a

    if not _backtest_is_fresh():
        sys.stderr.write(
            '[ISO-CAL] backtest_results.json stale (>%d days) — calibration neutralized\n'
            % BACKTEST_MAX_AGE_DAYS
        )
        return p_h, p_d, p_a

    probs = [p_h, p_d, p_a]
    idx = max(range(3), key=lambda i: probs[i])
    max_p = probs[idx]
    if max_p <= 0:
        return p_h, p_d, p_a

    calibrated = float(model.predict([[max_p * 100.0]])[0])
    calibrated = max(PICK_MIN, min(PICK_MAX, calibrated))

    out = list(probs)
    out[idx] = calibrated
    rest_sum = sum(v for i, v in enumerate(probs) if i != idx)
    if rest_sum > 0:
        scale = (1.0 - calibrated) / rest_sum
        for i in range(3):
            if i != idx:
                out[i] = probs[i] * scale

    total = sum(out)
    if total > 0:
        out = [v / total for v in out]
    return out[0], out[1], out[2]


def check():
    params = _load_json(PARAMS_PATH, {})
    print('Isotonic calibration state:')
    if not params:
        print('  No params yet - run `python -m core.calibration_iso --fit`')
        return
    for k, v in params.items():
        print(f'  {k}: {v}')
    if params.get('status') == 'fitted':
        model = _load_model()
        print('  Probe: P(pick win | confidence)')
        for c in (30, 50, 60, 70, 80, 90):
            p = float(model.predict([[float(c)]])[0])
            print(f'    conf {c}% -> {p*100:.1f}%')


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--fit', action='store_true', help='Fit isotonic calibration from 1X2 history')
    parser.add_argument('--check', action='store_true', help='Show current calibration state')
    args = parser.parse_args()
    if args.fit:
        fit()
    else:
        check()
