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

@app.post("/predict-live")
async def predict_live_endpoint(payload: dict):
    try:
        from live_goal_predictor import predict_live
        result = predict_live(payload)
        return convert_numpy(result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"next5min": 0.5, "next10min": 0.6, "next15min": 0.7, "error": str(e)}

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


class GoalModelFitRequest(BaseModel):
    leagues: list[str] = []
    matches_data: dict[str, list] = {}  # league -> list of match dicts


@app.post("/goalmodel/fit")
async def goalmodel_fit(req: GoalModelFitRequest):
    try:
        from goal_model import _choose_distribution, fit_dixon_coles, calculate_time_weights
        from goal_model import save_cache, load_cache
        from datetime import datetime

        cache = load_cache()
        fitted_count = 0
        results = []

        leagues_to_fit = []
        if req.matches_data:
            leagues_to_fit = list(req.matches_data.keys())
        elif req.leagues:
            leagues_to_fit = req.leagues

        for league in leagues_to_fit:
            try:
                raw_matches = req.matches_data.get(league, [])
                if not raw_matches or len(raw_matches) < 10:
                    results.append({'league': league, 'error': 'Not enough matches (<10)'})
                    continue

                now = datetime.utcnow()
                matches = []
                for m in raw_matches:
                    ts_str = m.get('timestamp', '')
                    days_ago = 365
                    if ts_str:
                        try:
                            dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                            days_ago = max(0, (now - dt).days)
                        except Exception:
                            pass
                    matches.append({
                        'home': m.get('homeTeam', m.get('home', '')),
                        'away': m.get('awayTeam', m.get('away', '')),
                        'home_goals': int(m.get('scoreHome', m.get('home_goals', 0))),
                        'away_goals': int(m.get('scoreAway', m.get('away_goals', 0))),
                        'days_ago': days_ago
                    })

                if len(matches) < 10:
                    results.append({'league': league, 'error': 'Not enough matches after parsing'})
                    continue

                match_days = [m['days_ago'] for m in matches]
                time_weights = calculate_time_weights(match_days)
                result = fit_dixon_coles(matches, time_weights)

                if result.get('success'):
                    result['league'] = league
                    result['updated_at'] = datetime.utcnow().timestamp()
                    result['distribution_type'] = _choose_distribution(matches)
                    cache[league] = result
                    fitted_count += 1
                    results.append({'league': league, 'rho': result['rho'], 'dist': result['distribution_type']})
                else:
                    results.append({'league': league, 'error': result.get('error', 'Fit failed')})
            except Exception as e:
                results.append({'league': league, 'error': str(e)})

        save_cache(cache)
        return {
            "success": True,
            "fitted": fitted_count,
            "total": len(leagues_to_fit),
            "results": results
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}
