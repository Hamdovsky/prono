import json
from prediction_engine import process_prediction

test_match = {
    "homeTeam": "Real Madrid",
    "awayTeam": "Barcelona",
    "odds_home": 2.10,
    "odds_draw": 3.40,
    "odds_away": 3.50,
    "news_impact": 3.0
}

print(json.dumps(process_prediction(test_match), indent=2))
