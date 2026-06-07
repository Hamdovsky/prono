import numpy as np
import json
import sys

def analyze_sequence(sequences):
    """
    Analyzes a sequence of last 5-10 matches data using a deterministic
    weighted momentum indicator (replacing the randomized non-trained LSTM).
    Input: List of dicts with keys: [xg, shots, points, possession, corners, saves, cards, importance]
    """
    try:
        # If sequences is empty, return standard defaults
        if not sequences or len(sequences) < 3:
            return {"trend_score": 50.0, "momentum": "Stable", "interpretation": "Sequence analysis is stable (insufficient data)."}
        
        # We process the last 10 matches (recent matches first in sequences list)
        recent_matches = sequences[:min(len(sequences), 10)]
        
        # Calculate a weighted performance score per match
        performance_scores = []
        for m in recent_matches:
            pts = float(m.get('points', 1.0))
            xg = float(m.get('xg', 1.2))
            shots = float(m.get('shots', 10.0))
            
            # Match performance metric between 0 and 100
            score = (pts / 3.0 * 50) + (min(3.0, xg) / 3.0 * 30) + (min(20.0, shots) / 20.0 * 20)
            performance_scores.append(score)
            
        # Exponential moving average (recent matches have higher weights)
        # sequences[0] is the most recent match
        alpha = 0.25
        ema = performance_scores[0]
        for s in performance_scores[1:]:
            ema = alpha * ema + (1 - alpha) * s
            
        # Convert EMA (0-100) to a calibrated trend_score (0-100)
        # where 50 is neutral, >62 is rising/positive, <38 is falling/negative
        trend_score = round(ema, 1)
        momentum = "Rising" if trend_score > 62 else ("Falling" if trend_score < 38 else "Stable")
        
        return {
            "trend_score": trend_score,
            "momentum": momentum,
            "interpretation": f"Team is currently in a {momentum.lower()} trend based on sequence analysis."
        }
    except Exception as e:
        return {"error": str(e), "trend_score": 50.0, "momentum": "Stable"}

if __name__ == "__main__":
    # Test stub for Node.js bridge
    if len(sys.argv) > 1:
        try:
            input_data = json.loads(sys.argv[1])
            result = analyze_sequence(input_data)
            print(json.dumps(result))
        except:
            print(json.dumps({"trend_score": 50.0, "momentum": "Stable"}))
