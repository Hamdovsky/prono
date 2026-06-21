"""Backtest 1X2, Over/Under 2.5 and BTTS using prediction_engine outputs."""
import sqlite3, json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))
from prediction_engine import process_prediction

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')

# Select a sample of matches with full odds and results
SELECT_QUERY = """
SELECT * FROM archive_football_data
WHERE match_date >= '2026-05-01' AND match_date <= '2026-05-24'
  AND odds_home IS NOT NULL AND odds_draw IS NOT NULL AND odds_away IS NOT NULL
  AND score_home IS NOT NULL AND score_away IS NOT NULL
ORDER BY match_date
"""

CONF_THRESHOLDS = {
    '1x2': [x / 100 for x in range(50, 91, 5)],
    'ou25': [x / 100 for x in range(50, 91, 5)],
    'btts': [x / 100 for x in range(50, 91, 5)],
}

MIN_BETS = {
    '1x2': 10,
    'ou25': 15,
    'btts': 15,
}


def implied_prob(odds):
    return 1.0 / odds if odds and odds > 0 else 0.0


def kelly_fraction(prob, odds, frac=0.25):
    if odds <= 1 or prob <= 0:
        return 0.0
    edge = prob - implied_prob(odds)
    if edge <= 0:
        return 0.0
    return max(0.0, min((edge / (odds - 1.0)) * frac, 0.1))


def actual_1x2(sh, sa):
    if sh > sa: return 'H'
    if sa > sh: return 'A'
    return 'D'


def actual_over_under(sh, sa, threshold=2.5):
    return 'Over' if (sh + sa) > threshold else 'Under'


def actual_btts(sh, sa):
    return 'Yes' if sh > 0 and sa > 0 else 'No'


def get_odds(row_dict, keys, default):
    for key in keys:
        value = row_dict.get(key)
        if value not in (None, '', 0):
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return float(default)


def get_ou_odds(row_dict, selection):
    if selection == 'Over':
        return get_odds(row_dict, ['odds_over', 'odds_over25', 'odds_over_25'], 1.85)
    return get_odds(row_dict, ['odds_under', 'odds_under25', 'odds_under_25'], 1.95)


def get_btts_odds(row_dict, selection):
    if selection == 'Yes':
        return get_odds(row_dict, ['odds_btts_yes', 'odds_btts_yes_'], 1.80)
    return get_odds(row_dict, ['odds_btts_no', 'odds_btts_no_'], 2.05)


def build_match_obj(row):
    d = dict(row)
    return {
        'homeTeam': d['home_team'],
        'awayTeam': d['away_team'],
        'league': d.get('league_code', 'UNKNOWN'),
        'tournament_name': d.get('league_code', 'UNKNOWN'),
        'odds_home': float(d['odds_home']) if d['odds_home'] else 2.0,
        'odds_draw': float(d['odds_draw']) if d['odds_draw'] else 3.0,
        'odds_away': float(d['odds_away']) if d['odds_away'] else 3.0,
        'startTimestamp': int(d.get('start_timestamp') or 0) if d.get('start_timestamp') else 0,
        'force_predict': True,
    }


def bet_eval(pred_prob, actual_label, odds, threshold):
    if pred_prob < threshold or odds <= 1:
        return 0, 0.0, 0.0
    bet = 1.0
    won = 1 if actual_label else 0
    ret = bet * odds if actual_label else 0.0
    edge = pred_prob - implied_prob(odds)
    kelly = kelly_fraction(pred_prob, odds)
    return 1, ret, kelly


def run_backtest():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(SELECT_QUERY).fetchall()
    conn.close()

    print(f'Loaded {len(rows)} matches for backtest')
    if not rows:
        return

    metrics = {
        '1x2': {thr: {'bets': 0, 'wins': 0, 'stake': 0.0, 'return': 0.0, 'kelly_stake': 0.0, 'kelly_return': 0.0} for thr in CONF_THRESHOLDS['1x2']},
        'ou25': {thr: {'bets': 0, 'wins': 0, 'stake': 0.0, 'return': 0.0} for thr in CONF_THRESHOLDS['ou25']},
        'btts': {thr: {'bets': 0, 'wins': 0, 'stake': 0.0, 'return': 0.0} for thr in CONF_THRESHOLDS['btts']},
    }

    for i, row in enumerate(rows):
        match_obj = build_match_obj(row)
        try:
            pred = process_prediction(match_obj)
        except Exception as e:
            print(f'ERROR prediction row {i}: {e}')
            continue

        if not pred.get('success'):
            continue

        row_dict = dict(row)
        actual_h = row_dict['score_home']
        actual_a = row_dict['score_away']
        actual_res = actual_1x2(actual_h, actual_a)
        actual_ou = actual_over_under(actual_h, actual_a)
        actual_btts_label = actual_btts(actual_h, actual_a)

        p_h = float(pred.get('home_win_probability', 0.0))
        p_d = float(pred.get('draw_probability', 0.0))
        p_a = float(pred.get('away_win_probability', 0.0))
        ou25 = float(pred.get('ou_25_prob', 0.0))
        btts = float(pred.get('btts_prob', 0.0))

        # 1X2 bet by threshold
        best_prob = max(p_h, p_d, p_a)
        selection = 'H' if p_h >= max(p_d, p_a) else ('D' if p_d >= max(p_h, p_a) else 'A')
        odds = row_dict['odds_home'] if selection == 'H' else (row_dict['odds_draw'] if selection == 'D' else row_dict['odds_away'])
        correct = 1 if selection == actual_res else 0
        for thr, data in metrics['1x2'].items():
            if best_prob >= thr:
                data['bets'] += 1
                data['wins'] += correct
                data['stake'] += 1.0
                data['return'] += (odds if correct else 0.0)
                kelly = kelly_fraction(best_prob, odds)
                data['kelly_stake'] += kelly
                data['kelly_return'] += (kelly * odds if correct else 0.0)

        # Over/Under 2.5 by threshold
        for thr, data in metrics['ou25'].items():
            if ou25 >= thr or ou25 <= (1.0 - thr):
                selection = 'Over' if ou25 >= thr else 'Under'
                odds = get_ou_odds(row_dict, selection)
                data['bets'] += 1
                data['wins'] += 1 if selection == actual_ou else 0
                data['stake'] += 1.0
                data['return'] += (odds if selection == actual_ou else 0.0)

        # BTTS by threshold
        for thr, data in metrics['btts'].items():
            if btts >= thr or btts <= (1.0 - thr):
                selection = 'Yes' if btts >= thr else 'No'
                odds = get_btts_odds(row_dict, selection)
                data['bets'] += 1
                data['wins'] += 1 if selection == actual_btts_label else 0
                data['stake'] += 1.0
                data['return'] += (odds if selection == actual_btts_label else 0.0)

    print_report(metrics)


def print_recommendations(metrics):
    print('\n=== BEST THRESHOLD RECOMMENDATIONS ===')
    for market, thresholds in metrics.items():
        best = None
        for thr, data in thresholds.items():
            if data['bets'] < MIN_BETS.get(market, 0):
                continue
            roi = (data['return'] - data['stake']) / data['stake'] * 100 if data['stake'] > 0 else -999
            if best is None or roi > best[1]:
                best = (thr, roi, data)

        if best is None:
            print(f'{market.upper()}: no threshold has enough bets')
            continue

        thr, roi, data = best
        acc = data['wins'] / data['bets'] * 100
        print(f'{market.upper()}: best threshold {thr:.2f} with ROI={roi:+.2f}% on {data["bets"]} bets, winrate={acc:.2f}%')


def print_report(metrics):
    print('\n=== BACKTEST REPORT ===')
    for market, thresholds in metrics.items():
        print(f'\n--- {market.upper()} ---')
        for thr, data in sorted(thresholds.items()):
            if data['bets'] == 0:
                print(f'Threshold {thr:.2f}: no bets placed')
                continue
            acc = data['wins'] / data['bets'] * 100
            roi = (data['return'] - data['stake']) / data['stake'] * 100 if data['stake'] > 0 else 0
            print(f'Threshold {thr:.2f}: Bets={data["bets"]}, Win={data["wins"]}/{data["bets"]} ({acc:.2f}%), ROI={roi:+.2f}%')
            if market == '1x2':
                kelly_roi = (data['kelly_return'] - data['kelly_stake']) / data['kelly_stake'] * 100 if data['kelly_stake'] > 0 else 0
                print(f'  Kelly stake={data["kelly_stake"]:.3f}, Kelly ROI={kelly_roi:+.2f}%')

    print_recommendations(metrics)


if __name__ == '__main__':
    run_backtest()
