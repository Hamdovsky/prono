from fastapi import FastAPI, HTTPException, BackgroundTasks, Query, Header, Depends
from pydantic import BaseModel
import sys, os, json, subprocess, numpy as np, threading, math

sys.path.append(os.path.dirname(__file__))

app = FastAPI(title="Titanium Quant Inference API")

# ── Auth dependency ──
async def require_auth(authorization: str = Header(None)):
    secret = os.environ.get('API_SECRET_KEY', '')
    if not secret:
        return
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401, "Unauthorized: Missing or malformed token")
    if authorization.split(' ')[1] != secret:
        raise HTTPException(401, "Unauthorized: Invalid token")

async def optional_auth(authorization: str = Header(None)):
    secret = os.environ.get('API_SECRET_KEY', '')
    if not secret or not authorization:
        return
    if authorization.startswith('Bearer ') and authorization.split(' ')[1] != secret:
        raise HTTPException(401, "Unauthorized: Invalid token")

# ── Lazy load engines ──
_engines = {'prediction': None, 'props': None, 'mega': None, 'sentiment': None}

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

# ── Prometheus metrics ──
try:
    from prometheus_fastapi_instrumentator import Instrumentator
    Instrumentator().instrument(app).expose(app)
except ImportError:
    @app.get("/metrics")
    async def metrics_fallback():
        return {"success": False, "error": "prometheus_fastapi_instrumentator not installed; install with: pip install prometheus-fastapi-instrumentator"}

# ── Endpoints ──
@app.get("/health")
async def health_check():
    model_paths = {
        'v24_hybrid': os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v24_hybrid.json'),
        'titanium_v2': os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'titanium_v2.json')
    }
    return {
        "status": "healthy",
        "version": "3.6",
        "engines_loaded": {name: (engine is not None) for name, engine in _engines.items()},
        "models_on_disk": {name: os.path.exists(path) for name, path in model_paths.items()},
        "python_version": sys.version,
        "cwd": os.getcwd()
    }

@app.post("/predict")
async def predict_endpoint(payload: dict, _=Depends(optional_auth)):
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
                if "error" in results[0]:
                    result = {"success": False, "error": results[0]["error"]}
                else:
                    avg_score = sum(r['score'] for r in results) / len(results)
                    avg_subj = sum(r['subjectivity'] for r in results) / len(results)
                    final_label = "Neutral"
                    if avg_score >= 0.05: final_label = "Positive"
                    elif avg_score <= -0.05: final_label = "Negative"
                    result = {"success": True, "score": round(avg_score, 3), "label": final_label, "subjectivity": round(avg_subj, 3), "lang": results[0].get('lang', 'En'), "details": results}
            else:
                result = {"success": False, "error": "No text to analyze"}
        else:
            engine = get_engine('prediction')
            result = engine(match_data)
        return convert_numpy(result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, detail=str(e))

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
    matches_data: dict[str, list] = {}
    callback_url: str = ''

def _fit_one_league(league, raw_matches, callback_url=None):
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
            matches.append({'home': m.get('homeTeam', m.get('home', '')), 'away': m.get('awayTeam', m.get('away', '')), 'home_goals': int(m.get('scoreHome', m.get('home_goals', 0))), 'away_goals': int(m.get('scoreAway', m.get('away_goals', 0))), 'days_ago': days_ago})
        if len(matches) < 10:
            print(f"[GOALMODEL] {league}: not enough matches ({len(matches)})")
            return
        match_days = [m['days_ago'] for m in matches]
        time_weights = calculate_time_weights(match_days)
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
            print(f"[GOALMODEL] Fitted {league}: rho={result.get('rho',0):.4f} model={result.get('model','?')}")
            _post_results_callback(callback_url, result)
        else:
            print(f"[GOALMODEL] {league}: fit failed: {result.get('error')}")
    except Exception as e:
        print(f"[GOALMODEL] {league}: error: {e}")

def _post_results_callback(url, result):
    if not url:
        return
    try:
        import urllib.request
        payload = json.dumps({'league': result['league'], 'mu': result.get('mu', 0.13), 'hfa': result.get('hfa', 0.25), 'rho': result.get('rho', -0.12), 'gamma': result.get('gamma', 0.0), 'model': result.get('model', 'poisson'), 'distribution_type': result.get('distribution_type', 'poisson'), 'num_matches': result.get('num_matches', 0), 'teams': result.get('teams', []), 'updated_at': result.get('updated_at'), 'attack_ratings': result.get('attack', {}), 'defense_ratings': result.get('defense', {}), 'source': 'fastapi_goalmodel'}).encode()
        req = urllib.request.Request(url, data=payload, method='POST', headers={'Content-Type': 'application/json'})
        resp = urllib.request.urlopen(req, timeout=10)
        print(f"[GOALMODEL] Callback {url} -> {resp.status}")
    except Exception as e:
        print(f"[GOALMODEL] Callback failed: {e}")

@app.post("/goalmodel/fit")
async def goalmodel_fit(req: GoalModelFitRequest, background_tasks: BackgroundTasks):
    try:
        leagues_to_fit = list(req.matches_data.keys()) if req.matches_data else req.leagues
        main_callback = req.callback_url or os.environ.get('MAIN_SERVER_CALLBACK', '')
        for league in leagues_to_fit:
            raw_matches = req.matches_data.get(league, [])
            if not raw_matches or len(raw_matches) < 10:
                continue
            background_tasks.add_task(_fit_one_league, league, raw_matches, main_callback)
        return {"success": True, "fitted": 0, "total": len(leagues_to_fit), "status": "started", "note": "Fitting running in background"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@app.get("/health/neon")
async def health_neon():
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
async def backtest_endpoint(limit: int = Query(100, le=5000), league: str = ""):
    from pg_connector import query, using_postgres
    if not using_postgres():
        return {"success": False, "error": "Neon required"}
    sql = """SELECT f.home_team, f.away_team, f.score_home, f.score_away,
               f.odds_home, f.odds_away, f.odds_draw, f.league_code as league_name
            FROM archive_football_data f
            WHERE f.score_home IS NOT NULL AND f.score_away IS NOT NULL
              AND f.odds_home IS NOT NULL"""
    params = []
    if league:
        sql += " AND LOWER(f.league_code) ILIKE %s"
        params.append(f'%{league}%')
    sql += " ORDER BY f.match_date DESC NULLS LAST LIMIT %s"
    params.append(limit)
    fixtures = query(sql, params) or []
    total = len(fixtures)
    correct = 0
    brier_sum = 0.0
    logloss_sum = 0.0
    eps = 1e-7
    for f in fixtures:
        home_score = f.get('score_home') or 0
        away_score = f.get('score_away') or 0
        actual = 'H' if home_score > away_score else ('A' if home_score < away_score else 'D')
        odds_h = float(f.get('odds_home', 2.0))
        odds_a = float(f.get('odds_away', 2.0))
        odds_d = float(f.get('odds_draw', 3.0))
        imp_total = 1/odds_h + 1/odds_d + 1/odds_a
        p_h, p_d, p_a = (1/odds_h)/imp_total, (1/odds_d)/imp_total, (1/odds_a)/imp_total
        pred = ['H', 'D', 'A'][max(enumerate([p_h, p_d, p_a]), key=lambda x: x[1])[0]]
        if pred == actual:
            correct += 1
        actual_vec = [1, 0, 0] if actual == 'H' else ([0, 1, 0] if actual == 'D' else [0, 0, 1])
        pred_vec = [p_h, p_d, p_a]
        brier_sum += sum((a - p)**2 for a, p in zip(actual_vec, pred_vec))
        logloss_sum += -sum(a * math.log(max(p, eps)) for a, p in zip(actual_vec, pred_vec))
    accuracy = round(correct/total, 4) if total > 0 else 0
    return {"success": True, "total": total, "correct": correct, "accuracy": accuracy,
            "brier_score": round(brier_sum/total, 4) if total > 0 else 0,
            "log_loss": round(logloss_sum/total, 4) if total > 0 else 0}

@app.get("/backtest/trend")
async def backtest_trend_endpoint(league: str = ""):
    from pg_connector import query, using_postgres
    if not using_postgres():
        return {"success": False, "error": "Neon required"}
    sql = """SELECT f.odds_home, f.odds_away, f.odds_draw, f.score_home, f.score_away,
                    TO_CHAR(f.match_date, 'YYYY-MM') as month
             FROM archive_football_data f
             WHERE f.score_home IS NOT NULL AND f.score_away IS NOT NULL
               AND f.odds_home IS NOT NULL AND f.odds_draw IS NOT NULL AND f.odds_away IS NOT NULL"""
    params = []
    if league:
        sql += " AND LOWER(f.league_code) ILIKE %s"
        params.append(f'%{league}%')
    sql += " ORDER BY f.match_date ASC"
    fixtures = query(sql, params) or []
    monthly = {}
    for f in fixtures:
        month = f.get('month', 'unknown')
        if month not in monthly:
            monthly[month] = {'total': 0, 'correct': 0}
        monthly[month]['total'] += 1
        home_score = f.get('score_home') or 0
        away_score = f.get('score_away') or 0
        actual = 'H' if home_score > away_score else ('A' if home_score < away_score else 'D')
        odds_h = float(f.get('odds_home', 2.0))
        odds_a = float(f.get('odds_away', 2.0))
        odds_d = float(f.get('odds_draw', 3.0))
        imp_total = 1/odds_h + 1/odds_d + 1/odds_a
        p_h, p_d, p_a = (1/odds_h)/imp_total, (1/odds_d)/imp_total, (1/odds_a)/imp_total
        pred = ['H', 'D', 'A'][max(enumerate([p_h, p_d, p_a]), key=lambda x: x[1])[0]]
        if pred == actual:
            monthly[month]['correct'] += 1
    trend = [{"month": m, "total": d["total"], "accuracy": round(d["correct"]/d["total"], 4)} for m, d in sorted(monthly.items()) if d["total"] >= 50]
    return {"success": True, "trend": trend, "total_months": len(trend)}

@app.post("/calibrate")
async def calibrate_endpoint(league: str = Query("", description="Optional league filter for per-league calibration"), _=Depends(require_auth)):
    from pg_connector import query, using_postgres
    from calibration import fit_calibration, load_calibration
    if not using_postgres():
        return {"success": False, "error": "Neon required"}
    try:
        sql = """SELECT f.score_home, f.score_away, f.odds_home, f.odds_draw, f.odds_away
                 FROM archive_football_data f
                 WHERE f.score_home IS NOT NULL AND f.score_away IS NOT NULL
                   AND f.odds_home IS NOT NULL AND f.odds_draw IS NOT NULL AND f.odds_away IS NOT NULL"""
        params = []
        if league:
            sql += " AND LOWER(f.league_code) ILIKE %s"
            params.append(f'%{league}%')
        sql += " ORDER BY f.match_date DESC NULLS LAST LIMIT 50000"
        result = query(sql, params)
        if not result or len(result) < 100:
            return {"success": False, "error": f"Only {len(result) if result else 0} fixtures, need >=100"}
        home_probs, draw_probs, away_probs, outcomes = [], [], [], []
        for f in result:
            imp_h, imp_d, imp_a = 1/float(f['odds_home']), 1/float(f['odds_draw']), 1/float(f['odds_away'])
            margin = imp_h + imp_d + imp_a
            home_probs.append(imp_h/margin)
            draw_probs.append(imp_d/margin)
            away_probs.append(imp_a/margin)
            hs, aws = int(f['score_home']), int(f['score_away'])
            outcomes.append('H' if hs > aws else ('A' if hs < aws else 'D'))
        params = fit_calibration(home_probs, draw_probs, away_probs, outcomes)
        return {"success": True, "params": params, "samples": len(result), "league": league or "all"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@app.post("/retrain")
async def retrain_endpoint(_=Depends(require_auth)):
    try:
        script = os.path.join(os.path.dirname(__file__), '..', 'scripts', 'auto_retrain.py')
        if not os.path.exists(script):
            return {"success": False, "error": "auto_retrain.py not found"}
        def _run():
            subprocess.run([sys.executable, script, '--validate-only'], capture_output=True, timeout=600)
        threading.Thread(target=_run, daemon=True).start()
        return {"success": True, "message": "Retrain started in background"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/warmup")
async def warmup():
    engines_to_prewarm = ['prediction']
    results = {}
    for name in engines_to_prewarm:
        try:
            engine = get_engine(name)
            results[name] = "loaded" if engine is not None else "failed"
        except Exception as e:
            results[name] = str(e)
    return {"success": True, "warmed": results}
