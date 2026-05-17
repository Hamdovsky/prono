import sqlite3
import os
import math
import json

DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')

class EloSystem:
    def __init__(self, k_factor=30, initial_rating=1500):
        self.k_factor = k_factor
        self.initial_rating = initial_rating
        self.ratings = {}

    def get_rating(self, team_name):
        return self.ratings.get(team_name, self.initial_rating)

    def calculate_expected_score(self, rating_a, rating_b):
        return 1.0 / (1.0 + pow(10, (rating_b - rating_a) / 400.0))

    def update_ratings(self, team_h, team_a, score_h, score_a, league_name='Unknown'):
        rating_h = self.get_rating(team_h)
        rating_a = self.get_rating(team_a)

        expected_h = self.calculate_expected_score(rating_h, rating_a)
        expected_a = 1.0 - expected_h

        # Actual result
        if score_h > score_a:
            actual_h, actual_a = 1.0, 0.0
        elif score_h < score_a:
            actual_h, actual_a = 0.0, 1.0
        else:
            actual_h, actual_a = 0.5, 0.5

        # Margin of victory multiplier (G-factor)
        diff = abs(score_h - score_a)
        g_factor = 1.0
        if diff == 2:
            g_factor = 1.5
        elif diff >= 3:
            g_factor = (11 + diff) / 8.0

        # Tier-based K-factor adjustment (Ultra Enhancement V19)
        tier_map = {
            'Premier League': 1, 'LaLiga': 1, 'Champions League': 1, 'Bundesliga': 1, 'Serie A': 1, 'Ligue 1': 1,
            'Championship': 2, 'Ligue 2': 2, 'Serie B': 2, 'Eredivisie': 2, 'Liga Portugal': 2, 'Saudi Pro League': 2, 'Europa League': 2
        }
        tier = tier_map.get(league_name, 3)
        tier_mult = 1.2 if tier == 1 else (1.1 if tier == 2 else 1.0)

        new_rating_h = rating_h + self.k_factor * tier_mult * g_factor * (actual_h - expected_h)
        new_rating_a = rating_a + self.k_factor * tier_mult * g_factor * (actual_a - expected_a)

        self.ratings[team_h] = new_rating_h
        self.ratings[team_a] = new_rating_a

    def process_historical_matches(self, limit=10000):
        if not os.path.exists(DB_ARCHIVE_PATH):
            return

        conn = sqlite3.connect(DB_ARCHIVE_PATH)
        cursor = conn.cursor()
        
        # Select all matches ordered by date/id
        cursor.execute("SELECT homeTeam, awayTeam, scoreHome, scoreAway, league FROM archive_matches ORDER BY id ASC LIMIT ?", (limit,))
        rows = cursor.fetchall()

        for team_h, team_a, s_h, s_a, league in rows:
            if s_h is not None and s_a is not None:
                self.update_ratings(team_h, team_a, s_h, s_a, league)
        
        conn.close()

    def save_ratings(self, path='data/elo_ratings.json'):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(self.ratings, f, indent=2)

if __name__ == "__main__":
    elo = EloSystem()
    print("Calculating Elo ratings from history (V19 Tier Weighting)...")
    elo.process_historical_matches(limit=15000)
    print(f"Computed ratings for {len(elo.ratings)} teams.")
    elo.save_ratings()
    print("Ratings saved to data/elo_ratings.json")
