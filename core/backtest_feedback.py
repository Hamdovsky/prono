"""
core/backtest_feedback.py — Calibration feedback loop for Poisson/XGBoost blend.

Reads:
  - data/calibration_metrics.json (Brier Score + LogLoss per league, written by autoBacktestService.js)
  - data/league_dynamic_weights.json (xgb_weight per league)
  - data/accuracy_history.json (win rates per league::market)

Writes:
  - data/calibration_weights.json (per-league blend adjustments based on calibration quality)

Logic:
  - Low Brier Score (< 0.20) = well-calibrated model → increase model trust
  - High Brier Score (> 0.30) = poor calibration → decrease model trust, increase Poisson weight
  - High LogLoss relative to Brier → model is overconfident on wrong predictions → reduce XGB weight
  - O/U calibration: if brierOU is high → model struggles with totals → adjust Under/Over bias

Usage:
    python core/backtest_feedback.py              # Generate calibration weights
    python core/backtest_feedback.py --summary    # Print calibration summary
"""
import os, sys, json, argparse, math

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

CALIBRATION_PATH = os.path.join(DATA_DIR, 'calibration_metrics.json')
DYNAMIC_WEIGHTS_PATH = os.path.join(DATA_DIR, 'league_dynamic_weights.json')
ACCURACY_HISTORY_PATH = os.path.join(DATA_DIR, 'accuracy_history.json')
OUTPUT_PATH = os.path.join(DATA_DIR, 'calibration_weights.json')


def _load_json(p, default=None):
    try:
        with open(p, 'r') as f:
            return json.load(f)
    except Exception:
        return default or {}


def compute_calibration_weights(calibration_metrics, dynamic_weights, accuracy_history):
    """
    Compute per-league blend adjustments based on Brier Score + LogLoss.

    Returns dict: { league: { xgb_adjustment, poisson_adjustment, ou_bias, confidence, quality } }
    """
    weights = {}

    for league, metrics in calibration_metrics.items():
        if league.startswith('_'):
            continue

        brier = metrics.get('brier1x2')
        logloss = metrics.get('logloss1x2')
        brier_ou = metrics.get('brierOU')
        matches = metrics.get('matches', 0)

        if brier is None or matches < 3:
            continue

        # Quality classification based on Brier Score
        # Perfect calibration: Brier = 0
        # Random predictions: Brier ≈ 0.222 (uniform 1/3 for 3 outcomes)
        # Worse than random: Brier > 0.25
        if brier < 0.15:
            quality = 'excellent'
            xgb_adj = 0.05   # slightly boost model trust
            poi_adj = -0.05
        elif brier < 0.20:
            quality = 'good'
            xgb_adj = 0.02
            poi_adj = -0.02
        elif brier < 0.25:
            quality = 'fair'
            xgb_adj = 0.0
            poi_adj = 0.0
        elif brier < 0.30:
            quality = 'poor'
            xgb_adj = -0.05
            poi_adj = 0.05
        else:
            quality = 'very_poor'
            xgb_adj = -0.12
            poi_adj = 0.12

        # Overconfidence penalty: if logloss >> brier, model is overconfident on wrong calls
        if brier > 0 and logloss is not None:
            logloss_ratio = logloss / max(brier, 1e-6)
            if logloss_ratio > 1.5:
                # Overconfident: reduce XGB weight extra
                xgb_adj -= 0.05
                poi_adj += 0.05

        # O/U calibration
        ou_bias = 0.0
        if brier_ou is not None:
            if brier_ou > 0.28:
                # Poor O/U calibration → model struggles with totals
                # Slight positive bias to counter Under 2.5 tendency
                ou_bias = 2.0
            elif brier_ou < 0.20:
                ou_bias = 0.0

        # Confidence level: how much to trust this adjustment
        confidence = min(1.0, matches / 20.0)  # full confidence at 20+ matches

        weights[league] = {
            'xgb_adjustment': round(xgb_adj, 4),
            'poisson_adjustment': round(poi_adj, 4),
            'ou_bias': round(ou_bias, 2),
            'quality': quality,
            'brier1x2': brier,
            'logloss1x2': logloss,
            'brierOU': brier_ou,
            'confidence': round(confidence, 3),
            'matches': matches,
        }

    # Always include DEFAULT
    weights['DEFAULT'] = {
        'xgb_adjustment': 0.0,
        'poisson_adjustment': 0.0,
        'ou_bias': 0.0,
        'quality': 'unknown',
        'confidence': 0.0,
    }

    return weights


def print_summary(calibration_metrics):
    """Print human-readable calibration summary."""
    print("=" * 70)
    print("CALIBRATION FEEDBACK SUMMARY")
    print("=" * 70)

    # Global
    g = calibration_metrics.get('_global', {})
    if g:
        brier = g.get('brier1x2', 0)
        ll = g.get('logloss1x2', 0)
        n = g.get('matches', 0)
        print(f"\n  Global: Brier={brier:.4f}  LogLoss={ll:.4f}  ({n} matches)")
        print(f"  Quality: {'Excellent' if brier < 0.15 else 'Good' if brier < 0.20 else 'Fair' if brier < 0.25 else 'Poor' if brier < 0.30 else 'Very Poor'}")

    # Per-league
    leagues = {k: v for k, v in calibration_metrics.items() if not k.startswith('_') and v.get('matches', 0) >= 3}
    if leagues:
        print(f"\n  Per-League Calibration ({len(leagues)} leagues):")
        print(f"  {'League':<35} {'Brier':>7} {'LogLoss':>9} {'OU':>7} {'N':>5}")
        print(f"  {'-'*35} {'-'*7} {'-'*9} {'-'*7} {'-'*5}")
        for lg, m in sorted(leagues.items(), key=lambda x: x[1].get('brier1x2', 1)):
            brier = m.get('brier1x2', 0)
            ll = m.get('logloss1x2', 0)
            brier_ou = m.get('brierOU', 0)
            n = m.get('matches', 0)
            marker = '✓' if brier < 0.20 else '~' if brier < 0.25 else '✗'
            print(f"  {lg:<35} {brier:>6.4f} {ll:>8.4f} {brier_ou:>6.4f} {n:>5} {marker}")
    print()


def main():
    parser = argparse.ArgumentParser(description='Calibration feedback for blend weight adjustment')
    parser.add_argument('--summary', action='store_true', help='Print calibration summary only')
    args = parser.parse_args()

    calibration_metrics = _load_json(CALIBRATION_PATH, {})
    dynamic_weights = _load_json(DYNAMIC_WEIGHTS_PATH, {})
    accuracy_history = _load_json(ACCURACY_HISTORY_PATH, {})

    if args.summary or not calibration_metrics:
        print_summary(calibration_metrics)
        if not calibration_metrics:
            print("  No calibration data yet. Run auto-backtest first.")
        return

    weights = compute_calibration_weights(calibration_metrics, dynamic_weights, accuracy_history)

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(weights, f, indent=2)

    print(f"Calibration weights saved to {OUTPUT_PATH}")
    print(f"  {len(weights)} leagues configured")

    print_summary(calibration_metrics)


if __name__ == '__main__':
    main()
