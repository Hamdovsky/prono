import sqlite3
import json
import os
import pandas as pd
import numpy as np
from datetime import datetime

# 🕵️‍♂️ [INTEGRITY ANALYST] - Dead Mid-Table Syndrome Engine
# Analyzes teams in the "Dead Zone" (Ranks 8-14) during the end of season.

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')

class DeadZoneAnalyst:
    def __init__(self, db_path):
        self.db_path = db_path
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row

    def get_finished_matches(self, league):
        query = "SELECT * FROM matches WHERE league = ? AND status = 'finished' ORDER BY timestamp ASC"
        return self.conn.execute(query, (league,)).fetchall()

    def calculate_league_table(self, matches):
        teams = {}
        for m in matches:
            h, a = m['homeTeam'], m['awayTeam']
            sh, sa = m['scoreHome'], m['scoreAway']
            if h not in teams: teams[h] = {'pts': 0, 'played': 0, 'goals_con': 0, 'id': m['home_team_id']}
            if a not in teams: teams[a] = {'pts': 0, 'played': 0, 'goals_con': 0, 'id': m['away_team_id']}
            
            teams[h]['played'] += 1
            teams[a]['played'] += 1
            teams[h]['goals_con'] += sa
            teams[a]['goals_con'] += sh
            
            if sh > sa: teams[h]['pts'] += 3
            elif sh < sa: teams[a]['pts'] += 3
            else:
                teams[h]['pts'] += 1
                teams[a]['pts'] += 1
        return teams

    def analyze_integrity(self, league_name):
        print(f"🕵️‍♂️ [ANALYSIS] Scanning {league_name} for Integrity Risks...")
        matches = self.get_finished_matches(league_name)
        if not matches: return []

        total_rounds = len(matches) // (len(set([m['homeTeam'] for m in matches])) // 2)
        print(f"📊 Detected ~{total_rounds} rounds.")

        # 1. Identify "Dead Zone" teams at round (total-8)
        # We simulate the table up to the last 8 rounds
        cutoff_idx = int(len(matches) * 0.8) # Approx last 20% of season matches
        early_matches = matches[:cutoff_idx]
        late_matches = matches[cutoff_idx:]
        
        table = self.calculate_league_table(early_matches)
        sorted_teams = sorted(table.items(), key=lambda x: x[1]['pts'], reverse=True)
        
        relegation_pts = sorted_teams[-3][1]['pts'] if len(sorted_teams) > 17 else 0
        dead_zone_candidates = []
        
        for rank, (name, stats) in enumerate(sorted_teams, 1):
            # Rank 8-14 AND > 10 pts from relegation
            if 8 <= rank <= 14 and (stats['pts'] - relegation_pts) > 10:
                dead_zone_candidates.append(name)
        
        print(f"🚧 Dead Zone Candidates: {', '.join(dead_zone_candidates)}")

        blacklist = []
        for team in dead_zone_candidates:
            suspicious_matches = 0
            dev_score = 0
            steam_count = 0
            
            # Baseline (First 20-30 matches)
            team_early = [m for m in early_matches if m['homeTeam'] == team or m['awayTeam'] == team]
            avg_poss_early = np.mean([m['possession_home'] if m['homeTeam'] == team else m['possession_away'] for m in team_early])
            avg_sot_early = np.mean([m['shots_on_target_home'] if m['homeTeam'] == team else m['shots_on_target_away'] for m in team_early])

            # Late performance
            team_late = [m for m in late_matches if m['homeTeam'] == team or m['awayTeam'] == team]
            for m in team_late:
                is_home = m['homeTeam'] == team
                poss = m['possession_home'] if is_home else m['possession_away']
                sot = m['shots_on_target_home'] if is_home else m['shots_on_target_away']
                
                # Criteria: Stat drop > 40%
                if poss < (avg_poss_early * 0.6) or sot < (avg_sot_early * 0.6):
                    # Check if opponent needed points (bottom 5)
                    opp = m['awayTeam'] if is_home else m['homeTeam']
                    opp_rank = next((i for i, (n, _) in enumerate(sorted_teams, 1) if n == opp), 20)
                    
                    if opp_rank >= 15: # Opponent in relegation scrap
                        suspicious_matches += 1
                        dev_score += (1 - (poss/avg_poss_early)) * 100

                # Market: Steam Moves (>30% drop for opponent)
                o_close = m['odds_away'] if is_home else m['odds_home']
                o_open = m['odds_away_open'] if is_home else m['odds_home_open']
                if o_open and o_close and (o_open - o_close) / o_open > 0.3:
                    steam_count += 1
            
            if suspicious_matches > 0:
                # 4. Mutual Benefit Pattern (Points Recycling)
                recycling_risk = self.check_mutual_benefit(team, matches)
                
                blacklist.append({
                    'team': team,
                    'matches': suspicious_matches,
                    'deviance': round(dev_score / suspicious_matches, 2),
                    'steam': steam_count,
                    'recycling': recycling_risk
                })

        return blacklist

    def check_mutual_benefit(self, team, all_matches):
        # Placeholder for cross-season points recycling logic
        # Logic: Did they lose to a bottom team last year and win early this year?
        return "LOW" # Current DB limited to 1 season

    def print_blacklist(self, league):
        results = self.analyze_integrity(league)
        print("\n" + "="*80)
        print(f"🚨 THE BLACKLIST: {league.upper()} (Dead Mid-Table Syndrome)")
        print("="*80)
        print(f"{'TEAM':<25} | {'SUSP. MTCH':<10} | {'DEV %':<10} | {'STEAM'} | {'RECYCLING'}")
        print("-" * 85)
        for r in sorted(results, key=lambda x: x['deviance'], reverse=True):
            print(f"{r['team']:<25} | {r['matches']:<10} | {r['deviance']:<10}% | {r['steam']:<5} | {r['recycling']}")
        print("="*85 + "\n")

if __name__ == "__main__":
    analyst = DeadZoneAnalyst(DB_PATH)
    # Scan major leagues
    leagues = ["Spain - LaLiga", "Premier League", "Serie A", "Ligue 1", "Saudi Pro League", "Egyptian Premier League"]
    for l in leagues:
        analyst.print_blacklist(l)
