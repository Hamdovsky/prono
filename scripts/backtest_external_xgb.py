"""
backtest_external_xgb.py — Leak-free backtest of the external XGBoost member.

Replays every finished match of the 5 supported leagues (season 2526) using ONLY
the matches strictly prior to the target match as feature input (no data leakage),
then evaluates:

  - Member alone  : XGBoost probs (ext['xgb'], the blend member) and tree probs
                    (ext['tree']) → accuracy 1X2, Brier, Log Loss, calibration
  - Value added   : delta vs market-implied probabilities (AvgH/AvgD/AvgA)
  - ROI simulated : flat 1-unit stake on the favorite when confidence >= threshold,
                    paid at the match's average odds (60/65/70% thresholds)

Usage:
    python scripts/backtest_external_xgb.py [--league PremierLeague] [--thresholds 60 65 70]
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import pandas as pd

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
sys.path.insert(0, os.path.join(_ROOT, 'core'))

from external_xgb import predict_external, DATA_DIR

LEAGUES = ['PremierLeague', 'Bundesliga', 'SerieA', 'LaLiga', 'Ligue1']
OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'data', 'backtest_external.json')

LABELS = {0: 'H', 1: 'D', 2: 'A'}


def market_probs(row):
    inv = np.array([1.0 / row['AvgH'], 1.0 / row['AvgD'], 1.0 / row['AvgA']])
    return inv / inv.sum()


def brier_score(actual_idx, probs):
    v = [0.0, 0.0, 0.0]
    v[actual_idx] = 1.0
    return float(sum((v[j] - probs[j]) ** 2 for j in range(3)))


def log_loss_score(actual_idx, probs):
    p = max(1e-10, min(1.0, probs[actual_idx]))
    return float(-math.log(p))


def run_league(league, thresholds):
    csv_path = os.path.join(DATA_DIR, league + '.csv')
    df = pd.read_csv(csv_path, encoding='utf-8-sig')
    df['Date_dt'] = pd.to_datetime(df['Date'], dayfirst=True, errors='coerce')
    df = df.sort_values('Date_dt').reset_index(drop=True)
    df = df[df['FTR'].notna() & df['AvgH'].notna() & df['AvgD'].notna() & df['AvgA'].notna()]
    df = df.reset_index(drop=True)

    actual_map = {'H': 0, 'D': 1, 'A': 2}
    members = {
        'xgb': {'acc_correct': 0, 'n': 0, 'brier': 0.0, 'logloss': 0.0, 'sum_p': 0.0,
                'roi': {t: {'picks': 0, 'won': 0, 'profit': 0.0} for t in thresholds}},
        'tree': {'acc_correct': 0, 'n': 0, 'brier': 0.0, 'logloss': 0.0, 'sum_p': 0.0,
                 'roi': {t: {'picks': 0, 'won': 0, 'profit': 0.0} for t in thresholds}},
        'market': {'acc_correct': 0, 'n': 0, 'brier': 0.0, 'logloss': 0.0, 'sum_p': 0.0,
                   'roi': {t: {'picks': 0, 'won': 0, 'profit': 0.0} for t in thresholds}},
    }
    cal_bins = {m: [{'pred': 0.0, 'hit': 0, 'cnt': 0} for _ in range(10)] for m in members}
    skipped = {'insufficient_history': 0, 'team_unavailable': 0, 'failed': 0}
    details = []

    for i, m in df.iterrows():
        m_date = m['Date_dt']
        hist = df[df['Date_dt'] < m_date]
        if len(hist) < 5:
            skipped['insufficient_history'] += 1
            continue

        actual_idx = actual_map.get(m['FTR'])
        if actual_idx is None:
            continue

        try:
            pred = predict_external(league, m['HomeTeam'], m['AwayTeam'], results=hist)
        except Exception as exc:
            skipped['failed'] += 1
            print(f'  [{league}] {m["HomeTeam"]} vs {m["AwayTeam"]}: error {exc}')
            continue
        if pred is None:
            skipped['team_unavailable'] += 1
            continue

        xgb_p = np.array([pred['xgb']['home'], pred['xgb']['draw'], pred['xgb']['away']])
        s = xgb_p.sum()
        xgb_p = xgb_p / s if s > 0 else np.array([1 / 3, 1 / 3, 1 / 3])
        tree_p = np.array([pred['tree']['home'], pred['tree']['draw'], pred['tree']['away']])
        mkt_p = market_probs(m)

        rec = {
            'league': league,
            'date': str(m['Date']),
            'home': str(m['HomeTeam']),
            'away': str(m['AwayTeam']),
            'actual': m['FTR'],
            'score': f"{int(m['FTHG'])}-{int(m['FTAG'])}",
            'odds': {'H': float(m['AvgH']), 'D': float(m['AvgD']), 'A': float(m['AvgA'])},
            'probs': {
                'xgb': [float(x) for x in xgb_p],
                'tree': [float(x) for x in tree_p],
                'market': [float(x) for x in mkt_p],
            },
        }

        for name, p in (('xgb', xgb_p), ('tree', tree_p), ('market', mkt_p)):
            st = members[name]
            st['n'] += 1
            st['brier'] += brier_score(actual_idx, p)
            st['logloss'] += log_loss_score(actual_idx, p)
            st['sum_p'] += float(p[actual_idx])
            pred_idx = int(np.argmax(p))
            conf = float(p[pred_idx])
            if pred_idx == actual_idx:
                st['acc_correct'] += 1
            bin_i = min(9, int(conf * 10))
            cal_bins[name][bin_i]['pred'] += conf
            cal_bins[name][bin_i]['cnt'] += 1
            cal_bins[name][bin_i]['hit'] += (1 if pred_idx == actual_idx else 0)

            rec.setdefault('picks', {})[name] = {'outcome': LABELS[pred_idx], 'confidence': round(conf, 3)}

            for t in thresholds:
                if conf >= t:
                    odds = m['AvgH'] if pred_idx == 0 else (m['AvgD'] if pred_idx == 1 else m['AvgA'])
                    st['roi'][t]['picks'] += 1
                    if pred_idx == actual_idx:
                        st['roi'][t]['won'] += 1
                        st['roi'][t]['profit'] += float(odds) - 1.0
                    else:
                        st['roi'][t]['profit'] -= 1.0

        details.append(rec)

    return {
        'league': league,
        'members': {name: _summarize_member(st, cal_bins[name], thresholds) for name, st in members.items()},
        'skipped': skipped,
        'matches': details,
    }


def _summarize_member(st, bins, thresholds):
    n = st['n']
    acc = st['acc_correct'] / n if n else 0.0
    brier = st['brier'] / n if n else 0.0
    logloss = st['logloss'] / n if n else 0.0
    mean_p = st['sum_p'] / n if n else 0.0
    roi = {}
    for t in thresholds:
        r = st['roi'][t]
        roi[str(t)] = {
            'picks': r['picks'],
            'won': r['won'],
            'hit_rate': r['won'] / r['picks'] if r['picks'] else 0.0,
            'profit': round(r['profit'], 2),
            'roi': round(r['profit'] / r['picks'] * 100, 2) if r['picks'] else 0.0,
        }
    calibration = []
    for b in bins:
        if b['cnt']:
            calibration.append({
                'pred': round(b['pred'] / b['cnt'], 3),
                'actual': round(b['hit'] / b['cnt'], 3),
                'count': b['cnt'],
            })
    return {
        'n': n,
        'accuracy': round(acc, 4),
        'correct': st['acc_correct'],
        'brier': round(brier, 4),
        'log_loss': round(logloss, 4),
        'mean_prob_actual': round(mean_p, 4),
        'roi': roi,
        'calibration': calibration,
    }


def print_report(results, thresholds):
    width = 58
    print('=' * width)
    print('BACKTEST EXTERNAL XGBOOST — SEASON 2526 (leak-free replay)')
    print('=' * width)
    header = f"{'League':<15}{'Member':<8}{'N':>5}{'Acc%':>8}{'Brier':>8}{'LL':>8}"
    print(header)
    print('-' * width)

    totals = {}
    for res in results:
        for name, st in res['members'].items():
            totals.setdefault(name, {'n': 0, 'correct': 0, 'brier': 0.0, 'logloss': 0.0,
                                     'roi': {t: {'picks': 0, 'won': 0, 'profit': 0.0} for t in thresholds}})
            g = totals[name]
            g['n'] += st['n']
            g['correct'] += st['correct']
            g['brier'] += st['brier'] * st['n']
            g['logloss'] += st['log_loss'] * st['n']
            for t in thresholds:
                r = st['roi'][str(t)]
                g['roi'][t]['picks'] += r['picks']
                g['roi'][t]['won'] += r['won']
                g['roi'][t]['profit'] += r['profit']

    for res in results:
        for name, st in res['members'].items():
            print(f"{res['league']:<15}{name:<8}{st['n']:>5}{st['accuracy']*100:>7.1f}%"
                  f"{st['brier']:>8.3f}{st['log_loss']:>8.3f}")
        sk = res['skipped']
        print(f"{'':<15}{'(skipped)':<8}{'hist:'+str(sk['insufficient_history']):<12}"
              f"{'team:'+str(sk['team_unavailable']):<10}{'err:'+str(sk['failed'])}")
        print('-' * width)

    print(f"\n{'GLOBAL':<15}{'Member':<8}{'N':>5}{'Acc%':>8}{'Brier':>8}{'LL':>8}")
    print('-' * width)
    for name, g in totals.items():
        acc = g['correct'] / g['n'] if g['n'] else 0.0
        brier = g['brier'] / g['n'] if g['n'] else 0.0
        ll = g['logloss'] / g['n'] if g['n'] else 0.0
        print(f"{'ALL':<15}{name:<8}{g['n']:>5}{acc*100:>7.1f}%{brier:>8.3f}{ll:>8.3f}")

    print(f"\n{'=' * width}")
    print('ROI SIMULATED (flat 1-unit stake on favorite at Avg odds)')
    print('=' * width)
    print(f"{'Member':<8}{'Thresh':<8}{'Picks':>6}{'Won':>5}{'Hit%':>8}{'Profit':>10}{'ROI%':>9}")
    print('-' * width)
    for name, g in totals.items():
        for t in thresholds:
            r = g['roi'][t]
            hr = r['won'] / r['picks'] * 100 if r['picks'] else 0.0
            roi = r['profit'] / r['picks'] * 100 if r['picks'] else 0.0
            print(f"{name:<8}{str(t)+'%':<8}{r['picks']:>6}{r['won']:>5}{hr:>7.1f}%"
                  f"{r['profit']:>10.2f}{roi:>8.2f}%")
        print('-' * width)

    # Value added vs market
    print(f"\n{'=' * width}")
    print('VALUE ADDED vs MARKET BASELINE (global)')
    print('=' * width)
    mkt = totals['market']
    for name in ('xgb', 'tree'):
        g = totals[name]
        acc_d = (g['correct'] / g['n'] - mkt['correct'] / mkt['n']) * 100
        brier_d = g['brier'] / g['n'] - mkt['brier'] / mkt['n']
        ll_d = g['logloss'] / g['n'] - mkt['logloss'] / mkt['n']
        print(f"  {name:<6} vs market: acc {acc_d:+.2f}% | brier {brier_d:+.4f} | logloss {ll_d:+.4f}")
    print()


def main():
    parser = argparse.ArgumentParser(description='Leak-free backtest of external XGBoost member')
    parser.add_argument('--league', type=str, default='', help='Single league name or empty for all')
    parser.add_argument('--thresholds', type=float, nargs='+', default=[0.60, 0.65, 0.70],
                        help='Confidence thresholds for ROI simulation')
    args = parser.parse_args()

    leagues = [args.league] if args.league else LEAGUES
    leagues = [l for l in leagues if l in LEAGUES]
    if not leagues:
        print('Invalid league. Use one of:', ', '.join(LEAGUES))
        sys.exit(1)

    thresholds = sorted(args.thresholds)
    results = []
    all_details = []
    for lg in leagues:
        print(f'Running {lg}...')
        r = run_league(lg, thresholds)
        results.append({k: v for k, v in r.items() if k != 'matches'})
        all_details.extend(r['matches'])

    print_report(results, thresholds)

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump({'thresholds': thresholds, 'results': results, 'matches': all_details},
                  f, ensure_ascii=False, indent=2)
    print(f'Details written to {OUT_PATH} ({len(all_details)} matches)')


if __name__ == '__main__':
    main()