import sqlite3
import json
import math
from scipy.stats import poisson
import numpy as np
import datetime
import codecs

def calculate_team_strength(team_name, is_home):
    try:
        conn = sqlite3.connect('data/historical_archive.sqlite')
        conn.row_factory = sqlite3.Row
        
        # Get last 10 matches for the team
        query = """
            SELECT homeTeam, awayTeam, scoreHome, scoreAway, date
            FROM archive_matches
            WHERE (homeTeam = ? OR awayTeam = ?)
              AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
              AND status IN ('FINISHED', 'FT', 'Finished')
            ORDER BY date DESC
            LIMIT 10
        """
        rows = conn.execute(query, (team_name, team_name)).fetchall()
        
        if not rows:
            return 1.2, 1.2 # Default avg goals scored and conceded
            
        scored = []
        conceded = []
        
        for i, row in enumerate(rows):
            # Applying decay factor: last 3 matches have weight 2, rest have weight 1
            weight = 2 if i < 3 else 1
            
            if row['homeTeam'] == team_name:
                s = row['scoreHome']
                c = row['scoreAway']
            else:
                s = row['scoreAway']
                c = row['scoreHome']
                
            for _ in range(weight):
                scored.append(s)
                conceded.append(c)
                
        avg_scored = sum(scored) / len(scored) if scored else 1.2
        avg_conceded = sum(conceded) / len(conceded) if conceded else 1.2
        
        return avg_scored, avg_conceded
    except Exception as e:
        return 1.2, 1.2

def analyze_value_bets():
    try:
        conn = sqlite3.connect('data/tactical.db')
        conn.row_factory = sqlite3.Row
        
        # Get scheduled matches with odds
        matches = conn.execute("""
            SELECT id, homeTeam, awayTeam, odds_home, odds_draw, odds_away, 
                   home_win_probability, expected_score, news_impact, xgboost_confidence
            FROM matches
            WHERE status = 'scheduled'
        """).fetchall()
        
        results = []
        
        for m in matches:
            home = m['homeTeam']
            away = m['awayTeam']
            odds_h = m['odds_home'] or 0
            news_impact = m['news_impact'] or 0
            
            # 1. Calcul des forces (Attaque/Défense pondérées)
            h_scored, h_conceded = calculate_team_strength(home, True)
            a_scored, a_conceded = calculate_team_strength(away, False)
            
            # Home Advantage = +15% attack for home, +5% defense for home
            xg_h = (h_scored + a_conceded) / 2 * 1.15
            xg_a = (a_scored + h_conceded) / 2 * 0.95
            
            # Floor to prevent extreme ~0 xG
            xg_h = max(0.4, xg_h)
            xg_a = max(0.4, xg_a)
            
            # 2. Modèle de Score Poisson (0-0 à 5-5)
            max_goals = 5
            probs_h = [poisson.pmf(i, xg_h) for i in range(max_goals + 1)]
            probs_a = [poisson.pmf(i, xg_a) for i in range(max_goals + 1)]
            matrix = np.outer(probs_h, probs_a)
            
            # Probabilités 1X2
            prob_home = np.tril(matrix, -1).sum()
            prob_draw = np.trace(matrix)
            prob_away = np.triu(matrix, 1).sum()
            
            # Score Prédit (le plus probable)
            best_prob = -1
            predicted_score = "1 - 1"
            for h_g in range(max_goals + 1):
                for a_g in range(max_goals + 1):
                    if matrix[h_g, a_g] > best_prob:
                        best_prob = matrix[h_g, a_g]
                        predicted_score = f"{h_g}-{a_g}"
            
            # 3. Calcul de la Value Index (Prob * Cote)
            outcomes = [
                ("Home", prob_home, m['odds_home'] or 0),
                ("Draw", prob_draw, m['odds_draw'] or 0),
                ("Away", prob_away, m['odds_away'] or 0)
            ]
            
            best_outcome = max(outcomes, key=lambda x: x[1])
            selection = best_outcome[0]
            win_prob = best_outcome[1] * 100
            odds = best_outcome[2]
            
            value_index = (win_prob / 100) * odds if odds > 0 else 0
            
            # Confidence based on probability and news impact alignment
            confidence = win_prob
            if (selection == "Home" and news_impact >= 2): confidence += 10
            elif (selection == "Away" and news_impact <= -2): confidence += 10
            elif (selection == "Home" and news_impact < 0): confidence -= 15
            elif (selection == "Away" and news_impact > 0): confidence -= 15
            
            # Normalize confidence 0-100%
            confidence = min(100.0, max(0.0, confidence))
            
            # 4. Filtre de Confirmation (>75% conf, value > 1.10)
            is_value = value_index > 1.10
            is_confirmed = confidence > 75 and is_value
            
            if is_value or confidence > 60: # Show value bets and high confidence ones
                results.append({
                    "match": f"{home} vs {away}",
                    "score": predicted_score,
                    "prob": win_prob,
                    "odds": odds,
                    "value": value_index,
                    "selection": selection,
                    "confirmed": is_confirmed,
                    "confidence": confidence
                })
                
        # Sort by Value Index descending
        results.sort(key=lambda x: x['value'], reverse=True)
        
        with codecs.open("value_bets_results.txt", "w", "utf-8") as f:
            f.write(f"{'Match':<40} | {'Score':<5} | {'Pick':<4} | {'Prob%':<5} | {'Odd':<4} | {'ValIdx':<6} | {'Confirmed?'}\n")
            f.write("-" * 110 + "\n")
            for r in results[:40]: # Show top 40
                conf_str = "OUI " if r['confirmed'] else "NON "
                f.write(f"{r['match']:<40} | {r['score']:<5} | {r['selection']:<4} | {r['prob']:>5.1f}% | {r['odds']:>4.2f} | {r['value']:>6.2f} | {conf_str} ({r['confidence']:.1f}%)\n")
            
    except Exception as e:
        with open("value_bets_results.txt", "w") as f:
            f.write(f"Error: {str(e)}")

if __name__ == '__main__':
    analyze_value_bets()
