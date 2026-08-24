"""
calibration_iso.py — Isotonic calibration des probabilités 1X2

Corrige le sur-décalage observé (bracket 70-80% → 33% réel, 90+ → 0%).
Platt (calibration.py) applique une carte logistique globale ; ici on
ajuste une carte monotone confidence → taux réel de victoire via
sklearn.isotonic.IsotonicRegression.

IMPORTANT — Données strictement 1X2 uniquement :
  * data/accuracy_log.json, marché '1X2' (confidence = proba du pick 1/X/2,
    is_correct = le pick a gagné). Les entrées DC/OTHER mélangent d'autres
    échelles (un DC @ 40% gagne ~80% du temps) et écrasent le fit.
  * data/backtest_results.json, bracketAccuracy — agrégats réels (100 matchs),
    injectés comme points synthétiques pondérés (×0.5) pour éviter le
    double-comptage avec les entrées per-pick du log.

En dessous de MIN_SAMPLES, isotonic_calibrate() retombe sur Platt.

Fichiers produits (models/) :
  isotonic_model.pkl   — l'IsotonicRegression (X en 0-100)
  isotonic_params.json — fitted_at, n_samples, brier avant/après, status

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


def _accuracy_report_aggregates():
    """V2-prêt (audit 2026-08-24) — source unique accuracyEngine.

    Yield (midpoint_conf, win_rate, weight) depuis la calibrationCurve du
    rapport unifié data/accuracy_report.json (rolling 30j, snapshot au temps
    T, tous marchés). Activée uniquement par ISO_SOURCE=accuracy_report —
    refit effectif DIFFÉRÉ jusqu'à disposer d'échantillons post-P1 (n≥200,
    voir CHANGELOG_AUDIT.md « Vérifications différées »).

    ⚠️ Échelle : ces bins portent sur la probabilité du pick (tous marchés),
    pas sur la confiance 1X2 pure historique — divergence de périmètre à
    garder en tête lors de la comparaison avec les entrées per-pick du log.
    """
    report = _load_json(ACCURACY_REPORT_PATH, {}) or {}
    curve = (
        report.get('rolling', {}).get('last30days', {}).get('calibrationCurve')
        if isinstance(report, dict)
        else None
    )
    if not isinstance(curve, list):
        sys.stderr.write('[ISO-CAL] accuracy_report.json: calibrationCurve absente\n')
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
        yield mid, min(1.0, max(0.0, acc / 100.0)), count * AGG_WEIGHT


def fit():
    """Fit the isotonic map from settled 1X2 history. Returns params dict."""
    try:
        from sklearn.isotonic import IsotonicRegression
    except Exception:
        sys.stderr.write('[ISO-CAL] sklearn unavailable - isotonic fitting skipped\n')
        return {'status': 'unavailable'}

    X, y, w = [], [], []
    for conf, ok in _iter_accuracy_entries():
        X.append([float(conf)])
        y.append(1.0 if ok else 0.0)
        w.append(1.0)
    # V2-prêt : source des agrégats commutable par ISO_SOURCE.
    #  - 'brackets' (défaut)  : backtest_results.json — UNIQUEMENT si le rapport
    #    est un snapshot fiable (garde anti-contamination V1), sinon vide.
    #  - 'accuracy_report'    : calibrationCurve du rapport unifié accuracyEngine
    #    (à activer quand les données post-P1 sont suffisantes, refit différé).
    iso_source = os.environ.get('ISO_SOURCE', 'brackets').strip().lower()
    if iso_source == 'accuracy_report':
        sys.stderr.write(
            '[ISO-CAL] ISO_SOURCE=accuracy_report — agrégats depuis accuracyEngine\n'
        )
        aggregates = _accuracy_report_aggregates()
    else:
        aggregates = _bracket_aggregates()
    for mid, rate, count in aggregates:
        X.append([float(mid)])
        y.append(float(rate))
        w.append(AGG_WEIGHT * count)

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

    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds='clip')
    iso.fit(X, y, sample_weight=w)

    fitted = iso.predict(X)
    brier_before = float(np.average((y - X[:, 0] / 100.0) ** 2, weights=w))
    brier_after = float(np.average((y - fitted) ** 2, weights=w))

    params = {
        'fitted_at': np.datetime64('now').item().isoformat(),
        'n_samples': n_samples,
        'min_conf': float(np.min(X)),
        'max_conf': float(np.max(X)),
        'brier_before': round(brier_before, 6),
        'brier_after': round(brier_after, 6),
        'status': 'fitted',
    }

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, 'wb') as f:
        pickle.dump(iso, f)
    with open(PARAMS_PATH, 'w', encoding='utf-8') as f:
        json.dump(params, f, indent=2)

    print(f'[ISO-CAL] Fitted on {n_samples} 1X2 samples (log + backtest brackets)')
    print(f'   Brier before={brier_before:.4f} -> after={brier_after:.4f}')
    print(_calibration_probe(iso))
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
