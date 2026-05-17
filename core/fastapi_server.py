from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import sys
import os
import json
import numpy as np

# Add current dir to sys.path
sys.path.append(os.path.dirname(__file__))

app = FastAPI(title="Titanium Quant Inference API")

# Lazy load engines
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
        try:
            from player_props_engine import analyze_props
            _engines['props'] = analyze_props
        except ImportError:
            _engines['props'] = lambda x: {"error": "Props engine not implemented"}
    elif name == 'mega':
        try:
            from mega_correlation_engine import MegaCorrelationEngine
            _engines['mega'] = MegaCorrelationEngine()
        except ImportError:
            class Dummy:
                def process_match(self, x): return {"error": "Mega engine not implemented"}
            _engines['mega'] = Dummy()
    elif name == 'sentiment':
        try:
            from sentiment_engine import analyze_sentiment
            _engines['sentiment'] = analyze_sentiment
        except ImportError:
            _engines['sentiment'] = lambda x: {"error": "Sentiment engine not implemented", "score": 0, "subjectivity": 0}
    
    return _engines[name]

def clean_data(match_data: dict) -> dict:
    # Merge fullData if present
    full_data = match_data.get('fullData', {})
    if isinstance(full_data, str):
        try: 
            full_data = json.loads(full_data)
        except: 
            full_data = {}
    if isinstance(full_data, dict):
        for k, v in full_data.items():
            if k not in match_data: 
                match_data[k] = v
    return match_data

# Function to recursively convert numpy types to standard python types so FastAPI can JSONify it
def convert_numpy(obj):
    if isinstance(obj, np.integer): return int(obj)
    if isinstance(obj, np.floating): return float(obj)
    if isinstance(obj, np.ndarray): return obj.tolist()
    if isinstance(obj, np.bool_): return bool(obj)
    if isinstance(obj, dict):
        return {k: convert_numpy(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [convert_numpy(i) for i in obj]
    return obj

@app.post("/predict")
async def predict_endpoint(payload: dict):
    try:
        match_data = clean_data(payload)
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
                # Handle possible errors from dummy fallback
                if "error" in results[0]:
                    result = {"success": False, "error": results[0]["error"]}
                else:
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
            
        return convert_numpy(result)
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    import os
    
    # Paths to critical models
    model_paths = {
        'v24_hybrid': os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v24_hybrid.json'),
        'titanium_v2': os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'titanium_v2.json')
    }
    
    health_data = {
        "status": "healthy",
        "version": "3.5",
        "engines_loaded": {name: (engine is not None) for name, engine in _engines.items()},
        "models_on_disk": {name: os.path.exists(path) for name, path in model_paths.items()},
        "python_version": sys.version,
        "cwd": os.getcwd()
    }
    
    return health_data
