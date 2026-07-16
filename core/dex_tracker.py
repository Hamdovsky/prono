"""
DEX & Prediction Markets Tracker
Monitors decentralized prediction markets (Polymarket, Azuro) and betting exchanges
for smart money flow signals. Compares with traditional bookmaker odds to detect
where professional bettors are placing money.
"""
import json
import os
import time
import urllib.request
import urllib.parse
import urllib.error
import re
from collections import defaultdict

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'dex_cache')
os.makedirs(CACHE_DIR, exist_ok=True)

_cache = {}
_cache_ttl = 600  # 10 minutes


def _fetch_url(url, timeout=10):
    """Simple HTTP GET without external dependencies."""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; TitaniumBot/1.0)',
            'Accept': 'application/json',
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        return None


def _normalize_team(name):
    """Normalize team name for fuzzy matching."""
    if not name:
        return ''
    name = name.lower().strip()
    # Remove common suffixes
    for suffix in [' fc', ' cf', ' ac', ' sc', ' cf', 'afc', ' fcf']:
        name = name.replace(suffix, '')
    # Common aliases
    aliases = {
        'manchester united': 'man utd', 'man city': 'manchester city',
        'tottenham': 'spurs', 'napoli': 'ssc napoli',
        'real madrid': 'real', 'barcelona': 'barca', 'barca': 'barcelona',
        'psg': 'paris saint-germain', 'bayern': 'bayern munich',
        'inter': 'inter milan', 'ac milan': 'milan',
        'atletico': 'atletico madrid', 'atletico de madrid': 'atletico madrid',
        'juve': 'juventus', 'juventus': 'juventus',
    }
    for k, v in aliases.items():
        if k in name:
            return v
    return name


def _fuzzy_match(team1, team2):
    """Check if two team names refer to the same team."""
    t1 = _normalize_team(team1)
    t2 = _normalize_team(team2)
    if not t1 or not t2:
        return False
    if t1 == t2:
        return True
    if t1 in t2 or t2 in t1:
        return True
    return False


def fetch_polymarket_markets(query='football', limit=50):
    """
    Fetch football/soccer markets from Polymarket (public API).
    Returns list of {question, home_team, away_team, yes_price, no_price, volume, liquidity}.
    """
    cache_key = f"polymarket:{query}:{limit}"
    if cache_key in _cache and (time.time() - _cache[cache_key]['ts']) < _cache_ttl:
        return _cache[cache_key]['data']

    markets = []
    try:
        # Polymarket Gamma API (public, no auth needed)
        url = f"https://gamma-api.polymarket.com/markets?closed=false&limit={limit}&tag={urllib.parse.quote(query)}"
        data = _fetch_url(url, timeout=15)
        
        if data and isinstance(data, list):
            for m in data:
                question = m.get('question', '')
                if not any(kw in question.lower() for kw in ['win', 'score', 'goal', 'match', 'vs', 'versus']):
                    continue
                
                # Parse teams from question
                # Common formats: "Will Team A beat Team B?" or "Team A vs Team B"
                teams = None
                for sep in [' vs ', ' versus ', ' beat ', ' defeat ']:
                    if sep in question.lower():
                        parts = re.split(re.escape(sep), question, flags=re.IGNORECASE)
                        if len(parts) == 2:
                            teams = (parts[0].strip(), parts[1].strip().rstrip('?'))
                            break
                
                if not teams:
                    continue
                
                # Get prices
                outcomes = m.get('outcomes', [])
                outcome_prices = m.get('outcomePrices', [])
                volume = float(m.get('volume', 0) or 0)
                liquidity = float(m.get('liquidity', 0) or 0)
                
                if len(outcome_prices) >= 2:
                    try:
                        prices = json.loads(outcome_prices) if isinstance(outcome_prices, str) else outcome_prices
                        markets.append({
                            'source': 'polymarket',
                            'home_team': teams[0],
                            'away_team': teams[1],
                            'question': question,
                            'yes_price': float(prices[0]),
                            'no_price': float(prices[1]) if len(prices) > 1 else 1 - float(prices[0]),
                            'volume': volume,
                            'liquidity': liquidity,
                            'url': m.get('url', ''),
                        })
                    except (ValueError, TypeError):
                        continue
    except Exception:
        pass

    _cache[cache_key] = {'data': markets, 'ts': time.time()}
    return markets


def fetch_azuro_markets(limit=50):
    """
    Fetch from Azuro protocol (decentralized football prediction market on Polygon).
    """
    cache_key = f"azuro:{limit}"
    if cache_key in _cache and (time.time() - _cache[cache_key]['ts']) < _cache_ttl:
        return _cache[cache_key]['data']

    markets = []
    try:
        # Azuro GraphQL API
        url = "https://thegraph.azuro.org/subgraphs/name/azuro-org/azuro-v2-polygon"
        query = json.dumps({
            "query": """
            {
              events(first: %d, orderBy: startsAt, orderDirection: asc, where: {startsAt_gt: "%d"}) {
                id
                startsAt
                game {
                  league { name country { name } }
                  homeTeam { name }
                  awayTeam { name }
                }
                outcomes { odds }
              }
            }
            """ % (limit, int(time.time()))
        }).encode('utf-8')
        
        req = urllib.request.Request(url, data=query, headers={
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        
        events = data.get('data', {}).get('events', [])
        for ev in events:
            game = ev.get('game', {})
            home = game.get('homeTeam', {}).get('name', '')
            away = game.get('awayTeam', {}).get('name', '')
            if not home or not away:
                continue
            
            outcomes = ev.get('outcomes', [])
            if len(outcomes) >= 3:
                markets.append({
                    'source': 'azuro',
                    'home_team': home,
                    'away_team': away,
                    'league': game.get('league', {}).get('name', ''),
                    'yes_price': float(outcomes[0].get('odds', 0) or 0),
                    'draw_price': float(outcomes[1].get('odds', 0) or 0),
                    'no_price': float(outcomes[2].get('odds', 0) or 0),
                    'volume': 0,
                    'liquidity': 0,
                })
    except Exception:
        pass

    _cache[cache_key] = {'data': markets, 'ts': time.time()}
    return markets


def compute_dex_signals(home_team, away_team, odds_home=None, odds_draw=None, odds_away=None):
    """
    Main entry: compute DEX/prediction market signals for a match.
    Returns dict of features comparing traditional odds vs decentralized market prices.
    """
    features = {
        'dex_smart_money_signal': 0.0,      # Positive = money on home, negative = money on away
        'dex_market_confidence': 0.0,        # How much volume is on this match
        'dex_price_divergence_h': 0.0,       # DEX price vs bookmaker price (home)
        'dex_price_divergence_a': 0.0,       # DEX price vs bookmaker price (away)
        'dex_volume_ratio': 0.0,             # DEX liquidity relative to average
        'dex_has_data': 0,                   # Whether we found DEX data
    }
    
    try:
        # Fetch from both sources
        poly_markets = fetch_polymarket_markets(limit=50)
        azuro_markets = fetch_azuro_markets(limit=50)
        all_markets = poly_markets + azuro_markets
        
        if not all_markets:
            return features
        
        # Find matching market
        best_match = None
        best_score = 0
        
        for m in all_markets:
            score = 0
            if _fuzzy_match(m['home_team'], home_team):
                score += 2
            if _fuzzy_match(m['away_team'], away_team):
                score += 2
            if _fuzzy_match(m['home_team'], away_team):
                score -= 1  # Reversed teams = lower score
            if _fuzzy_match(m['away_team'], home_team):
                score -= 1
            
            if score > best_score:
                best_score = score
                best_match = m
        
        if best_match and best_score >= 3:
            features['dex_has_data'] = 1
            
            # Smart money signal: if DEX home price > bookmaker home price, money favors home
            if odds_home and best_match.get('yes_price'):
                # Convert odds to implied probability
                book_home_prob = 1.0 / odds_home if odds_home > 0 else 0.33
                dex_home_prob = best_match['yes_price']
                features['dex_price_divergence_h'] = round(dex_home_prob - book_home_prob, 4)
                features['dex_smart_money_signal'] = round(dex_home_prob - book_home_prob, 4)
            
            if odds_away and best_match.get('no_price'):
                book_away_prob = 1.0 / odds_away if odds_away > 0 else 0.33
                dex_away_prob = best_match['no_price']
                features['dex_price_divergence_a'] = round(dex_away_prob - book_away_prob, 4)
                # If both diverge toward home: strong home signal
                if features['dex_price_divergence_h'] > 0.05 and features['dex_price_divergence_a'] < -0.05:
                    features['dex_smart_money_signal'] = round(features['dex_price_divergence_h'] + abs(features['dex_price_divergence_a']), 4)
            
            # Volume / liquidity confidence
            vol = best_match.get('volume', 0) or 0
            liq = best_match.get('liquidity', 0) or 0
            total_interest = vol + liq
            if total_interest > 100000:
                features['dex_market_confidence'] = 0.8
            elif total_interest > 10000:
                features['dex_market_confidence'] = 0.5
            elif total_interest > 1000:
                features['dex_market_confidence'] = 0.3
            else:
                features['dex_market_confidence'] = 0.1
            
            features['dex_volume_ratio'] = round(min(total_interest / 50000, 1.0), 3)
    
    except Exception:
        pass
    
    return features


DEX_FEATURE_NAMES = [
    'dex_smart_money_signal',
    'dex_market_confidence',
    'dex_price_divergence_h',
    'dex_price_divergence_a',
    'dex_volume_ratio',
    'dex_has_data',
]


if __name__ == '__main__':
    # Test
    result = compute_dex_signals('Liverpool', 'Arsenal', odds_home=1.8, odds_draw=3.5, odds_away=4.0)
    print(json.dumps(result, indent=2))
