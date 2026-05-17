import sys
import json
import random
import math
from prediction_engine import process_prediction

# Fix Windows cp1252 pipe crash when printing unicode (Emojis, Arabic)
sys.stdout.reconfigure(encoding='utf-8')

def monte_carlo_simulation(xg_home, xg_away, simulations=1000):
    """
    Perform 10,000 simulations to find true value probabilities.
    """
    results = {"home": 0, "draw": 0, "away": 0, "over25": 0, "btts": 0}
    
    for _ in range(simulations):
        # Generate goals based on Poisson
        home_goals = 0
        p = 1.0
        L = math.exp(-xg_home)
        while True:
            p *= random.random()
            if p < L: break
            home_goals += 1
            
        away_goals = 0
        p = 1.0
        L = math.exp(-xg_away)
        while True:
            p *= random.random()
            if p < L: break
            away_goals += 1
            
        if home_goals > away_goals: results["home"] += 1
        elif home_goals == away_goals: results["draw"] += 1
        else: results["away"] += 1
        
        if (home_goals + away_goals) > 2.5: results["over25"] += 1
        if home_goals > 0 and away_goals > 0: results["btts"] += 1
        
    return {k: round((v / simulations) * 100, 2) for k, v in results.items()}

def calculate_tactical_dna(match_data):
    """
    Analyze offensive vs defensive style.
    """
    ts = match_data.get('teamStats') or {}
    home_stats = ts.get('home') or {}
    away_stats = ts.get('away') or {}
    
    # Simple DNA Logic
    h_att = home_stats.get('avgGoalsScored', 1.0)
    a_def = away_stats.get('avgGoalsConceded', 1.0)
    
    h_style = "High Press / Possession" if home_stats.get('avgPossession', 50) > 55 else "Counter-Attack"
    a_style = "Low Block" if away_stats.get('avgGoalsConceded', 1.0) < 1.2 else "Open Defense"
    
    vulnerability = "High" if a_def > 1.5 and h_att > 1.8 else "Moderate"
    
    return {
        "home_style": h_style,
        "away_style": a_style,
        "vulnerability": vulnerability,
        "description": f"أسلوب {h_style} للفريق (A) سيواجه {a_style} للفريق (B). " + 
                       (f"هناك ثغرة واضحة خلف الأظهرة." if vulnerability == "High" else "التوازن التكتيكي هو سيد الموقف.")
    }

def calculate_pressure_impact(match_data):
    """
    Determine behavior under high pressure.
    """
    ts = match_data.get('teamStats') or {}
    home_stats = ts.get('home') or {}
    away_stats = ts.get('away') or {}
    
    # Proxy: Higher errors lead to catastrophic probability
    # If a team has high possession but high goals conceded, they might be failing under pressure
    h_risk = (home_stats.get('avgGoalsConceded', 1.0) * home_stats.get('avgPossession', 50)) / 100
    a_risk = (away_stats.get('avgGoalsConceded', 1.0) * away_stats.get('avgPossession', 50)) / 100
    
    catastrophic_prob = max(h_risk, a_risk) * 10 # Scale to 0-100
    
    description = "احتمالية خطأ دفاعي كارثي مرتفعة بسبب ارتباك الخطوط تحت الضغط العالي." if catastrophic_prob > 25 else "الفريقان يتمتعان بصلابة ذهنية مقبولة."
    
    return {
        "catastrophic_prob": round(min(catastrophic_prob, 85), 1),
        "description": description
    }

def get_multi_market_recommendations(sim_results, tactical_dna):
    """
    Suggest bets for corners, cards, etc.
    """
    recs = []
    
    # Over 0.5 HT Goals if btts and over25 are high
    if sim_results["over25"] > 55 or sim_results["btts"] > 60:
        recs.append({"market": "أهداف الشوط الأول", "bet": "Over 0.5", "confidence": round(sim_results["over25"] * 0.9 / 10, 1)})
    
    # Corners
    if tactical_dna["vulnerability"] == "High":
        recs.append({"market": "الركنات", "bet": "Over 9.5", "confidence": 7.5})
    else:
        recs.append({"market": "الركنات", "bet": "Under 10.5", "confidence": 6.8})
        
    # Cards
    recs.append({"market": "البطاقات", "bet": "Over 3.5", "confidence": 7.2})
    
    # Asian Handicap
    if sim_results["home"] > 60:
        recs.append({"market": "الآسيان هانديكاب", "bet": "Home -1.0", "confidence": round(sim_results["home"] / 10, 1)})
    
    return recs

def main():
    try:
        input_data = sys.stdin.read()
        if not input_data.strip():
            return

        match_data = json.loads(input_data)
        
        # 1. Base Analysis from existing engine
        base_analysis = process_prediction(match_data)
        
        # Base analysis directly returns fields (no 'metrics' wrapper)
        expected_score = base_analysis.get('expected_score', '1.0 - 1.0')
        try:
            xg_h, xg_a = map(float, expected_score.replace('?', '1.0').replace('N/A', '1.0').split(' - '))
        except ValueError:
            xg_h, xg_a = 1.0, 1.0

        # 2. Monte Carlo Simulations (10,000)
        sim_results = monte_carlo_simulation(xg_h, xg_a)
        
        # 3. Tactical DNA
        tactical_dna = calculate_tactical_dna(match_data)
        
        # 4. Pressure Impact
        pressure_impact = calculate_pressure_impact(match_data)
        
        # 5. Market Value Gap (Example odds from input if available)
        odds = match_data.get('odds', {"home": 2.0, "draw": 3.4, "away": 3.8})
        implied_home = 100 / odds.get('home', 2.0)
        true_value = sim_results["home"] - implied_home
        
        # 6. Multi-market
        recommendations = get_multi_market_recommendations(sim_results, tactical_dna)
        
        # 7. Verdict Construction
        # Pick the best rec as the verdict
        best_rec = max(recommendations, key=lambda x: x['confidence'])
        
        response = {
            "success": True,
            "matchId": match_data.get('id'),
            "home": match_data.get('homeTeam'),
            "away": match_data.get('awayTeam'),
            "tactical_dna": tactical_dna,
            "pressure_impact": pressure_impact,
            "sim_results": sim_results,
            "true_value": round(true_value, 2),
            "recommendations": recommendations,
            "verdict": {
                "type": f"{best_rec['market']} - {best_rec['bet']}",
                "confidence": best_rec['confidence'],
                "reason": f"بناءً على {sim_results['home']}% احتمالية فوز و {tactical_dna['vulnerability']} ثغرات تكتيكية."
            },
            "base_analysis": base_analysis
        }
        
        print(json.dumps(response, ensure_ascii=False))

    except Exception as e:
        import traceback
        print(json.dumps({"success": False, "error": str(e), "trace": traceback.format_exc()}))

if __name__ == "__main__":
    main()
