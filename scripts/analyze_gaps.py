import sqlite3
import json
import os
import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'tactical.db')
ACCURACY_LOG_PATH = os.path.join(os.path.dirname(__file__), 'data', 'accuracy_log.json')

def analyze_gaps():
    print("==================================================")
    print("  Gap Learning Engine (Misleading Odds/Votes)")
    print("==================================================")
    
    if not os.path.exists(DB_PATH):
        print(f"[ERROR] DB not found at {DB_PATH}")
        return
        
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    query = """
    SELECT id, homeTeam, awayTeam, scoreHome, scoreAway, league, home_win_probability, away_win_probability, expected_score, odds_home, odds_away, news_data
    FROM matches
    WHERE status IN ('FT', 'Finished', 'finished', 'Ended')
    AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
    ORDER BY id DESC LIMIT 500
    """
    rows = conn.execute(query).fetchall()
    conn.close()
    
    log_data = {}
    
    for row in rows:
        r = dict(row)
        league = r.get('league', 'Unknown')
        if league not in log_data:
            log_data[league] = []
            
        h_score, a_score = int(r.get('scoreHome', 0)), int(r.get('scoreAway', 0))
        act_winner = "H" if h_score > a_score else "A" if a_score > h_score else "D"
        
        # ML Predicted winner (based on probabilities saved in DB)
        prob_h = float(r.get('home_win_probability') or 33.3)
        prob_a = float(r.get('away_win_probability') or 33.3)
        pred_winner = "H" if prob_h > prob_a else "A"
        
        # Parse advanced variables
        news_data = r.get('news_data') or '{}'
        try:
            news = json.loads(news_data) if isinstance(news_data, str) else news_data
        except:
            news = {}
        
        # Did the public/odds heavily favor someone who lost? (Market Inefficiency check)
        # E.g., odds < 1.8 implies > 55% favorite. 
        odds_h = float(r.get('odds_home') or 0.0)
        odds_a = float(r.get('odds_away') or 0.0)
        
        misleading_vote = False
        gap_reason = "Normal"
        
        # Check if favorite lost
        if (odds_h > 0 and odds_h <= 1.85 and act_winner != "H"):
            misleading_vote = True
            gap_reason = "Favorite Home Underperformed (Tactic Shift or Motivation Drop)"
        elif (odds_a > 0 and odds_a <= 1.85 and act_winner != "A"):
            misleading_vote = True
            gap_reason = "Favorite Away Underperformed"
            
        # Check for Squad Rotation or Red Card (usually present in news/attribute overviews)
        squad_rot = float(news.get('squad_rotation', 0.0))
        tac_shift = float(news.get('tactical_shift', 0.0))
        if squad_rot != 0 or tac_shift != 0:
            if misleading_vote:
                gap_reason = f"Misleading Odds combined with Squad Rotation Effect ({squad_rot})"
        elif r.get('scoreHome') == 0 and r.get('scoreAway') == 0:
             # Just checking 0-0 bounds
             pass

        entry = {
            "matchId": r.get('id'),
            "title": f"{r.get('homeTeam')} vs {r.get('awayTeam')}",
            "actual_score": f"{h_score} - {a_score}",
            "ai_expected_score": r.get('expected_score', '?'),
            "vote_was_misleading": misleading_vote,
            "gap_analysis": gap_reason,
            "timestamp": str(datetime.datetime.now())
        }
        
        log_data[league].append(entry)

    # Only keep the most recent 10 logs per league to allow dynamic 15% sliding window learning
    for l in log_data:
        log_data[l] = log_data[l][:20]

    with open(ACCURACY_LOG_PATH, 'w', encoding='utf-8') as f:
        json.dump(log_data, f, indent=4)
        
    print(f"[SUCCESS] Gap Learning Analysis saved to {ACCURACY_LOG_PATH}")
    print(f"          Dynamically tracked {sum(len(v) for v in log_data.values())} history nodes.")
    print("          xgboost_predict.py will automatically read this to apply the -15% dynamic penalty.")

if __name__ == "__main__":
    analyze_gaps()
