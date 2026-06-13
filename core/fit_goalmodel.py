"""
fit_goalmodel.py — CLI script called by the worker to batch-fit Dixon-Coles MLE
parameters for all active leagues and persist them to the cache.

Usage:
    python fit_goalmodel.py all
    python fit_goalmodel.py "Premier League,LaLiga,Serie A"
"""
import sys
import os
import json
import sqlite3
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.goal_model import (
    fit_dixon_coles,
    calculate_time_weights,
    load_or_fit_goalmodel_parameters,
    save_cache,
    load_cache,
    _choose_distribution
)

DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')


def get_active_leagues(conn):
    cursor = conn.cursor()
    rows = cursor.execute(
        """SELECT league, COUNT(*) as cnt
           FROM historical_matches
           GROUP BY league
           HAVING cnt >= 10
           ORDER BY cnt DESC
           LIMIT 50"""
    ).fetchall()
    return [r[0] for r in rows]


def fit_league(conn, league_name):
    cursor = conn.cursor()
    rows = cursor.execute(
        """SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp
           FROM historical_matches
           WHERE league = ?
           ORDER BY timestamp DESC
           LIMIT 200""",
        (league_name,)
    ).fetchall()

    if not rows or len(rows) < 10:
        return None

    matches = []
    now = datetime.utcnow()
    for r in rows:
        ts_str = r[4] if r[4] else ''
        days_ago = 365
        if ts_str:
            try:
                dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                days_ago = max(0, (now - dt).days)
            except Exception:
                pass
        matches.append({
            'home': r[0] or '',
            'away': r[1] or '',
            'home_goals': int(r[2]) if r[2] is not None else 0,
            'away_goals': int(r[3]) if r[3] is not None else 0,
            'days_ago': days_ago
        })

    if len(matches) < 10:
        return None

    match_days = [m['days_ago'] for m in matches]
    time_weights = calculate_time_weights(match_days)
    result = fit_dixon_coles(matches, time_weights)

    if result.get('success'):
        result['league'] = league_name
        result['updated_at'] = datetime.utcnow().timestamp()
        result['distribution_type'] = _choose_distribution(matches)
        return result

    return None


def main():
    args = sys.argv[1] if len(sys.argv) > 1 else 'all'
    conn = None
    try:
        conn = sqlite3.connect(DB_ARCHIVE_PATH)
        conn.row_factory = sqlite3.Row
    except Exception as e:
        print(json.dumps({'error': f'Cannot open DB: {e}'}))
        sys.exit(1)

    if args == 'all':
        leagues = get_active_leagues(conn)
    else:
        leagues = [l.strip() for l in args.split(',') if l.strip()]

    cache = load_cache()
    fitted_count = 0

    for league in leagues:
        try:
            result = fit_league(conn, league)
            if result:
                cache[league] = result
                fitted_count += 1
        except Exception as e:
            print(f"[FIT] Error fitting {league}: {e}", file=sys.stderr)

    save_cache(cache)

    output = {
        'fitted': fitted_count,
        'total_leagues': len(leagues),
        'leagues': leagues if fitted_count > 0 else []
    }
    print(json.dumps(output))

    if conn:
        conn.close()


if __name__ == '__main__':
    main()
