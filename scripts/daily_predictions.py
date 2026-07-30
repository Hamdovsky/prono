"""
daily_predictions.py — Pipeline automatique de pronostics
Tourne chaque jour : fetch BSD -> enrich odds (fusion) -> V553 -> Top 10 -> sauvegarde
"""

import requests, datetime, os, sys, json, math, time, logging

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'core'))
sys.path.insert(0, os.path.join(BASE_DIR, 'services'))
sys.stdout.reconfigure(encoding='utf-8')

LOG_PATH = os.path.join(BASE_DIR, 'logs', 'daily_predictions.log')
os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)

logging.basicConfig(
    filename=LOG_PATH, level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)

# ── Penaltyblog lazy import ─────────────────────
_penaltyblog_engine = None
def get_penaltyblog_engine():
    global _penaltyblog_engine
    if _penaltyblog_engine is None:
        sys.path.insert(0, os.path.join(BASE_DIR, 'services'))
        from penaltyblog_engine import PenaltyblogEngine
        _penaltyblog_engine = PenaltyblogEngine()
    return _penaltyblog_engine

ENV_PATH = os.path.join(BASE_DIR, '.env')

def get_key(name):
    """Parse .env file with proper encoding and fallback."""
    try:
        with open(ENV_PATH, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith(f'{name}=') and not line.startswith('#'):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        logging.warning(f".env file not found at {ENV_PATH}")
    except Exception as e:
        logging.error(f"Error reading .env: {e}")
    return None

# ── OddsFusionEngine lazy import ─────────────────────────
_odds_engine = None
def get_odds_engine():
    global _odds_engine
    if _odds_engine is None:
        from oddsFusionEngine import OddsFusionEngine
        _odds_engine = OddsFusionEngine()
    return _odds_engine

# ── BSD fetch ──────────────────────────────────────────────

def fetch_bsd_events():
    BSD_KEY = get_key('BSD_API_KEY')
    if not BSD_KEY:
        logging.error("BSD_API_KEY not found")
        return []
    headers = {'Authorization': f'Token {BSD_KEY}'}
    
    all_events = []
    next_url = 'https://sports.bzzoiro.com/api/events/?sport=1&limit=200'
    while next_url:
        try:
            r = requests.get(next_url, headers=headers, timeout=30)
            data = r.json()
            all_events.extend(data.get('results', []))
            next_url = data.get('next')
        except Exception as ex:
            logging.error(f"BSD fetch error: {ex}")
            break
    return all_events

def get_todays_events(events):
    today = datetime.date.today().isoformat()
    return [e for e in events if e.get('event_date', '').startswith(today)]

def get_upcoming_events(events, days=3):
    today = datetime.date.today()
    result = []
    for e in events:
        ed = e.get('event_date', '')
        if not ed: continue
        try:
            d = datetime.datetime.fromisoformat(ed).date()
            if today <= d <= today + datetime.timedelta(days=days):
                result.append(e)
        except:
            pass
    return result

def enrich_with_odds(m):
    """Enrichir un event BSD avec les cotes via le moteur de fusion."""
    league = m.get('league', {}).get('name', 'Unknown')
    home = m.get('home_team', '?')
    away = m.get('away_team', '?')
    engine = get_odds_engine()
    # prefer_real=False pour avoir estimation historique sur les ligues sans cotes temps reel
    odds = engine.get_odds(home, away, league, prefer_real=False)
    m['odds_home'] = odds.get('home_win')
    m['odds_draw'] = odds.get('draw')
    m['odds_away'] = odds.get('away_win')
    m['odds_over_25'] = odds.get('over_25')
    m['odds_under_25'] = odds.get('under_25')
    m['odds_btts_yes'] = odds.get('btts_yes')
    m['odds_btts_no'] = odds.get('btts_no')
    m['odds_source'] = odds.get('source', 'default')
    return m

def build_match(m):
    league = m.get('league', {}).get('name', 'Unknown')
    home = m.get('home_team', '?')
    away = m.get('away_team', '?')
    ed = m.get('event_date', '')
    try:
        dt = datetime.datetime.fromisoformat(ed)
        timestamp = int(dt.timestamp())
    except:
        timestamp = 0
    
    return {
        'homeTeam': home,
        'awayTeam': away,
        'league': league,
        'startTimestamp': timestamp,
        'odds_home': m.get('odds_home') or 2.5,
        'odds_draw': m.get('odds_draw') or 3.2,
        'odds_away': m.get('odds_away') or 2.8,
        'odds_over_25': m.get('odds_over_25'),
        'odds_under_25': m.get('odds_under_25'),
        'odds_btts_yes': m.get('odds_btts_yes'),
        'odds_btts_no': m.get('odds_btts_no'),
        'odds_source': m.get('odds_source', 'default'),
        'event_date': ed,
        'has_real_odds': m.get('odds_source') in ('bsd', 'betexplorer', '888sport', 'unibet')
    }

def safe_float(v, default=0.0):
    try: return float(v) if v is not None else default
    except: return default

def compute_ou_btts(exp, xg_h=None, xg_a=None):
    if xg_h is not None and xg_a is not None and xg_h > 0 and xg_a > 0:
        pass
    else:
        try:
            xg_h = float(exp.split(' - ')[0]) if ' - ' in exp else 1.2
            xg_a = float(exp.split(' - ')[1]) if ' - ' in exp else 1.0
        except:
            xg_h, xg_a = 1.2, 1.0
    if xg_h < 0.3: xg_h = 0.5
    if xg_a < 0.3: xg_a = 0.5
    
    ou25 = 1.0
    for k in range(0, 3):
        for l in range(0, 3):
            if k + l <= 2:
                ou25 -= (math.exp(-xg_h) * xg_h**k / math.factorial(k)) * (math.exp(-xg_a) * xg_a**l / math.factorial(l))
    btts = (1 - math.exp(-xg_h)) * (1 - math.exp(-xg_a))
    return ou25 * 100, btts * 100

def run():
    print("=" * 60)
    print(f"DAILY PREDICTIONS - {datetime.date.today()}")
    print("=" * 60)
    
    # 1. Fetch events
    print("\n1. Fetching BSD events...")
    events = fetch_bsd_events()
    if not events:
        print("   ERROR: No events fetched")
        return
    
    print(f"   {len(events)} events fetched")
    upcoming = get_upcoming_events(events, days=3)
    if not upcoming:
        print("   No upcoming events in next 3 days")
        return
    
    print(f"   Next 3 days: {len(upcoming)}")
    
    # 2. Enrich matches with odds via fusion engine (batch)
    print(f"\n2. Enriching {len(upcoming)} matches with odds (fusion engine)...")
    # Pre-fetch BSD events for today to minimize API calls
    from oddsFusionEngine import OddsFusionEngine
    engine = OddsFusionEngine()
    today_bsd_events = None
    if engine.bsd_key:
        try:
            today = datetime.date.today().isoformat()
            hdrs = {'Authorization': f'Token {engine.bsd_key}'}
            r = requests.get(
                f'{engine.bsd_base}/events/?sport=1&date_from={today}&date_to={today}&limit=200',
                headers=hdrs, timeout=15
            )
            today_bsd_events = {f'{e.get("home_team","").lower().strip()}|{e.get("away_team","").lower().strip()}'
                                for e in r.json().get('results', [])}
        except: pass
    
    enriched = []
    for m in upcoming:
        # Check if BSD has this match
        ht = (m.get('home_team') or '').lower().strip()
        at = (m.get('away_team') or '').lower().strip()
        key = f'{ht}|{at}'
        league = m.get('league', {}).get('name', 'Unknown')
        
        if today_bsd_events and key in today_bsd_events:
            # BSD has real odds for this match
            odds = enrich_with_odds(m)
        else:
            # Skip BSD check, go straight to other tiers
            odds = engine.get_odds(ht, at, league, prefer_real=False)
            m['odds_home'] = odds.get('home_win')
            m['odds_draw'] = odds.get('draw')
            m['odds_away'] = odds.get('away_win')
            m['odds_over_25'] = odds.get('over_25')
            m['odds_under_25'] = odds.get('under_25')
            m['odds_btts_yes'] = odds.get('btts_yes')
            m['odds_btts_no'] = odds.get('btts_no')
            m['odds_source'] = odds.get('source', 'default')
        enriched.append(m)
    
    real_odds_count = sum(1 for m in enriched if m.get('odds_source') in ('bsd', 'betexplorer', '888sport', 'unibet'))
    estimated_count = sum(1 for m in enriched if m.get('odds_source') in ('historical+elo', 'historical'))
    default_count = sum(1 for m in enriched if m.get('odds_source') == 'default')
    print(f"   Real odds: {real_odds_count} | Estimated: {estimated_count} | Default: {default_count}")
    
    sources = {}
    for m in enriched:
        src = m.get('odds_source', 'unknown')
        sources[src] = sources.get(src, 0) + 1
    for src, cnt in sorted(sources.items()):
        print(f"     {src}: {cnt}")
    
    # Limit to 40 matches for performance (increased from 25)
    matches_to_predict = enriched[:40]
    
    # 3. Run V553 + Penaltyblog blended predictions
    print(f"\n3. Running V553 + Penaltyblog on {len(matches_to_predict)} matches...")
    from ml_features import get_team_history
    get_team_history.cache_clear()
    from predict_v553 import predict

    pb_engine = get_penaltyblog_engine()
    PB_WEIGHT = 0.35

    results = []
    errors = []
    for idx, m in enumerate(matches_to_predict):
        match = build_match(m)
        home_short = match['homeTeam'][:20]
        away_short = match['awayTeam'][:20]
        try:
            pred = predict(match)
            pb_pred = pb_engine.predict_match(match['homeTeam'], match['awayTeam'], match['league'])

            if pred and pred.get('prediction'):
                hp = safe_float(pred.get('home_win_prob', 0))
                dp = safe_float(pred.get('draw_prob', 0))
                ap = safe_float(pred.get('away_win_prob', 0))
                result = pred['prediction']
                conf = max(hp, dp, ap)
                exp = pred.get('expected_score', '1.2 - 1.0')
                xg_h = pred.get('home_xg')
                xg_a = pred.get('away_xg')

                if pb_pred and pb_pred.get('success'):
                    pb_h = pb_pred['home_win'] * 100
                    pb_d = pb_pred['draw'] * 100
                    pb_a = pb_pred['away_win'] * 100
                    pb_model = pb_pred.get('model', 'penaltyblog')
                    hp = hp * (1 - PB_WEIGHT) + pb_h * PB_WEIGHT
                    dp = dp * (1 - PB_WEIGHT) + pb_d * PB_WEIGHT
                    ap = ap * (1 - PB_WEIGHT) + pb_a * PB_WEIGHT
                    s = hp + dp + ap
                    if s > 0:
                        hp, dp, ap = hp / s * 100, dp / s * 100, ap / s * 100
                    conf = max(hp, dp, ap)
                    result = '1' if hp == conf else ('X' if dp == conf else '2')
                    pb_tag = f'+{pb_model}'
                else:
                    pb_tag = ''

                ou25, btts = compute_ou_btts(exp, xg_h, xg_a)

                if result == '1': odds = match['odds_home']; prob = hp
                elif result == 'X': odds = match['odds_draw']; prob = dp
                else: odds = match['odds_away']; prob = ap

                p = prob / 100.0
                ev = round(p * odds - (1 - p), 3)
                kelly = round(max(0, (p * odds - 1) / (odds - 1)), 3) if odds > 1 else 0

                h_hist = get_team_history(match['homeTeam'], limit=5)
                a_hist = get_team_history(match['awayTeam'], limit=5)

                results.append({
                    'date': match.get('event_date', '')[:10],
                    'time': match.get('event_date', '')[11:16],
                    'home': match['homeTeam'],
                    'away': match['awayTeam'],
                    'league': match['league'],
                    'prediction': result,
                    'confidence': round(conf, 1),
                    'home_prob': round(hp, 1),
                    'draw_prob': round(dp, 1),
                    'away_prob': round(ap, 1),
                    'odds_home': match['odds_home'],
                    'odds_draw': match['odds_draw'],
                    'odds_away': match['odds_away'],
                    'odds_source': match.get('odds_source', 'default'),
                    'expected_score': exp,
                    'home_xg': round(xg_h, 2) if xg_h else 0,
                    'away_xg': round(xg_a, 2) if xg_a else 0,
                    'ou25': round(ou25, 1),
                    'btts': round(btts, 1),
                    'ev': ev,
                    'kelly': kelly,
                    'has_real_odds': match['has_real_odds'],
                    'home_history': len(h_hist),
                    'away_history': len(a_hist),
                    'penaltyblog': bool(pb_tag),
                    'models': f'v553{pb_tag}'
                })
                tag_src = 'R' if match['has_real_odds'] else 'E'
                tag_pb = 'PB' if pb_tag else '  '
                print(f"   [{idx+1}/{len(matches_to_predict)}] [{tag_src}][{tag_pb}] {home_short:20} vs {away_short:20} | {result:4} | {conf:.0f}% | EV:{ev:.2f} | odds:{match['odds_source']}")
            else:
                print(f"   [{idx+1}/{len(matches_to_predict)}] {home_short:20} vs {away_short:20} | SKIP (no prediction)")
        except Exception as ex:
            error_msg = f"{match['homeTeam']} vs {match['awayTeam']}: {ex}"
            errors.append(error_msg)
            print(f"   [{idx+1}/{len(matches_to_predict)}] {home_short:20} vs {away_short:20} | ERROR: {ex}")
            logging.error(f"Prediction error: {error_msg}")
    
    if not results:
        print("\n   No predictions generated!")
        if errors:
            print(f"   {len(errors)} errors occurred (check log)")
        return
    
    # 4. Sort and save
    by_conf = sorted(results, key=lambda x: x['confidence'], reverse=True)
    by_ev = sorted([r for r in results if r['ev'] > 0], key=lambda x: x['ev'], reverse=True)
    
    pb_count = sum(1 for r in results if r.get('penaltyblog'))
    output = {
        'generated_at': datetime.datetime.now().isoformat(),
        'date': datetime.date.today().isoformat(),
        'total_matches': len(results),
        'total_errors': len(errors),
        'with_odds': sum(1 for r in results if r['has_real_odds']),
        'with_penaltyblog': pb_count,
        'odds_sources': dict((src, cnt) for src, cnt in sources.items()),
        'top_confidence': by_conf[:10],
        'top_value': by_ev[:10],
        'all': results,
        'errors': errors[:20]  # Keep last 20 errors for debugging
    }
    
    out_path = os.path.join(BASE_DIR, 'data', 'daily_predictions.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    # 5. Print summary
    print(f"\n{'='*60}")
    print(f"TOP 10 - CONFIANCE")
    print('='*60)
    for i, r in enumerate(by_conf[:10]):
        tag = 'R ' if r['has_real_odds'] else 'E '
        tag += 'WC' if 'World Cup' in r['league'] else '  '
        print(f"{i+1:2}. [{tag}] {r['prediction']} | {r['home']:20} vs {r['away']:20} | {r['confidence']:5.1f}% | EV:{r['ev']:.2f}")
    
    print(f"\n{'='*60}")
    print(f"TOP 10 - VALEUR (EV)")
    print('='*60)
    for i, r in enumerate(by_ev[:10]):
        tag = 'R ' if r['has_real_odds'] else 'E '
        print(f"{i+1:2}. [{tag}] {r['prediction']} | {r['home']:20} vs {r['away']:20} | EV:{r['ev']:.2f} | Kelly:{r['kelly']:.2f} | {r['confidence']:.0f}%")
    
    print(f"\nSauvegardé: {out_path}")
    print(f"Sources: {sources}")
    print(f"Penaltyblog: {pb_count}/{len(results)} matches blended")
    logging.info(f"Completed: {len(results)} predictions, {pb_count} with penaltyblog, {sum(1 for r in results if r['has_real_odds'])} with odds")
    return output

if __name__ == '__main__':
    run()
