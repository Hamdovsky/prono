"""
Full backtest with real XGBoost Promosport predictions.
Compares: vote-only vs XGBoost-blended probabilities.
"""
import sqlite3
import json
import sys
import os
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'promosport_xgb.json')

try:
    import xgboost as xgb
except ImportError:
    print("XGBoost not installed")
    sys.exit(1)

GRID_NAMES = ['T1', 'T2', 'T3', 'T4']
FEATURE_NAMES = [
    'home_win_rate_5','home_draw_rate_5','home_loss_rate_5',
    'away_win_rate_5','away_draw_rate_5','away_loss_rate_5',
    'home_win_rate_10','home_draw_rate_10','home_loss_rate_10',
    'away_win_rate_10','away_draw_rate_10','away_loss_rate_10',
    'home_win_rate_all','home_draw_rate_all','home_loss_rate_all',
    'away_win_rate_all','away_draw_rate_all','away_loss_rate_all',
    'vote_home','vote_draw','vote_away',
    'vote_home_norm','vote_draw_norm','vote_away_norm',
    'vote_advantage_home','vote_advantage_away',
    'h2h_home_wins','h2h_draws','h2h_away_wins','h2h_matches',
    'home_pts_per_match_10','away_pts_per_match_10',
    'home_pts_per_match_all','away_pts_per_match_all',
    'pts_diff_10','pts_diff_all',
    'home_avg_scored_5','home_avg_conceded_5',
    'away_avg_scored_5','away_avg_conceded_5',
    'home_avg_scored_10','home_avg_conceded_10',
    'away_avg_scored_10','away_avg_conceded_10',
    'home_form_score','away_form_score',
    'home_last_result','away_last_result',
    'home_matches_in_period','away_matches_in_period',
    'total_concours_for_pair',
    'vote_x_home_form','vote_x_pts_diff','home_vote_x_winrate'
]


def compute_entropy(probs):
    H = 0
    for p in probs:
        if p > 0:
            H -= p * np.log2(p)
    return H


def get_team_stats(db, team):
    rows = db.execute("""
        SELECT result, score_home, score_away, homeTeam
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?) AND result IS NOT NULL AND result != 'N'
    """, [team, team]).fetchall()
    if not rows:
        return None
    n = len(rows)
    wins = draws = losses = pts = gf = ga = sc = 0
    for r in rows:
        is_home = r[3] == team
        if r[0] == '1':
            wins += 1 if is_home else 0
            losses += 0 if is_home else 1
            pts += 3 if is_home else 0
        elif r[0] == '2':
            losses += 1 if is_home else 0
            wins += 0 if is_home else 1
            pts += 0 if is_home else 3
        else:
            draws += 1
            pts += 1
        if r[1] is not None:
            gf += r[1] if is_home else r[2] or 0
            ga += r[2] or 0 if is_home else r[1]
            sc += 1
    return {'n': n, 'wins': wins, 'draws': draws, 'losses': losses, 'pts': pts,
            'winRate': wins / n, 'drawRate': draws / n, 'lossRate': losses / n,
            'ptsPerMatch': pts / n, 'avgScored': gf / sc if sc else 0.5, 'avgConceded': ga / sc if sc else 0.5}


def get_recent_stats(db, team, limit):
    rows = db.execute("""
        SELECT result, homeTeam, score_home, score_away
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?) AND result IS NOT NULL AND result != 'N'
        ORDER BY rowid DESC LIMIT ?
    """, [team, team, limit]).fetchall()
    if not rows:
        return None
    n = len(rows)
    wins = draws = pts = gf = ga = sc = form = 0
    for i, r in enumerate(rows):
        is_home = r[1] == team
        if r[0] == '1':
            wins += 1 if is_home else 0
            mp = 3 if is_home else 0
        elif r[0] == '2':
            wins += 1 if not is_home else 0
            mp = 3 if not is_home else 0
        else:
            draws += 1
            mp = 1
        pts += mp
        form += mp * (1 / (i + 1))
        if r[2] is not None:
            gf += r[2] if is_home else r[3] or 0
            ga += r[3] or 0 if is_home else r[2]
            sc += 1
    return {'n': n, 'wins': wins, 'draws': draws, 'losses': n - wins - draws, 'pts': pts,
            'ptsPerMatch': pts / n, 'formScore': form, 'winRate': wins / n, 'drawRate': draws / n,
            'lossRate': (n - wins - draws) / n, 'avgScored': gf / sc if sc else 0.5, 'avgConceded': ga / sc if sc else 0.5}


def get_h2h(db, home, away):
    rows = db.execute("""
        SELECT result FROM promosport_archive
        WHERE ((homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?))
          AND result IS NOT NULL AND result != 'N'
    """, [home, away, home, away]).fetchall()
    hw = d = aw = 0
    for r in rows:
        if r[0] == '1': hw += 1
        elif r[0] == 'X': d += 1
        else: aw += 1
    return {'homeWins': hw, 'draws': d, 'awayWins': aw, 'total': len(rows)}


def extract_features(match, db):
    f = {}
    m = dict(match) if hasattr(match, 'keys') else match
    home = (m.get('homeTeam') or '').upper()
    away = (m.get('awayTeam') or '').upper()
    vh = m.get('vote_home') or 50
    vd = m.get('vote_draw') or 33
    va = m.get('vote_away') or 17
    tv = vh + vd + va
    f['vote_home'] = vh; f['vote_draw'] = vd; f['vote_away'] = va
    f['vote_home_norm'] = vh / tv; f['vote_draw_norm'] = vd / tv; f['vote_away_norm'] = va / tv
    f['vote_advantage_home'] = vh - va; f['vote_advantage_away'] = va - vh

    for team, prefix in [(home, 'home'), (away, 'away')]:
        all_s = get_team_stats(db, team)
        r5 = get_recent_stats(db, team, 5)
        r10 = get_recent_stats(db, team, 10)
        for s, suffix in [(r5, '5'), (r10, '10'), (all_s, 'all')]:
            if s:
                f[f'{prefix}_win_rate_{suffix}'] = s['winRate']
                f[f'{prefix}_draw_rate_{suffix}'] = s['drawRate']
                f[f'{prefix}_loss_rate_{suffix}'] = s['lossRate']
                f[f'{prefix}_pts_per_match_{suffix}'] = s['ptsPerMatch']
                f[f'{prefix}_avg_scored_{suffix}'] = s.get('avgScored', 0.5)
                f[f'{prefix}_avg_conceded_{suffix}'] = s.get('avgConceded', 0.5)
            else:
                for k in [f'{prefix}_win_rate_{suffix}', f'{prefix}_draw_rate_{suffix}', f'{prefix}_loss_rate_{suffix}']:
                    f[k] = 0.33
                f[f'{prefix}_pts_per_match_{suffix}'] = 1.0
                f[f'{prefix}_avg_scored_{suffix}'] = 1.0
                f[f'{prefix}_avg_conceded_{suffix}'] = 1.0
        if r5:
            f[f'{prefix}_form_score'] = r5['formScore']
            f[f'{prefix}_last_result'] = r5.get('lastResult', 1)
        else:
            f[f'{prefix}_form_score'] = 5
            f[f'{prefix}_last_result'] = 1
        f[f'{prefix}_matches_in_period'] = all_s['n'] if all_s else 0

    f['pts_diff_10'] = f.get('home_pts_per_match_10', 1) - f.get('away_pts_per_match_10', 1)
    f['pts_diff_all'] = f.get('home_pts_per_match_all', 1) - f.get('away_pts_per_match_all', 1)
    h2h = get_h2h(db, home, away)
    f['h2h_home_wins'] = h2h['homeWins']; f['h2h_draws'] = h2h['draws']
    f['h2h_away_wins'] = h2h['awayWins']; f['h2h_matches'] = h2h['total']
    f['total_concours_for_pair'] = f.get('home_matches_in_period', 0) + f.get('away_matches_in_period', 0)
    f['vote_x_home_form'] = f['vote_home'] * f.get('home_form_score', 5)
    f['vote_x_pts_diff'] = f['vote_home'] * f['pts_diff_10']
    f['home_vote_x_winrate'] = f['vote_home_norm'] * f.get('home_win_rate_10', 0.33)
    return [f.get(k, 0.0) for k in FEATURE_NAMES]


def assign_doubles_xgb(matches_xgb):
    """Same logic as promosport_engine but with XGBoost probs."""
    choices = {g: [] for g in GRID_NAMES}
    ranked = sorted(matches_xgb, key=lambda m: m['uncertainty'], reverse=True)
    core = ranked[:3]
    candidates = ranked[3:]
    candidates.sort(key=lambda c: c['confidence'], reverse=True)
    MIN_CONF = 75
    singles = [c for c in candidates if c['confidence'] >= MIN_CONF][:4]
    mediums = [c for c in candidates if c not in singles]

    for m in core:
        for g in GRID_NAMES:
            top2 = list(dict.fromkeys([m['probs'][0] > m['probs'][2] and '1' or '2',
                                        m['probs'][1] > max(m['probs'][0], m['probs'][2]) and 'X' or
                                        (m['probs'][0] > m['probs'][2] and '2' or '1')]))[:2]
            if len(top2) < 2:
                top2.append([v for v in ['1', 'X', '2'] if v not in top2][0])
            choices[g].append({'idx': m['idx'], 'picks': top2})

    for i, m in enumerate(mediums):
        gp = [GRID_NAMES[i % 4], GRID_NAMES[(i + 2) % 4]]
        top2 = ['1', ['X', '2'][m['probs'][1] > m['probs'][2] and 0 or 1]] if m['probs'][0] > 0.5 else \
               ['2', ['X', '1'][m['probs'][1] > m['probs'][0] and 0 or 1]] if m['probs'][2] > 0.5 else ['1', '2']
        for g in gp:
            choices[g].append({'idx': m['idx'], 'picks': top2})

    for i, m in enumerate(singles):
        pick = ['1'] if m['probs'][0] > 0.6 else ['2'] if m['probs'][2] > 0.6 else ['X']
        choices[GRID_NAMES[i]].append({'idx': m['idx'], 'picks': pick})

    return choices


def backtest_with_xgb():
    print("=" * 60)
    print("BACKTEST WITH XGBOOST PROMOSPORT")
    print("=" * 60)

    booster = xgb.Booster()
    booster.load_model(MODEL_PATH)
    if booster.feature_names is None:
        booster.feature_names = FEATURE_NAMES
    print(f"Model loaded: {len(booster.feature_names)} features")

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    concours_list = [r['concours'] for r in db.execute(
        "SELECT DISTINCT concours FROM promosport_archive WHERE result IS NOT NULL AND result != 'N' ORDER BY concours"
    ).fetchall()]

    vote_results = {'total': 0, 'correct': 0, 'grids': {g: {'correct': 0, 'total': 0} for g in GRID_NAMES}}
    xgb_results = {'total': 0, 'correct': 0, 'grids': {g: {'correct': 0, 'total': 0} for g in GRID_NAMES}}

    for ci, concours in enumerate(concours_list):
        matches = db.execute("""
            SELECT * FROM promosport_archive
            WHERE concours = ? AND result IS NOT NULL AND result != 'N'
            ORDER BY match_idx
        """, [str(concours)]).fetchall()

        if len(matches) < 10:
            continue

        # Votes-only processing
        vote_matches = []
        for m in matches:
            vh = m['vote_home'] or 33; vd = m['vote_draw'] or 33; va = m['vote_away'] or 34
            tv = vh + vd + va
            probs = [vh / tv, vd / tv, va / tv]
            ent = compute_entropy(probs)
            conf = max(50, 80 - (ent * 15))
            vote_matches.append({
                'idx': m['match_idx'], 'actual': m['result'],
                'probs': probs, 'entropy': ent, 'confidence': conf,
                'uncertainty': ent - conf / 200
            })
        vote_choices = assign_doubles_xgb(vote_matches)

        # XGBoost + votes processing
        xgb_matches = []
        feature_matrix = []
        for m in matches:
            feat = extract_features(m, db)
            feature_matrix.append(feat)
            vh = m['vote_home'] or 33; vd = m['vote_draw'] or 33; va = m['vote_away'] or 34
            tv = vh + vd + va
            vote_probs = [vh / tv, vd / tv, va / tv]
            xgb_matches.append({
                '_match': m, '_feat': feat, '_vote_probs': vote_probs
            })

        # Batch predict
        dmat = xgb.DMatrix(np.array(feature_matrix, dtype=np.float32), feature_names=booster.feature_names)
        xgb_raw = booster.predict(dmat)

        xgb_processed = []
        for i, m in enumerate(xgb_matches):
            raw = list(xgb_raw[i])
            xgb_probs = [raw[2], raw[1], raw[0]]  # reorder: home, draw, away
            vote_probs = m['_vote_probs']
            # Blend 25% XGB + 75% votes
            blended = [0.75 * vote_probs[j] + 0.25 * xgb_probs[j] for j in range(3)]
            bt = sum(blended)
            blended = [b / bt for b in blended]
            ent = compute_entropy(blended)
            conf = max(50, 80 - (ent * 15))
            xgb_processed.append({
                'idx': m['_match']['match_idx'], 'actual': m['_match']['result'],
                'probs': blended, 'entropy': ent, 'confidence': conf,
                'uncertainty': ent - conf / 200
            })
        xgb_choices = assign_doubles_xgb(xgb_processed)

        # Score both
        for g in GRID_NAMES:
            for vc in vote_choices[g]:
                m = next(x for x in vote_matches if x['idx'] == vc['idx'])
                is_correct = m['actual'] in vc['picks']
                if is_correct:
                    vote_results['grids'][g]['correct'] += 1
                    vote_results['correct'] += 1
                vote_results['grids'][g]['total'] += 1
                vote_results['total'] += 1

            for xc in xgb_choices[g]:
                m = next(x for x in xgb_processed if x['idx'] == xc['idx'])
                is_correct = m['actual'] in xc['picks']
                if is_correct:
                    xgb_results['grids'][g]['correct'] += 1
                    xgb_results['correct'] += 1
                xgb_results['grids'][g]['total'] += 1
                xgb_results['total'] += 1

        if (ci + 1) % 50 == 0 or ci == len(concours_list) - 1:
            va = vote_results['correct'] / max(1, vote_results['total']) * 100
            xa = xgb_results['correct'] / max(1, xgb_results['total']) * 100
            print(f"  {ci + 1}/{len(concours_list)}: Vote={va:.1f}% XGB={xa:.1f}%")

    db.close()

    print(f"\n{'=' * 60}")
    print(f"RESULTS")
    print(f"{'=' * 60}")
    for label, results in [("VOTE-ONLY", vote_results), ("XGBoost BLEND (25%)", xgb_results)]:
        total = results['total']
        correct = results['correct']
        acc = correct / total * 100 if total > 0 else 0
        print(f"\n{label}:")
        print(f"  Overall: {acc:.2f}% ({correct}/{total})")
        for g in GRID_NAMES:
            gt = results['grids'][g]['total']
            gc = results['grids'][g]['correct']
            ga = gc / gt * 100 if gt > 0 else 0
            print(f"  {g}: {ga:.2f}% ({gc}/{gt})")
    vote_acc = vote_results['correct'] / max(1, vote_results['total']) * 100
    delta = acc - vote_acc
    print(f"  Delta vs vote-only: {delta:+.2f}%")


if __name__ == "__main__":
    backtest_with_xgb()
