import sqlite3
import json
import os
import datetime

DB_PATH = 'data/tactical.db'
ACCURACY_LOG_PATH = 'data/accuracy_log.json'

def run_audit():
    if not os.path.exists(DB_PATH):
        print(f"Error: {DB_PATH} not found")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    # Get finished matches that have predictions
    query = """
        SELECT id, homeTeam, awayTeam, league, scoreHome, scoreAway, 
               home_win_probability, draw_probability, away_win_probability,
               expected_score
        FROM matches
        WHERE LOWER(status) IN ('finished', 'ft', 'f')
          AND home_win_probability > 0
    """
    matches = conn.execute(query).fetchall()
    
    # Load existing logs
    logs = {}
    if os.path.exists(ACCURACY_LOG_PATH):
        try:
            with open(ACCURACY_LOG_PATH, 'r', encoding='utf-8') as f:
                logs = json.load(f)
        except: logs = {}

    audit_results = []
    
    for m in matches:
        h_prob = m['home_win_probability']
        d_prob = m['draw_probability']
        a_prob = m['away_win_probability']
        
        s_h = m['scoreHome']
        s_a = m['scoreAway']
        
        # Actual Result
        if s_h > s_a: actual = "home"
        elif s_h < s_a: actual = "away"
        else: actual = "draw"
        
        # Predicted Result (Highest Probability)
        probs = {"home": h_prob, "draw": d_prob, "away": a_prob}
        predicted = max(probs, key=probs.get)
        
        is_correct = (predicted == actual)
        
        # Logic for "vote_was_misleading" (Gap Learning)
        # If we had a high confidence (>60%) and it failed
        was_misleading = not is_correct and probs[predicted] > 60
        
        audit_entry = {
            "id": m['id'],
            "match": f"{m['homeTeam']} vs {m['awayTeam']}",
            "predicted": predicted,
            "actual": actual,
            "is_correct": is_correct,
            "vote_was_misleading": was_misleading,
            "timestamp": datetime.datetime.now().isoformat()
        }
        
        league = m['league'] or "Unknown"
        if league not in logs:
            logs[league] = []
            
        # Avoid duplicate entries
        if not any(e.get('id') == m['id'] for e in logs[league]):
            logs[league].append(audit_entry)
            # Keep only last 20 results per league for trend analysis
            logs[league] = logs[league][-20:]
            audit_results.append(audit_entry)

    # Save logs
    os.makedirs('data', exist_ok=True)
    with open(ACCURACY_LOG_PATH, 'w', encoding='utf-8') as f:
        json.dump(logs, f, indent=2)

    if not audit_results:
        print("Audit Complete. No new matches to process. [STABLE]")
        return

    correct_count = sum(1 for r in audit_results if r['is_correct'])
    acc = (correct_count / len(audit_results)) * 100
    
    # Simple Duel Thresholds
    print(f"--- V19 MODEL DUEL RESULTS ---")
    print(f"Batch Accuracy: {acc:.1f}%")
    
    if acc >= 75:
        print("Result: [IMPROVEMENT] - High accuracy threshold met.")
    elif acc >= 55:
        print("Result: [STABLE] - Performance within expected range.")
    else:
        print("Result: [REGRESSION] - Accuracy below safety threshold.")

    print(f"Processed {len(audit_results)} new entries.")

if __name__ == '__main__':
    run_audit()
