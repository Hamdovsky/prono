"""
backtest_feedback.py — Bridge between JS backtest results and Python XGBoost retraining.

Reads:
  - data/accuracy_log.json (written by settlementService.js)
  - data/league_dynamic_weights.json (written by autoBacktestService.js)
  - data/accuracy_history.json (written by confidenceScorer.js)

Writes:
  - data/training_weights.json (per-league sample weights for retraining)

Usage:
    python scripts/backtest_feedback.py              # Generate weights
    python scripts/backtest_feedback.py --summary    # Print accuracy summary only
"""
import os, sys, json, argparse

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

ACCURACY_LOG_PATH = os.path.join(DATA_DIR, 'accuracy_log.json')
DYNAMIC_WEIGHTS_PATH = os.path.join(DATA_DIR, 'league_dynamic_weights.json')
ACCURACY_HISTORY_PATH = os.path.join(DATA_DIR, 'accuracy_history.json')
TRAINING_WEIGHTS_PATH = os.path.join(DATA_DIR, 'training_weights.json')

# ── Loaders ──

def _load_json(p, default=None):
    try:
        with open(p, 'r') as f:
            return json.load(f)
    except Exception:
        return default or {}


def load_accuracy_log():
    """Load per-league accuracy from JS settlement log."""
    log = _load_json(ACCURACY_LOG_PATH, {})
    # Remove meta keys
    log.pop('_global', None)
    return log


def load_dynamic_weights():
    """Load per-league XGB/Poisson blend weights from JS backtest."""
    return _load_json(DYNAMIC_WEIGHTS_PATH, {})


def load_accuracy_history():
    """Load per-league::market win rates from confidenceScorer."""
    raw = _load_json(ACCURACY_HISTORY_PATH, {})
    # Convert {league::market: {wins, count}} to per-league accuracy
    league_acc = {}
    for key, val in raw.items():
        if '::' not in key:
            continue
        league, market = key.split('::', 1)
        if market != '1X2':
            continue
        if league not in league_acc:
            league_acc[league] = {'wins': 0, 'count': 0}
        league_acc[league]['wins'] += val.get('wins', 0)
        league_acc[league]['count'] += val.get('count', 0)
    return league_acc


# ── Core: Compute Training Weights ──

def compute_training_weights(accuracy_log, dynamic_weights, accuracy_history):
    """
    Produce per-league sample weights for XGBoost retraining.
    
    Logic:
    - Leagues with low accuracy get HIGHER sample weight (model needs to learn better)
    - Leagues with high accuracy get LOWER sample weight (already good)
    - Leagues where model beats odds get slight boost
    - Leagues where model loses to odds get penalty
    - Minimum weight 0.5, maximum 3.0
    """
    weights = {}
    all_leagues = set()

    # Collect all leagues from all sources
    for src in [accuracy_log, dynamic_weights, accuracy_history]:
        for k in src:
            if k.startswith('_'):
                continue
            all_leagues.add(k)

    for league in all_leagues:
        w = 1.0  # default

        # Source 1: accuracy_log.json (most direct signal)
        if league in accuracy_log:
            entries = accuracy_log[league]
            if len(entries) >= 5:
                correct = sum(1 for e in entries if e.get('is_correct'))
                acc = correct / len(entries)
                # Low accuracy → high weight (needs more training emphasis)
                if acc < 0.35:
                    w *= 2.5
                elif acc < 0.45:
                    w *= 2.0
                elif acc < 0.55:
                    w *= 1.5
                elif acc > 0.70:
                    w *= 0.7
                # Misleading count: high-confidence wrong predictions are critical
                misleading = sum(1 for e in entries if e.get('vote_was_misleading'))
                if misleading >= 3:
                    w *= 1.3

        # Source 2: league_dynamic_weights.json (model edge vs odds)
        if league in dynamic_weights:
            dw = dynamic_weights[league]
            edge = dw.get('edge', 0)
            if edge < -5:
                # Model significantly worse than odds → train harder on this league
                w *= 1.8
            elif edge < -2:
                w *= 1.3
            elif edge > 5:
                # Model beats odds → less urgent, but still train
                w *= 0.8

        # Source 3: accuracy_history.json (long-term trend)
        if league in accuracy_history:
            ah = accuracy_history[league]
            if ah['count'] >= 10:
                hist_acc = ah['wins'] / ah['count']
                if hist_acc < 0.40:
                    w *= 1.5
                elif hist_acc > 0.65:
                    w *= 0.8

        # Clamp
        w = max(0.5, min(3.0, w))
        weights[league] = round(w, 3)

    # Always include DEFAULT
    weights['DEFAULT'] = 1.0

    return weights


def print_summary(accuracy_log, dynamic_weights):
    """Print a human-readable accuracy summary."""
    print("=" * 60)
    print("BACKTEST FEEDBACK SUMMARY")
    print("=" * 60)

    # Global
    global_stats = _load_json(ACCURACY_LOG_PATH, {}).get('_global', {})
    if global_stats:
        print(f"\n  Global Accuracy: {global_stats.get('accuracy', 0)}% ({global_stats.get('won', 0)}/{global_stats.get('total', 0)})")

    # Per-league
    leagues = {}
    for league, entries in accuracy_log.items():
        if league.startswith('_') or not entries:
            continue
        correct = sum(1 for e in entries if e.get('is_correct'))
        total = len(entries)
        acc = round(correct / total * 100, 1) if total > 0 else 0
        leagues[league] = {'acc': acc, 'total': total, 'correct': correct}

    if leagues:
        print(f"\n  Per-League Accuracy ({len(leagues)} leagues):")
        print(f"  {'League':<35} {'Acc%':>6} {'N':>5}")
        print(f"  {'-'*35} {'-'*6} {'-'*5}")
        for lg, s in sorted(leagues.items(), key=lambda x: -x[1]['acc']):
            print(f"  {lg:<35} {s['acc']:>5.1f}% {s['total']:>5}")

    # Dynamic weights
    if dynamic_weights:
        print(f"\n  Dynamic Blend Weights ({len(dynamic_weights)} leagues):")
        for lg, dw in sorted(dynamic_weights.items()):
            if lg == 'DEFAULT':
                continue
            xgb_w = dw.get('xgb_weight', 0.75)
            edge = dw.get('edge', 0)
            print(f"    {lg}: XGB={xgb_w:.2f} edge={edge:+.1f}%")

    print()


def main():
    parser = argparse.ArgumentParser(description='Backtest feedback for XGBoost retraining')
    parser.add_argument('--summary', action='store_true', help='Print accuracy summary only')
    args = parser.parse_args()

    accuracy_log = load_accuracy_log()
    dynamic_weights = load_dynamic_weights()
    accuracy_history = load_accuracy_history()

    if args.summary:
        print_summary(accuracy_log, dynamic_weights)
        return

    # Compute and save training weights
    weights = compute_training_weights(accuracy_log, dynamic_weights, accuracy_history)

    with open(TRAINING_WEIGHTS_PATH, 'w') as f:
        json.dump(weights, f, indent=2)

    print(f"Training weights saved to {TRAINING_WEIGHTS_PATH}")
    print(f"  {len(weights)} leagues configured")

    # Print summary
    print_summary(accuracy_log, dynamic_weights)


if __name__ == '__main__':
    main()
