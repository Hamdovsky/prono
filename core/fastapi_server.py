from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
import sys
import os
import json
import numpy as np
import threading

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


# ─── FBref Endpoints ────────────────────────────────────────

@app.post("/fbref/odds")
async def fbref_odds(payload: dict):
    try:
        from fbref_service import get_odds
        home = payload.get('homeTeam', payload.get('home', ''))
        away = payload.get('awayTeam', payload.get('away', ''))
        league = payload.get('league', payload.get('tournament', ''))
        if not home or not away or not league:
            return {"success": False, "error": "Missing homeTeam, awayTeam, or league"}
        result = get_odds(home, away, league)
        if result:
            return {"success": True, **result}
        return {"success": False, "error": "Odds not found"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@app.post("/fbref/xg")
async def fbref_xg(payload: dict):
    try:
        from fbref_service import get_match_xg
        home = payload.get('homeTeam', payload.get('home', ''))
        away = payload.get('awayTeam', payload.get('away', ''))
        league = payload.get('league', payload.get('tournament', ''))
        if not home or not away or not league:
            return {"success": False, "error": "Missing homeTeam, awayTeam, or league"}
        result = get_match_xg(home, away, league)
        if result:
            return {"success": True, **result}
        return {"success": False, "error": "xG not found"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@app.post("/fbref/team-stats")
async def fbref_team_stats(payload: dict):
    try:
        from fbref_service import get_team_season_stats
        team = payload.get('team', '')
        league = payload.get('league', payload.get('tournament', ''))
        if not team or not league:
            return {"success": False, "error": "Missing team or league"}
        result = get_team_season_stats(team, league)
        if result:
            return {"success": True, **result}
        return {"success": False, "error": "Team stats not found"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@app.post("/fbref/schedule")
async def fbref_schedule(payload: dict):
    """Return the full schedule for a league (for debugging/bulk)."""
    try:
        from fbref_service import get_schedule
        league = payload.get('league', '')
        force = payload.get('force_refresh', False)
        if not league:
            return {"success": False, "error": "Missing league"}
        df = get_schedule(league, force)
        if df is not None and not df.empty:
            matches = df.reset_index().to_dict(orient='records')
            return {"success": True, "matches": matches[:50], "total": len(matches)}
        return {"success": False, "error": "No schedule data"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


class GoalModelFitRequest(BaseModel):
    leagues: list[str] = []
    matches_data: dict[str, list] = {}  # league -> list of match dicts
    callback_url: str = ''


def _fit_one_league(league, raw_matches, callback_url=None):
    """Run MLE for a single league (called in background thread)."""
    try:
        from goal_model import (_choose_distribution, fit_dixon_coles,
                                fit_rue_salvesen, fit_two_step, fit_base_poisson,
                                calculate_time_weights, save_cache, load_cache)
        from datetime import datetime
        import urllib.request

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
            print(f"[GOALMODEL] {league}: not enough matches ({len(matches)})")
            return

        match_days = [m['days_ago'] for m in matches]
        time_weights = calculate_time_weights(match_days)

        # Try two-step DC first (most stable), fallback to full DC, then RS
        result = fit_two_step(matches, time_weights, second_step='dc')
        if not result.get('success'):
            result = fit_dixon_coles(matches, time_weights)
        if not result.get('success'):
            result = fit_rue_salvesen(matches, time_weights)

        if result.get('success'):
            result['league'] = league
            result['updated_at'] = datetime.utcnow().timestamp()
            result['distribution_type'] = _choose_distribution(matches)
            cache = load_cache()
            cache[league] = result
            save_cache(cache)
            if 'rho' in result:
                print(f"[GOALMODEL] Fitted {league}: rho={result['rho']:.4f}, model={result.get('model','?')}")
            if 'gamma' in result:
                print(f"[GOALMODEL] Fitted {league}: gamma={result['gamma']:.4f}, model={result.get('model','?')}")
            _post_results_callback(callback_url, result)
        else:
            print(f"[GOALMODEL] {league}: fit failed: {result.get('error')}")
    except Exception as e:
        print(f"[GOALMODEL] {league}: error: {e}")


def _post_results_callback(url, result):
    """POST fitted parameters to main server for DB storage."""
    if not url:
        return
    try:
        import urllib.request
        import json
        payload = json.dumps({
            'league': result['league'],
            'mu': result.get('mu', 0.13),
            'hfa': result.get('hfa', 0.25),
            'rho': result.get('rho', -0.12),
            'gamma': result.get('gamma', 0.0),
            'model': result.get('model', 'poisson'),
            'distribution_type': result.get('distribution_type', 'poisson'),
            'num_matches': result.get('num_matches', 0),
            'teams': result.get('teams', []),
            'updated_at': result.get('updated_at'),
            'attack_ratings': result.get('attack', {}),
            'defense_ratings': result.get('defense', {}),
            'source': 'fastapi_goalmodel'
        }).encode()
        req = urllib.request.Request(url, data=payload, method='POST',
            headers={'Content-Type': 'application/json'})
        resp = urllib.request.urlopen(req, timeout=10)
        print(f"[GOALMODEL] Callback {url} → {resp.status}")
    except Exception as e:
        print(f"[GOALMODEL] Callback failed: {e}")


@app.post("/goalmodel/fit")
async def goalmodel_fit(req: GoalModelFitRequest, background_tasks: BackgroundTasks):
    try:
        leagues_to_fit = []
        if req.matches_data:
            leagues_to_fit = list(req.matches_data.keys())
        elif req.leagues:
            leagues_to_fit = req.leagues

        main_callback = req.callback_url or os.environ.get('MAIN_SERVER_CALLBACK', '')
        for league in leagues_to_fit:
            raw_matches = req.matches_data.get(league, [])
            if not raw_matches or len(raw_matches) < 10:
                continue
            background_tasks.add_task(_fit_one_league, league, raw_matches, main_callback)

        return {
            "success": True,
            "fitted": 0,
            "total": len(leagues_to_fit),
            "status": "started",
            "note": "Fitting running in background"
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@app.get("/health/neon")
async def health_neon():
    """Check Neon PostgreSQL connection and stats."""
    from pg_connector import query, using_postgres
    if not using_postgres():
        return {"success": False, "error": "Neon not configured (DATABASE_URL missing)"}
    tables = ['soccer_fixtures', 'soccer_match_stats', 'soccer_odds', 'soccer_teams', 'soccer_leagues', 'archive_football_data', 'league_model_parameters']
    stats = {}
    for t in tables:
        r = query(f"SELECT COUNT(*) as cnt FROM {t}")
        stats[t] = r[0]['cnt'] if r else 0
    return {"success": True, "using_neon": True, "stats": stats}

@app.get("/backtest")
async def backtest_endpoint(limit: int = 100, league: str = ""):
    """Run simplified backtest on historical Neon fixtures."""
    from pg_connector import query, using_postgres
    if not using_postgres():
        return {"success": False, "error": "Neon required"}
    sql = """
        SELECT f.home_team, f.away_team, f.goals_home, f.goals_away,
               f.odds_home, f.odds_away, f.odds_draw, l.name as league_name
        FROM soccer_fixtures f
        LEFT JOIN soccer_leagues l ON f.league_id = l.id
        WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL
          AND f.odds_home IS NOT NULL
    """
    params = []
    if league:
        sql += " AND LOWER(l.name) ILIKE %s"
        params.append(f'%{league}%')
    sql += " ORDER BY f.date DESC NULLS LAST LIMIT %s"
    params.append(limit)
    fixtures = query(sql, params) or []
    total = len(fixtures)
    correct = 0
    for f in fixtures:
        home_score = f.get('goals_home') or 0
        away_score = f.get('goals_away') or 0
        actual = 'H' if home_score > away_score else ('A' if home_score < away_score else 'D')
        odds_h = float(f.get('odds_home', 2.0))
        odds_a = float(f.get('odds_away', 2.0))
        odds_d = float(f.get('odds_draw', 3.0))
        imp_total = 1/odds_h + 1/odds_d + 1/odds_a
        pred = ['H', 'D', 'A'][max(enumerate([1/odds_h/imp_total, 1/odds_d/imp_total, 1/odds_a/imp_total]), key=lambda x: x[1])[0]]
        if pred == actual:
            correct += 1
    return {"success": True, "total": total, "correct": correct, "accuracy": round(correct/total, 4) if total > 0 else 0}
