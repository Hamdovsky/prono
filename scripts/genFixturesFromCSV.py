"""genFixturesFromCSV.py — generate data/today_matches.json from the existing
football-data.co.uk fixtures CSV (data_pipeline/data/raw/football_data_fixtures.csv).
Unblocks the pipeline immediately without waiting for SofaScore scheduled-events
(which 404 on the sandbox's fictive date).
"""
import os
import sys
import csv
import json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE_DIR, 'data_pipeline', 'data', 'raw', 'football_data_fixtures.csv')
OUT = os.path.join(BASE_DIR, 'data', 'today_matches.json')


def main():
    if not os.path.exists(SRC):
        print(f"Manquant: {SRC}")
        sys.exit(1)
    out = []
    with open(SRC, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            home = (row.get('home_team') or '').strip()
            away = (row.get('away_team') or '').strip()
            if not home or not away:
                continue
            date = (row.get('date') or '').strip()
            league = (row.get('league') or '').strip()
            # conserve aussi les cotes CSV pour référence (non lues par SofaScore,
            # mais utiles au tier0 football_data)
            out.append({
                'home': home,
                'away': away,
                'league': league,
                'date': date,
                'kickoff_time': (row.get('kickoff_time') or '').strip(),
            })
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Ecrit {len(out)} matchs -> {OUT}")


if __name__ == '__main__':
    main()
