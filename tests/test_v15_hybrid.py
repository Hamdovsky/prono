# -*- coding: utf-8 -*-
import json
import sys
import os

sys.path.append(os.path.join(os.getcwd(), 'core'))

from prediction_engine import process_prediction

test_match = {
    "homeTeam": "Real Madrid",
    "awayTeam": "Barcelona",
    "league": "La Liga",
    "scoreHome": None,
    "scoreAway": None,
    "status": "PRE",
    "startTimestamp": 1741720000,
    "possession_home": 55,
    "possession_away": 45,
    "shots_on_target_home": 7,
    "shots_on_target_away": 3,
    "corners_home": 6,
    "corners_away": 4,
    "home_xg": 2.1,
    "away_xg": 1.2
}

# Set UTF-8 encoding for stdout
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

print("[TEST] Testing V15 Deep Prime Hybrid Integration...")
res = process_prediction(test_match)

if res['success']:
    print(f"[OK] AI Source: {res['ai_source']}")
    print("[OK] Main Predictions:")
    for p in res.get('main_predictions', []):
        print(f"  - {p.get('type', p.get('label', '?'))}: {p.get('prediction', p.get('val', '?'))}")
    print()
    print("[OK] Probabilities:")
    print(f"  - Win Prob (H/D/A): {res.get('home_win_probability', 0)*100:.1f}% / {res.get('draw_probability', 0)*100:.1f}% / {res.get('away_win_probability', 0)*100:.1f}%")
    print(f"  - Expected Score: {res.get('expected_score', 'N/A')}")
else:
    print(f"[ERR] Error: {res.get('error')}")
