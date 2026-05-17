import json
import sys
import os

# Add core to path
sys.path.append(os.path.join(os.getcwd(), 'core'))

from prediction_engine import process_prediction

match_data = {
    "homeTeam": "Falkenbergs FF",
    "awayTeam": "IFK Norrkoping",
    "home_xg": 1.5,
    "away_xg": 2.25,
    "league": "Sweden Superettan",
    "tournament_name": "Superettan",
    "status": "scheduled",
    "startTimestamp": 1714932000 # Example timestamp
}

result = process_prediction(match_data)
print(json.dumps(result, indent=2))
