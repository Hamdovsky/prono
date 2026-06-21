"""
estimate_odds_from_history.py — Script autonome pour estimer les cotes manquantes
depuis les moyennes historiques (soccer_odds) + ajustement Elo.

Usage:
    python scripts/estimate_odds_from_history.py --league "USL Championship"
    python scripts/estimate_odds_from_history.py --match "Almeria" "Malaga CF" "Segunda Division"
    python scripts/estimate_odds_from_history.py --list-leagues
"""

import sqlite3, os, sys, json, argparse, unicodedata

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
HIST_DB = os.path.join(DATA_DIR, 'historical_archive.sqlite')
MAIN_DB = os.path.join(DATA_DIR, 'tactical.db')


def strip_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def list_leagues():
    """Lister toutes les ligues disponibles dans soccer_odds avec leurs stats."""
    db = sqlite3.connect(HIST_DB)
    rows = db.execute('''
        SELECT l.name, COUNT(*) as cnt,
               ROUND(AVG(o.home_win), 2) as avg_h,
               ROUND(AVG(o.draw), 2) as avg_d,
               ROUND(AVG(o.away_win), 2) as avg_a
        FROM soccer_odds o
        JOIN soccer_fixtures f ON o.fixture_id = f.id
        JOIN soccer_leagues l ON f.league_id = l.id
        GROUP BY l.name
        HAVING cnt >= 10
        ORDER BY cnt DESC
    ''').fetchall()
    db.close()

    print(f"{'League':35} {'Matches':>8} {'H':>6} {'D':>6} {'A':>6}")
    print('-' * 65)
    for r in rows:
        print(f"{r[0]:35} {r[1]:>8} {r[2]:>6} {r[3]:>6} {r[4]:>6}")

    print(f'\nTotal: {len(rows)} leagues with >=10 matches')


def estimate_for_league(league_name):
    """Estimer les cotes moyennes pour une ligue."""
    db = sqlite3.connect(HIST_DB)
    normalized = strip_accents(league_name)
    row = db.execute('''
        SELECT AVG(o.home_win), AVG(o.draw), AVG(o.away_win), COUNT(*)
        FROM soccer_odds o
        JOIN soccer_fixtures f ON o.fixture_id = f.id
        JOIN soccer_leagues l ON f.league_id = l.id
        WHERE l.name LIKE ? COLLATE NOCASE
    ''', (f'%{normalized}%',)).fetchone()
    db.close()

    if row and row[3] >= 10:
        return {'home_win': round(row[0], 2), 'draw': round(row[1], 2), 'away_win': round(row[2], 2), 'matches': row[3]}
    return None


def get_elo_rating(team_name):
    """Obtenir le rating Elo d'une équipe depuis la DB principale."""
    if not os.path.exists(MAIN_DB):
        return None
    db = sqlite3.connect(MAIN_DB)
    row = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='config_engine'").fetchone()
    if not row:
        db.close()
        return None
    r = db.execute("SELECT rating FROM config_engine WHERE key = ?", (f'elo_{team_name}',)).fetchone()
    db.close()
    return float(r[0]) if r else None


def estimate_with_elo(home, away, league_name):
    """Estimer les cotes avec ajustement Elo."""
    base = estimate_for_league(league_name)
    if not base:
        return None

    home_elo = get_elo_rating(home)
    away_elo = get_elo_rating(away)

    if home_elo and away_elo:
        diff = home_elo - away_elo
        expected = 1.0 / (1 + 10 ** (-diff / 400.0))
        home_bias = (expected - 0.5) * 0.5
        away_bias = -home_bias

        return {
            'home_win': round(max(1.01, base['home_win'] - home_bias), 2),
            'draw': round(max(1.01, base['draw']), 2),
            'away_win': round(max(1.01, base['away_win'] + away_bias), 2),
            'base_avg': base,
            'elo_home': round(home_elo, 0),
            'elo_away': round(away_elo, 0),
            'home_prob': round(expected, 3),
            'away_prob': round(1 - expected, 3),
        }

    return {
        'home_win': base['home_win'],
        'draw': base['draw'],
        'away_win': base['away_win'],
        'base_avg': base,
        'note': 'No Elo data available'
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Estimer les cotes depuis les données historiques')
    parser.add_argument('--list-leagues', action='store_true', help='Lister les ligues disponibles')
    parser.add_argument('--league', type=str, help='Nom de la ligue à estimer')
    parser.add_argument('--match', nargs=3, metavar=('HOME', 'AWAY', 'LEAGUE'), help='Match spécifique avec Elo')

    args = parser.parse_args()

    if args.list_leagues:
        list_leagues()
    elif args.league:
        est = estimate_for_league(args.league)
        if est:
            print(f"Ligue: {args.league}")
            print(f"Cotes estimées: H={est['home_win']} D={est['draw']} A={est['away_win']}")
            print(f"Basé sur {est['matches']} matchs historiques")
        else:
            print(f"Aucune donnée historique pour '{args.league}' (min 10 matchs requis)")
    elif args.match:
        home, away, league = args.match
        est = estimate_with_elo(home, away, league)
        if est:
            print(f"{home} vs {away} [{league}]")
            print(f"Cotes: H={est['home_win']} D={est['draw']} A={est['away_win']}")
            if 'elo_home' in est:
                print(f"Elo: {home}={int(est['elo_home'])} {away}={int(est['elo_away'])}")
                print(f"Probabilité Elo: {est['home_prob']*100:.1f}% / {est['away_prob']*100:.1f}%")
        else:
            print(f"Aucune estimation disponible")
    else:
        parser.print_help()
