import subprocess, importlib, sys, os, math, json
for _p in ['pandas', 'numpy', 'optuna', 'xgboost', 'sklearn', 'joblib']:
    try:
        importlib.import_module(_p)
    except ImportError:
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--no-cache-dir',
                               '--break-system-packages',
                               {'sklearn': 'scikit-learn'}.get(_p, _p)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

import sqlite3
import pandas as pd
import numpy as np
import optuna
import xgboost as xgb
from sklearn.metrics import accuracy_score, log_loss, classification_report
from collections import defaultdict, deque
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
MODEL_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')
MODEL_PATH = os.path.join(MODEL_DIR, 'promosport_v553_enriched.json')
os.makedirs(MODEL_DIR, exist_ok=True)

FEATURE_NAMES_V553_STYLE = [
    # === Original Promosport features ===
    'home_win_rate_5', 'home_draw_rate_5', 'home_loss_rate_5',
    'away_win_rate_5', 'away_draw_rate_5', 'away_loss_rate_5',
    'home_win_rate_10', 'home_draw_rate_10', 'home_loss_rate_10',
    'away_win_rate_10', 'away_draw_rate_10', 'away_loss_rate_10',
    'home_win_rate_all', 'home_draw_rate_all', 'home_loss_rate_all',
    'away_win_rate_all', 'away_draw_rate_all', 'away_loss_rate_all',
    'vote_home', 'vote_draw', 'vote_away',
    'vote_home_norm', 'vote_draw_norm', 'vote_away_norm',
    'vote_advantage_home', 'vote_advantage_away',
    'h2h_home_wins', 'h2h_draws', 'h2h_away_wins', 'h2h_matches',
    'home_pts_per_match_10', 'away_pts_per_match_10',
    'home_pts_per_match_all', 'away_pts_per_match_all',
    'pts_diff_10', 'pts_diff_all',
    'home_avg_scored_5', 'home_avg_conceded_5',
    'away_avg_scored_5', 'away_avg_conceded_5',
    'home_avg_scored_10', 'home_avg_conceded_10',
    'away_avg_scored_10', 'away_avg_conceded_10',
    'home_form_score', 'away_form_score',
    'home_last_result', 'away_last_result',
    'home_matches_in_period', 'away_matches_in_period',
    'total_concours_for_pair',
    'form_diff', 'win_rate_diff_all', 'avg_scored_diff_10', 'avg_conceded_diff_10',
    'vote_x_home_form', 'vote_x_pts_diff', 'home_vote_x_winrate',

    # === V553-Style enriched features ===
    'home_elo', 'away_elo', 'elo_diff',
    'home_win_streak', 'away_win_streak',
    'home_draw_streak', 'away_draw_streak',
    'home_loss_streak', 'away_loss_streak',
    'home_scoring_streak', 'away_scoring_streak',
    'home_clean_streak', 'away_clean_streak',
    'home_form_momentum', 'away_form_momentum',
    'home_form_trend', 'away_form_trend',
    'home_days_rest', 'away_days_rest',
    'home_recency_weighted_form', 'away_recency_weighted_form',
    'h2h_avg_goals', 'h2h_over25_rate',
    'home_momentum_vs_avg', 'away_momentum_vs_avg',
    'home_form_volatility', 'away_form_volatility',
]

TARGET_ENCODE = {'1': 2, 'X': 1, '2': 0}

def _parse_ts(date_str):
    if not date_str:
        return 0
    try:
        dt = datetime.fromisoformat(str(date_str).replace('Z', '+00:00'))
        return int(dt.timestamp())
    except:
        try:
            dt = datetime.strptime(str(date_str)[:19], '%Y-%m-%dT%H:%M:%S')
            return int(dt.replace(tzinfo=timezone.utc).timestamp())
        except:
            return 0


class EloSystem:
    def __init__(self, k=32, home_adv=100, init_rating=1500):
        self.k = k
        self.home_adv = home_adv
        self.ratings = defaultdict(lambda: init_rating)

    def expected_score(self, r_a, r_b):
        return 1.0 / (1.0 + 10 ** ((r_b - r_a) / 400.0))

    def update(self, home, away, result):
        r_h = self.ratings[home] + self.home_adv
        r_a = self.ratings[away]
        e_h = self.expected_score(r_h, r_a)
        e_a = 1.0 - e_h
        if result == '1':
            s_h, s_a = 1.0, 0.0
        elif result == 'X':
            s_h, s_a = 0.5, 0.5
        else:
            s_h, s_a = 0.0, 1.0
        self.ratings[home] += self.k * (s_h - e_h)
        self.ratings[away] += self.k * (s_a - e_a)

    def get_rating(self, team):
        return self.ratings.get(team, 1500)


def compute_elos(conn):
    rows = conn.execute("""
        SELECT homeTeam, awayTeam, result, archived_at
        FROM promosport_archive
        WHERE result IS NOT NULL AND result != 'N'
        ORDER BY archived_at ASC
    """).fetchall()
    elo = EloSystem(k=24)
    snapshots = []
    for r in rows:
        elo.update(r[0], r[1], r[2])
        ts = _parse_ts(r[3])
        snapshots.append((r[0], r[1], ts, elo.get_rating(r[0]), elo.get_rating(r[1])))
    elo_final = {}
    for team in set(s[0] for s in snapshots) | set(s[1] for s in snapshots):
        elo_final[team] = elo.get_rating(team)
    return elo_final, snapshots


def get_elo_at_date(elo_snapshots, team, before_ts):
    best = 1500
    for h, a, ts, rh, ra in elo_snapshots:
        if ts >= before_ts and before_ts > 0:
            break
        if h == team:
            best = rh
        elif a == team:
            best = ra
    return best


def get_streaks(conn, team, before_date, result_type='win'):
    date_filter = ''
    params = [team, team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    if result_type == 'win':
        cond = "result = '1'"
        home_then = "'1'"
        away_then = "'2'"
    elif result_type == 'draw':
        cond = "result = 'X'"
        home_then = "'X'"
        away_then = "'X'"
    else:
        cond = "result = '2'"
        home_then = "'2'"
        away_then = "'1'"
    rows = conn.execute(f"""
        SELECT result, homeTeam FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC
    """, params).fetchall()
    streak = 0
    for r in rows:
        is_home = (r[1] == team)
        if (is_home and r[0] == home_then) or (not is_home and r[0] == away_then):
            streak += 1
        else:
            break
    return streak


def get_scoring_streak(conn, team, before_date):
    date_filter = ''
    params = [team, team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    rows = conn.execute(f"""
        SELECT score_home, score_away, homeTeam FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND score_home IS NOT NULL
          {date_filter}
        ORDER BY archived_at DESC
    """, params).fetchall()
    streak = 0
    for r in rows:
        is_home = (r[2] == team)
        scored = r[0] if is_home else r[1]
        if scored and int(scored) > 0:
            streak += 1
        else:
            break
    return streak


def get_clean_streak(conn, team, before_date):
    date_filter = ''
    params = [team, team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    rows = conn.execute(f"""
        SELECT score_home, score_away, homeTeam FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND score_home IS NOT NULL
          {date_filter}
        ORDER BY archived_at DESC
    """, params).fetchall()
    streak = 0
    for r in rows:
        is_home = (r[2] == team)
        conceded = r[1] if is_home else r[0]
        if conceded is not None and int(conceded) == 0:
            streak += 1
        else:
            break
    return streak


def get_days_rest(conn, team, before_date):
    if not before_date:
        return 7
    ts = _parse_ts(before_date)
    if ts <= 0:
        return 7
    row = conn.execute("""
        SELECT archived_at FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND archived_at < ?
          AND result IS NOT NULL AND result != 'N'
        ORDER BY archived_at DESC LIMIT 1
    """, [team, team, before_date]).fetchone()
    if not row:
        return 7
    last_ts = _parse_ts(row[0])
    if last_ts <= 0:
        return 7
    diff_seconds = ts - last_ts
    diff_days = diff_seconds / 86400.0
    return min(max(diff_days, 1), 30)


def get_recency_weighted_form(conn, team, before_date, decay=0.9):
    date_filter = ''
    params = [team, team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    rows = conn.execute(f"""
        SELECT result, homeTeam, archived_at FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC LIMIT 10
    """, params).fetchall()
    if not rows:
        return 0.5
    total_w = 0.0
    total_score = 0.0
    base_ts = _parse_ts(rows[0][2]) if rows and rows[0][2] else 0
    for i, r in enumerate(rows):
        is_home = (r[1] == team)
        res = r[0]
        if res == '1':
            pts = 3 if is_home else 0
        elif res == '2':
            pts = 0 if is_home else 3
        else:
            pts = 1
        w = decay ** i
        total_w += w
        total_score += pts * w
    return total_score / total_w if total_w > 0 else 0.5


def get_form_trend(conn, team, before_date):
    recent = get_recency_weighted_form(conn, team, before_date, decay=0.7)
    older = get_recency_weighted_form(conn, team, before_date, decay=0.3)
    return recent - older


def get_form_momentum(conn, team, before_date):
    date_filter = ''
    params = [team, team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    rows = conn.execute(f"""
        SELECT result, homeTeam FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC LIMIT 5
    """, params).fetchall()
    if len(rows) < 2:
        return 0.0
    pts = []
    for r in rows:
        is_home = (r[1] == team)
        res = r[0]
        if res == '1':
            pts.append(3 if is_home else 0)
        elif res == '2':
            pts.append(0 if is_home else 3)
        else:
            pts.append(1)
    momentum = sum((4 - i) * pts[i] for i in range(len(pts)))
    expected = sum((4 - i) * 1.5 for i in range(len(pts)))
    return momentum / expected - 1.0 if expected > 0 else 0.0


def get_form_volatility(conn, team, before_date):
    date_filter = ''
    params = [team, team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    rows = conn.execute(f"""
        SELECT result, homeTeam FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC LIMIT 6
    """, params).fetchall()
    if len(rows) < 3:
        return 0.0
    pts = []
    for r in rows:
        is_home = (r[1] == team)
        res = r[0]
        if res == '1':
            pts.append(3 if is_home else 0)
        elif res == '2':
            pts.append(0 if is_home else 3)
        else:
            pts.append(1)
    return float(np.std(pts))


def get_momentum_vs_avg(conn, team, before_date):
    recent = get_recency_weighted_form(conn, team, before_date, decay=0.8)
    all_time = get_recency_weighted_form(conn, team, before_date, decay=0.1)
    if all_time > 0:
        return (recent - all_time) / all_time
    return 0.0


def compute_team_stats(conn, team_name, before_date=None, limit_matches=None):
    date_filter = ''
    if before_date:
        date_filter = ' AND archived_at < ?'
    limit_filter = ''
    if limit_matches:
        limit_filter = f' ORDER BY archived_at DESC LIMIT {limit_matches}'
    query = f"""
        SELECT result, score_home, score_away
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        {limit_filter}
    """
    params = [team_name, team_name]
    if before_date:
        params.append(before_date)
    rows = conn.execute(query, params).fetchall()
    if not rows:
        return None
    total = len(rows)
    wins = draws = losses = 0
    pts_total = 0
    for r in rows:
        result = r[0]
        if result == '1':
            wins += 1
            pts_total += 3
        elif result == 'X':
            draws += 1
            pts_total += 1
        elif result == '2':
            losses += 1
    score_rows = conn.execute(f"""
        SELECT result, score_home, score_away, homeTeam
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          AND score_home IS NOT NULL
          {date_filter}
        {limit_filter}
    """, params).fetchall()
    gf = ga = 0
    for r in score_rows:
        is_home = (r[3] == team_name)
        if is_home and r[1] is not None:
            gf += int(r[1])
            ga += int(r[2]) if r[2] else 0
        elif r[2] is not None:
            gf += int(r[2])
            ga += int(r[1]) if r[1] else 0
    return {
        'matches': total, 'wins': wins, 'draws': draws, 'losses': losses,
        'pts_total': pts_total,
        'win_rate': wins / total if total > 0 else 0,
        'draw_rate': draws / total if total > 0 else 0,
        'loss_rate': losses / total if total > 0 else 0,
        'pts_per_match': pts_total / total if total > 0 else 0,
        'avg_scored': gf / len(score_rows) if score_rows else 0.5,
        'avg_conceded': ga / len(score_rows) if score_rows else 0.5,
    }


def get_h2h_stats(conn, home_team, away_team, before_date=None):
    date_filter = ''
    params = [home_team, away_team, home_team, away_team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    rows = conn.execute(f"""
        SELECT result, score_home, score_away, homeTeam
        FROM promosport_archive
        WHERE ((homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?))
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC LIMIT 10
    """, params).fetchall()
    h_wins = d = a_wins = 0
    total_goals = 0
    matches_with_scores = 0
    over25 = 0
    for r in rows:
        if r[0] == '1':
            h_wins += 1
        elif r[0] == 'X':
            d += 1
        else:
            a_wins += 1
        if r[1] is not None and r[2] is not None:
            total_goals += int(r[1]) + int(r[2])
            matches_with_scores += 1
            if int(r[1]) + int(r[2]) > 2:
                over25 += 1
    return {
        'home_wins': h_wins, 'draws': d, 'away_wins': a_wins, 'total': len(rows),
        'avg_goals': total_goals / matches_with_scores if matches_with_scores > 0 else 2.5,
        'over25_rate': over25 / matches_with_scores if matches_with_scores > 0 else 0.5,
    }


def get_form_last_5(conn, team_name, before_date=None):
    date_filter = ''
    params = [team_name, team_name]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    rows = conn.execute(f"""
        SELECT result, homeTeam
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC LIMIT 5
    """, params).fetchall()
    score = 0
    last_result = 0
    for i, r in enumerate(rows):
        is_home = (r[1] == team_name)
        res = r[0]
        if res == '1':
            pts = 3 if is_home else 0
        elif res == '2':
            pts = 0 if is_home else 3
        else:
            pts = 1
        score += (pts * (1.0 / (i + 1)))
        if i == 0:
            last_result = pts
    return {'form_score': score, 'last_result': last_result}


def get_team_concours_count(conn, team_name, before_date=None):
    date_filter = ''
    params = [team_name, team_name]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)
    row = conn.execute(f"""
        SELECT COUNT(DISTINCT concours) FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
    """, params).fetchone()
    return row[0]


def extract_features(row, conn, elo_snapshots):
    home = row['homeTeam']
    away = row['awayTeam']
    vote_h = row['vote_home'] if pd.notna(row.get('vote_home')) else 50
    vote_d = row['vote_draw'] if pd.notna(row.get('vote_draw')) else 33
    vote_a = row['vote_away'] if pd.notna(row.get('vote_away')) else 17
    archived_at = row.get('archived_at', None)
    before_ts = _parse_ts(archived_at)

    f = {}

    # === Vote features ===
    total_votes = vote_h + vote_d + vote_a
    f['vote_home'] = vote_h
    f['vote_draw'] = vote_d
    f['vote_away'] = vote_a
    f['vote_home_norm'] = vote_h / total_votes if total_votes > 0 else 0.5
    f['vote_draw_norm'] = vote_d / total_votes if total_votes > 0 else 0.33
    f['vote_away_norm'] = vote_a / total_votes if total_votes > 0 else 0.17
    f['vote_advantage_home'] = vote_h - vote_a
    f['vote_advantage_away'] = vote_a - vote_h

    # === Original stats ===
    for window, suffix in [(5, '5'), (10, '10'), (None, 'all')]:
        hs = compute_team_stats(conn, home, archived_at, window)
        aws = compute_team_stats(conn, away, archived_at, window)
        for team_prefix, stats in [('home', hs), ('away', aws)]:
            if stats:
                for k in ['win_rate', 'draw_rate', 'loss_rate', 'pts_per_match', 'avg_scored', 'avg_conceded']:
                    f[f'{team_prefix}_{k}_{suffix}'] = stats[k]
            else:
                for k in ['win_rate', 'draw_rate', 'loss_rate', 'pts_per_match', 'avg_scored', 'avg_conceded']:
                    f[f'{team_prefix}_{k}_{suffix}'] = 0.33

    f['pts_diff_10'] = f.get('home_pts_per_match_10', 0.33) - f.get('away_pts_per_match_10', 0.33)
    f['pts_diff_all'] = f.get('home_pts_per_match_all', 0.33) - f.get('away_pts_per_match_all', 0.33)

    # === H2H ===
    h2h = get_h2h_stats(conn, home, away, archived_at)
    f['h2h_home_wins'] = h2h['home_wins']
    f['h2h_draws'] = h2h['draws']
    f['h2h_away_wins'] = h2h['away_wins']
    f['h2h_matches'] = h2h['total']
    f['h2h_avg_goals'] = h2h['avg_goals']
    f['h2h_over25_rate'] = h2h['over25_rate']

    # === Form ===
    home_form = get_form_last_5(conn, home, archived_at)
    away_form = get_form_last_5(conn, away, archived_at)
    f['home_form_score'] = home_form['form_score']
    f['away_form_score'] = away_form['form_score']
    f['home_last_result'] = home_form['last_result']
    f['away_last_result'] = away_form['last_result']

    # === Match volume ===
    f['home_matches_in_period'] = get_team_concours_count(conn, home, archived_at)
    f['away_matches_in_period'] = get_team_concours_count(conn, away, archived_at)
    f['total_concours_for_pair'] = f['home_matches_in_period'] + f['away_matches_in_period']

    # === Differentials ===
    f['form_diff'] = f.get('home_form_score', 5) - f.get('away_form_score', 5)
    f['win_rate_diff_all'] = f.get('home_win_rate_all', 0.33) - f.get('away_win_rate_all', 0.33)
    f['avg_scored_diff_10'] = f.get('home_avg_scored_10', 0.5) - f.get('away_avg_scored_10', 0.5)
    f['avg_conceded_diff_10'] = f.get('home_avg_conceded_10', 0.5) - f.get('away_avg_conceded_10', 0.5)

    # === Interactions ===
    f['vote_x_home_form'] = f['vote_home'] * f['home_form_score']
    f['vote_x_pts_diff'] = f['vote_home'] * f['pts_diff_10']
    f['home_vote_x_winrate'] = f['vote_home_norm'] * f['home_win_rate_10']

    # === V553-Style features ===
    # ELO
    f['home_elo'] = get_elo_at_date(elo_snapshots, home, before_ts)
    f['away_elo'] = get_elo_at_date(elo_snapshots, away, before_ts)
    f['elo_diff'] = f['home_elo'] - f['away_elo']

    # Streaks
    f['home_win_streak'] = get_streaks(conn, home, archived_at, 'win')
    f['away_win_streak'] = get_streaks(conn, away, archived_at, 'win')
    f['home_draw_streak'] = get_streaks(conn, home, archived_at, 'draw')
    f['away_draw_streak'] = get_streaks(conn, away, archived_at, 'draw')
    f['home_loss_streak'] = get_streaks(conn, home, archived_at, 'loss')
    f['away_loss_streak'] = get_streaks(conn, away, archived_at, 'loss')
    f['home_scoring_streak'] = get_scoring_streak(conn, home, archived_at)
    f['away_scoring_streak'] = get_scoring_streak(conn, away, archived_at)
    f['home_clean_streak'] = get_clean_streak(conn, home, archived_at)
    f['away_clean_streak'] = get_clean_streak(conn, away, archived_at)

    # Momentum
    f['home_form_momentum'] = get_form_momentum(conn, home, archived_at)
    f['away_form_momentum'] = get_form_momentum(conn, away, archived_at)

    # Trend
    f['home_form_trend'] = get_form_trend(conn, home, archived_at)
    f['away_form_trend'] = get_form_trend(conn, away, archived_at)

    # Rest days
    f['home_days_rest'] = get_days_rest(conn, home, archived_at)
    f['away_days_rest'] = get_days_rest(conn, away, archived_at)

    # Recency-weighted form
    f['home_recency_weighted_form'] = get_recency_weighted_form(conn, home, archived_at)
    f['away_recency_weighted_form'] = get_recency_weighted_form(conn, away, archived_at)

    # Momentum vs average
    f['home_momentum_vs_avg'] = get_momentum_vs_avg(conn, home, archived_at)
    f['away_momentum_vs_avg'] = get_momentum_vs_avg(conn, away, archived_at)

    # Form volatility
    f['home_form_volatility'] = get_form_volatility(conn, home, archived_at)
    f['away_form_volatility'] = get_form_volatility(conn, away, archived_at)

    return f


def load_training_data():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        return None
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    limit = int(os.environ.get('PROMOSPORT_TRAIN_LIMIT', '8000'))
    df = pd.read_sql_query(f"""
        SELECT * FROM promosport_archive
        WHERE result IS NOT NULL AND result != 'N'
        ORDER BY archived_at DESC
        LIMIT {limit}
    """, conn)
    df = df.sort_values('archived_at').reset_index(drop=True)
    conn.close()
    return df


def build_dataset(df):
    print(f"Building feature matrix from {len(df)} matches...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("Computing ELO ratings across all teams...")
    elo_system = EloSystem(k=24)
    elo_snapshots = []
    all_rows = conn.execute("""
        SELECT homeTeam, awayTeam, result, archived_at
        FROM promosport_archive
        WHERE result IS NOT NULL AND result != 'N'
        ORDER BY archived_at ASC
    """).fetchall()
    for r in all_rows:
        elo_system.update(r[0], r[1], r[2])
        ts = _parse_ts(r[3])
        elo_snapshots.append((r[0], r[1], ts, elo_system.get_rating(r[0]), elo_system.get_rating(r[1])))
    print(f"ELO computed: {len(elo_snapshots)} updates across {len(set(s[0] for s in elo_snapshots) | set(s[1] for s in elo_snapshots))} teams")

    X_list, y_list = [], []
    errors = 0

    for idx, row in df.iterrows():
        try:
            features = extract_features(row, conn, elo_snapshots)
            X_list.append([features.get(k, 0.0) for k in FEATURE_NAMES_V553_STYLE])
            result = row['result']
            y_list.append(TARGET_ENCODE.get(result, 1))
        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  Error row {idx}: {e}")

        if (idx + 1) % 1000 == 0:
            print(f"  Progress: {idx + 1}/{len(df)}")

    conn.close()
    print(f"Done: {len(X_list)} samples, {errors} errors")
    return np.array(X_list, dtype=np.float32), np.array(y_list)


def noise_augment(X, y, noise_level=0.05, rng=None):
    if rng is None:
        rng = np.random.default_rng(42)
    noise = rng.normal(0, noise_level, X.shape)
    mask = np.abs(X) > 0.01
    X_aug = X.copy()
    X_aug[mask] = X_aug[mask] * (1.0 + noise[mask])
    X_aug = np.clip(X_aug, -10, 10)
    return np.vstack([X, X_aug]), np.concatenate([y, y])


def mixup_augmentation(X, y, alpha=0.3, p=0.25):
    n = len(X)
    mask = np.random.random(n) < p
    if not mask.any():
        return X, y
    indices = np.random.permutation(n)
    lam = np.random.beta(alpha, alpha, n)
    X_mix = X.copy()
    y_mix = y.copy()
    for i in np.where(mask)[0]:
        j = indices[i]
        l = lam[i]
        X_mix[i] = X[i] * (1 - l) + X[j] * l
        y_mix[i] = y[i]
    return X_mix, y_mix


def train_model():
    print("=" * 60)
    print("PROMOSPORT V553-ENRICHED XGBoost TRAINING")
    print(f"Features: {len(FEATURE_NAMES_V553_STYLE)} ({len(FEATURE_NAMES_V553_STYLE) - 48} new V553-style)")
    print("=" * 60)

    df = load_training_data()
    if df is None or len(df) < 50:
        print(f"Not enough data: {len(df) if df is not None else 0}")
        return

    print(f"Total matches with results: {len(df)}")

    X, y = build_dataset(df)
    n = len(X)
    if n < 50:
        print(f"Not enough samples after processing: {n}")
        return

    train_end = int(n * 0.70)
    val_end = int(n * 0.85)

    X_train, y_train = X[:train_end], y[:train_end]
    X_val, y_val = X[train_end:val_end], y[train_end:val_end]
    X_test, y_test = X[val_end:], y[val_end:]

    print(f"\nSplit: train={len(X_train)} val={len(X_val)} test={len(X_test)}")

    X_train_aug, y_train_aug = noise_augment(X_train, y_train, noise_level=0.06)
    X_train_aug, y_train_aug = mixup_augmentation(X_train_aug, y_train_aug)
    print(f"Augmented: {len(X_train)} -> {len(X_train_aug)}")

    classes, counts = np.unique(y_train_aug, return_counts=True)
    weights = {int(c): max(counts) / cnt for c, cnt in zip(classes, counts)}
    sample_weights = np.array([weights[int(y)] for y in y_train_aug])
    print(f"Class distribution: {dict(zip(classes, counts))}")
    print(f"Class weights: {weights}")

    print("\nOptimizing with Optuna (30 trials)...")

    def objective(trial):
        params = {
            'objective': 'multi:softprob',
            'num_class': 3,
            'eval_metric': 'mlogloss',
            'learning_rate': trial.suggest_float('lr', 0.01, 0.12, log=True),
            'max_depth': trial.suggest_int('max_depth', 3, 8),
            'subsample': trial.suggest_float('subsample', 0.6, 0.95),
            'colsample_bytree': trial.suggest_float('colsample_bytree', 0.5, 0.9),
            'min_child_weight': trial.suggest_int('min_child_weight', 1, 5),
            'reg_alpha': trial.suggest_float('alpha', 0.0, 1.0),
            'reg_lambda': trial.suggest_float('lambda', 0.0, 2.0),
            'n_estimators': trial.suggest_int('n_est', 300, 800),
            'random_state': 42,
            'early_stopping_rounds': 30,
            'verbosity': 0,
        }
        model = xgb.XGBClassifier(**params)
        model.fit(X_train_aug, y_train_aug, sample_weight=sample_weights,
                  eval_set=[(X_val, y_val)], verbose=False)
        return log_loss(y_val, model.predict_proba(X_val))

    study = optuna.create_study(direction='minimize', sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=30, show_progress_bar=True)

    best_params = study.best_params
    best_params.update({
        'objective': 'multi:softprob',
        'num_class': 3,
        'eval_metric': 'mlogloss',
        'random_state': 42,
    })
    print(f"\nBest params: {best_params}")
    print(f"Best val log loss: {study.best_value:.4f}")

    model = xgb.XGBClassifier(**best_params)
    model.fit(X_train_aug, y_train_aug, sample_weight=sample_weights,
              eval_set=[(X_val, y_val)], verbose=False)

    y_pred = np.argmax(model.predict_proba(X_test), axis=1)
    acc = accuracy_score(y_test, y_pred)
    ll = log_loss(y_test, model.predict_proba(X_test))

    print(f"\n{'=' * 60}")
    print(f"TEST SET RESULTS")
    print(f"{'=' * 60}")
    print(f"Accuracy: {acc * 100:.2f}% | Log Loss: {ll:.4f}")
    print(f"Test size: {len(y_test)} matches")
    print(f"\nClassification Report:")
    print(classification_report(y_test, y_pred, target_names=['Away', 'Draw', 'Home']))

    from sklearn.metrics import confusion_matrix
    cm = confusion_matrix(y_test, y_pred)
    print(f"Confusion Matrix:")
    print(f"           Pred Away  Pred Draw  Pred Home")
    print(f"Actual Away  {cm[0, 0]:5d}     {cm[0, 1]:5d}     {cm[0, 2]:5d}")
    print(f"Actual Draw  {cm[1, 0]:5d}     {cm[1, 1]:5d}     {cm[1, 2]:5d}")
    print(f"Actual Home  {cm[2, 0]:5d}     {cm[2, 1]:5d}     {cm[2, 2]:5d}")

    importance = model.get_booster().get_score(importance_type='gain')
    sorted_imp = sorted(importance.items(), key=lambda x: x[1], reverse=True)
    print(f"\nTop 20 Feature Importances (by gain):")
    for i, (feat, imp) in enumerate(sorted_imp[:20]):
        print(f"  {i + 1:2d}. {feat}: {imp:.3f}")

    model.get_booster().set_param('feature_names', ','.join(FEATURE_NAMES_V553_STYLE))
    model.get_booster().save_model(MODEL_PATH)
    print(f"\nModel saved: {MODEL_PATH}")

    # Platt calibration
    try:
        from sklearn.linear_model import LogisticRegression
        val_probs = model.predict_proba(X_val)
        cal_params = {'C': 1e6, 'solver': 'lbfgs', 'max_iter': 1000}
        try:
            cal_model = LogisticRegression(multi_class='multinomial', **cal_params)
        except TypeError:
            cal_model = LogisticRegression(**cal_params)
        cal_model.fit(val_probs, y_val)
        cal_probs = cal_model.predict_proba(model.predict_proba(X_test))
        cal_acc = accuracy_score(y_test, np.argmax(cal_probs, axis=1))
        cal_ll = log_loss(y_test, cal_probs)
        print(f"Calibrated: acc={cal_acc*100:.2f}% log_loss={cal_ll:.4f}")
        import joblib
        calibrator_path = MODEL_PATH.replace('.json', '_platt.pkl')
        joblib.dump(cal_model, calibrator_path)
        print(f"Platt calibrator saved: {calibrator_path}")
    except Exception as e:
        print(f"Calibration skipped: {e}")

    # Verify
    booster = xgb.Booster()
    booster.load_model(MODEL_PATH)
    dtest = xgb.DMatrix(X_test, feature_names=FEATURE_NAMES_V553_STYLE)
    y_pred_proba = booster.predict(dtest)
    y_pred_v = np.argmax(y_pred_proba, axis=1)
    test_acc = accuracy_score(y_test, y_pred_v)
    print(f"Verification load OK - test acc: {test_acc * 100:.2f}%")

    # Rollback protection
    backup_path = MODEL_PATH.replace('.json', '.backup.json')
    if os.path.exists(backup_path):
        old_booster = xgb.Booster()
        old_booster.load_model(backup_path)
        old_probs = old_booster.predict(dtest)
        old_pred = np.argmax(old_probs, axis=1)
        old_acc = accuracy_score(y_test, old_pred)
        old_ll = log_loss(y_test, old_probs)
        print(f"Old model: acc={old_acc*100:.2f}% log_loss={old_ll:.4f}")
        if old_acc >= test_acc:
            import shutil
            shutil.copy(backup_path, MODEL_PATH)
            print(f"Rollback: old acc={old_acc*100:.2f}% >= new acc={test_acc*100:.2f}%")
        else:
            print(f"New model accepted: {test_acc*100:.2f}% vs old {old_acc*100:.2f}%")

    return model


if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(line_buffering=True)

    # Backup existing model
    if os.path.exists(MODEL_PATH):
        import shutil
        backup_path = MODEL_PATH.replace('.json', '.backup.json')
        shutil.copy(MODEL_PATH, backup_path)
        print(f"Backup saved: {MODEL_PATH} -> {backup_path}")

    train_model()
