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

ENV_PATH = os.path.join(BASE_DIR, '.env')

def get_key(name):
    with open(ENV_PATH, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line.startswith(f'{name}='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
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

def compute_ou_btts(exp):
    try:
        xg_h = float(exp.split(' - ')[0]) if ' - ' in exp else 1.2
        xg_a = float(exp.split(' - ')[1]) if ' - ' in exp else 1.0
    except:
        xg_h, xg_a = 1.2, 1.0
    if xg_h < 0.3: xg_h = 1.2
    if xg_a < 0.3: xg_a = 1.0
    
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
    
    # Limit to 25 matches for performance
    matches_to_predict = enriched[:25]
    
    # 3. Run V553
    print(f"\n3. Running V553 predictions on {len(matches_to_predict)} matches...")
    from ml_features import get_team_history
    get_team_history.cache_clear()
    from predict_v553 import predict
    
    results = []
    for m in matches_to_predict:
        match = build_match(m)
        try:
            pred = predict(match)
            if pred and pred.get('prediction'):
                hp = safe_float(pred.get('home_win_prob', 0))
                dp = safe_float(pred.get('draw_prob', 0))
                ap = safe_float(pred.get('away_win_prob', 0))
                result = pred['prediction']
                conf = max(hp, dp, ap)
                exp = pred.get('expected_score', '1.2 - 1.0')
                
                ou25, btts = compute_ou_btts(exp)
                
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
                    'ou25': round(ou25, 1),
                    'btts': round(btts, 1),
                    'ev': ev,
                    'kelly': kelly,
                    'has_real_odds': match['has_real_odds'],
                    'home_history': len(h_hist),
                    'away_history': len(a_hist)
                })
                tag_src = 'R' if match['has_real_odds'] else 'E'
                print(f"   [{tag_src}] {match['homeTeam']:22} vs {match['awayTeam']:22} | {result:4} | {conf:.0f}% | EV:{ev:.2f} | odds:{match['odds_source']}")
                time.sleep(0.1)
            else:
                print(f"   {match['homeTeam']:22} vs {match['awayTeam']:22} | SKIP")
        except Exception as ex:
            print(f"   {match['homeTeam']:22} vs {match['awayTeam']:22} | ERROR: {ex}")
            logging.error(f"Prediction error {match['homeTeam']} vs {match['awayTeam']}: {ex}")
    
    if not results:
        print("\n   No predictions generated!")
        return
    
    # 4. Sort and save
    by_conf = sorted(results, key=lambda x: x['confidence'], reverse=True)
    by_ev = sorted([r for r in results if r['ev'] > 0], key=lambda x: x['ev'], reverse=True)
    
    output = {
        'generated_at': datetime.datetime.now().isoformat(),
        'date': datetime.date.today().isoformat(),
        'total_matches': len(results),
        'with_odds': sum(1 for r in results if r['has_real_odds']),
        'odds_sources': dict((src, cnt) for src, cnt in sources.items()),
        'top_confidence': by_conf[:10],
        'top_value': by_ev[:10],
        'all': results
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
    logging.info(f"Completed: {len(results)} predictions, {sum(1 for r in results if r['has_real_odds'])} with odds")
    return output

if __name__ == '__main__':
    run()
