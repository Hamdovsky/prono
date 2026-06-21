"""Check get_team_history for key teams"""
import sys; sys.path.insert(0, 'core')
from ml_features import get_team_history, close_db_connection

for team in ['Man City', 'Arsenal', 'Bayern Munich', 'Augsburg', 'Liverpool', 'Everton']:
    hist = get_team_history(team, limit=5)
    print(f'{team}: {len(hist)} matches in history')
    for h in hist[:3]:
        print(f'  score_for={h.get("score_for")} score_against={h.get("score_against")} points={h.get("points")}')
    print()

close_db_connection()
