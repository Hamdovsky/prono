import sys
import json
import os
import traceback
import numpy as np

# Add current dir to sys.path
sys.path.append(os.path.dirname(__file__))

# Lazy loading containers
_engines = {
    'prediction': None,
    'props': None,
    'mega': None,
    'sentiment': None
}

def get_engine(name):
    if _engines[name] is not None:
        return _engines[name]
    
    if name == 'prediction':
        from prediction_engine import process_prediction
        _engines['prediction'] = process_prediction
    elif name == 'props':
        from player_props_engine import analyze_props
        _engines['props'] = analyze_props
    elif name == 'mega':
        from mega_correlation_engine import MegaCorrelationEngine
        _engines['mega'] = MegaCorrelationEngine()
    elif name == 'sentiment':
        # Sentiment is often the bottleneck due to textblob/nltk hangs
        from sentiment_engine import analyze_sentiment
        _engines['sentiment'] = analyze_sentiment
    
    return _engines[name]

class NpEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer): return int(obj)
        if isinstance(obj, np.floating): return float(obj)
        if isinstance(obj, np.ndarray): return obj.tolist()
        if isinstance(obj, np.bool_): return bool(obj)
        return super(NpEncoder, self).default(obj)

def service_loop():
    # Print READY immediately to unlock Node.js pool
    print("READY", flush=True)
    
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            match_data = json.loads(line)
            # Merge fullData if present
            full_data = match_data.get('fullData', {})
            if isinstance(full_data, str):
                try: full_data = json.loads(full_data)
                except: full_data = {}
            if isinstance(full_data, dict):
                for k, v in full_data.items():
                    if k not in match_data: match_data[k] = v

            task = match_data.get('task', 'PREDICTION')
            
            if task == 'PLAYER_PROPS':
                engine = get_engine('props')
                result = engine(match_data)
            elif task == 'MEGA_CORRELATION':
                engine = get_engine('mega')
                result = engine.process_match(match_data)
            elif task == 'SENTIMENT':
                engine = get_engine('sentiment')
                headlines = match_data.get('headlines', [])
                text = match_data.get('text', '')
                results = []
                if headlines:
                    for h in headlines:
                        results.append(engine(h))
                elif text:
                    results.append(engine(text))
                
                if results:
                    avg_score = sum(r['score'] for r in results) / len(results)
                    avg_subj = sum(r['subjectivity'] for r in results) / len(results)
                    final_label = "Neutral"
                    if avg_score >= 0.05: final_label = "Positive"
                    elif avg_score <= -0.05: final_label = "Negative"
                    result = {
                        "success": True,
                        "score": round(avg_score, 3),
                        "label": final_label,
                        "subjectivity": round(avg_subj, 3),
                        "lang": results[0].get('lang', 'En'),
                        "details": results
                    }
                else:
                    result = {"success": False, "error": "No text to analyze"}
            else:
                engine = get_engine('prediction')
                result = engine(match_data)
                
            print(json.dumps(result, cls=NpEncoder), flush=True)
        except Exception as e:
            # sys.stderr.write(f"Worker Error: {traceback.format_exc()}\n")
            print(json.dumps({"success": False, "error": str(e)}), flush=True)

if __name__ == "__main__":
    service_loop()
