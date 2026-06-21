import sys, json
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'core'))
from prediction_engine import process_prediction

def print_match_report(m, result):
    pred = result.get('predictions', result)
    print("=" * 72)
    print(f"  MATCH: {m['homeTeam']} vs {m['awayTeam']}")
    print(f"  LEAGUE: {m['league']}")
    print("=" * 72)
    h = pred.get('home_win_prob', pred.get('home_win_probability', 0)) * 100
    d = pred.get('draw_prob', pred.get('draw_probability', 0)) * 100
    a = pred.get('away_win_prob', pred.get('away_win_probability', 0)) * 100
    print(f"  PROBABILITIES: Home {h:.1f}% | Draw {d:.1f}% | Away {a:.1f}%")
    print(f"  EXPECTED SCORE: {pred.get('expected_score', '? - ?')}")
    ou = pred.get('ou_2_5_probs', pred.get('ou_probs', {}))
    over = ou.get('over', 0) * 100 if isinstance(ou, dict) else 0
    print(f"  OVER 2.5 GOALS: {over:.1f}%")
    btts = pred.get('btts_prob', 0) * 100
    print(f"  BTTS: {btts:.1f}%")
    chaos = pred.get('chaos_score', 50)
    print(f"  CHAOS SCORE: {chaos}/100")
    print()
    print("  [SURGICAL INTELLIGENCE LAYER V47]")
    
    # MVR
    hm = float(m.get('home_market_value') or 0)
    am = float(m.get('away_market_value') or 0)
    if hm > 0 and am > 0:
        mvr = hm / am
        if mvr > 1.2:
            print(f"  +++ FINANCIAL ALPHA: {m['homeTeam']} squad worth {mvr:.1f}x more => Depth +Resilience boost")
        elif mvr < 0.8:
            print(f"  +++ FINANCIAL ALPHA: {m['awayTeam']} squad worth {(1/mvr):.1f}x more => Underdog Alert")
    
    # Absences
    news = m.get('news_intelligence', {})
    for side, team_name in [('home', m['homeTeam']), ('away', m['awayTeam'])]:
        feats = news.get(side, {}).get('intelligence', {}).get('features', {})
        if feats.get('is_missing_gk'):
            print(f"  !!! ABSENCE [GK]: {team_name} GOALKEEPER IS OUT => Defense -15%")
        if feats.get('is_missing_scorer'):
            print(f"  !!! ABSENCE [STRIKER]: {team_name} main scorer is out => Attack -15%")
        if feats.get('is_missing_star'):
            print(f"  !!! ABSENCE [STAR]: Key player out for {team_name}")
    
    # Pressure
    if m.get('is_high_pressure'):
        print("  >>> HIGH PRESSURE GAME: xG scaled down 8% (expect tactical battle)")
    
    # Referee
    ref_bias = float(m.get('referee_home_win_rate') or 0.45)
    if ref_bias > 0.52:
        print(f"  >>> REFEREE BIAS: Home-favored ref ({ref_bias:.0%} home win rate) => slight H advantage")
    elif ref_bias < 0.40:
        print(f"  >>> REFEREE BIAS: Strict/neutral ref => Away teams benefit")

    verdict = "HOME" if h > 45 and h > a else ("AWAY" if a > 45 and a > h else "DRAW")
    print(f"\n  [STITCH AI VERDICT]: {'==> ' + verdict + ' WIN <=='}")
    print()

if __name__ == "__main__":
    matches = [
        {
            "id": "demo_001",
            "homeTeam": "Al-Hilal", "awayTeam": "Al-Nassr",
            "league": "Saudi Pro League",
            "home_market_value": 242, "away_market_value": 182,
            "is_high_pressure": 1, "referee_home_win_rate": 0.58,
            "news_intelligence": {
                "home": {"intelligence": {"features": {"is_missing_gk": 0, "is_missing_scorer": 0}}},
                "away": {"intelligence": {"features": {"is_missing_gk": 1, "is_missing_star": 1}}}
            },
            "odds_home": 1.75, "odds_draw": 3.50, "odds_away": 4.20
        },
        {
            "id": "demo_002",
            "homeTeam": "Al Ahly", "awayTeam": "Zamalek",
            "league": "Egyptian Premier League",
            "home_market_value": 28, "away_market_value": 22,
            "is_high_pressure": 1, "referee_home_win_rate": 0.44,
            "news_intelligence": {
                "home": {"intelligence": {"features": {"is_missing_scorer": 0}}},
                "away": {"intelligence": {"features": {"is_missing_scorer": 1, "is_missing_star": 0}}}
            },
            "odds_home": 2.10, "odds_draw": 3.20, "odds_away": 3.40
        },
        {
            "id": "demo_003",
            "homeTeam": "Barcelona", "awayTeam": "Atletico Madrid",
            "league": "Spain - LaLiga",
            "home_market_value": 850, "away_market_value": 550,
            "is_high_pressure": 0, "referee_home_win_rate": 0.48,
            "news_intelligence": {
                "home": {"intelligence": {"features": {"is_missing_gk": 0}}},
                "away": {"intelligence": {"features": {"is_missing_gk": 0, "is_missing_scorer": 1}}}
            },
            "odds_home": 2.00, "odds_draw": 3.40, "odds_away": 3.60
        }
    ]
    
    print("\n")
    print("*" * 72)
    print("*" + " " * 22 + "STITCH AI ELITE - FINAL PROOF" + " " * 21 + "*")
    print("*" + " " * 20 + "VERSION MASTER (V45+V46+V47+V48)" + " " * 17 + "*")
    print("*" * 72)
    
    for m in matches:
        result = process_prediction(m)
        if result:
            print_match_report(m, result)
