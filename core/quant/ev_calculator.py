import sys
import json
import argparse

def calculate_ev(true_prob, odds):
    """
    Calcule l'Expected Value (EV+)
    Formule: (True Probability * Decimal Odds) - 1
    Retourne l'EV en pourcentage (ex: 0.05 = 5% EV)
    """
    if true_prob <= 0 or odds <= 1.0:
        return 0.0
    return (true_prob * odds) - 1.0

def calculate_kelly_fraction(true_prob, odds, fraction=0.25):
    """
    Calcule le Fractional Kelly Criterion
    Formule: f* = (bp - q) / b
    Où: b = odds - 1 (profit net), p = true_prob, q = 1 - true_prob
    Retourne le % de bankroll à miser.
    """
    if true_prob <= 0 or odds <= 1.0:
        return 0.0
        
    b = odds - 1.0
    q = 1.0 - true_prob
    
    kelly_pct = ((b * true_prob) - q) / b
    
    if kelly_pct <= 0:
        return 0.0 # Pari EV- ou EV nul, on ne parie pas
        
    return kelly_pct * fraction

def analyze_market(ai_probs, market_odds, fraction=0.25, min_ev=0.0):
    """
    Analyse un marché complet (ex: 1X2) et retourne les paris validés EV+
    """
    results = []
    
    for outcome, ai_prob in ai_probs.items():
        odd = market_odds.get(outcome, 0)
        if odd <= 1.0 or ai_prob <= 0:
            continue
            
        ev = calculate_ev(ai_prob, odd)
        kelly = calculate_kelly_fraction(ai_prob, odd, fraction)
        
        if ev > min_ev and kelly > 0:
            results.append({
                "outcome": outcome,
                "ai_probability": ai_prob,
                "odds": odd,
                "expected_value": ev,
                "ev_percentage": round(ev * 100, 2),
                "kelly_stake_pct": round(kelly * 100, 2)
            })
            
    # Sort by highest EV
    results.sort(key=lambda x: x["expected_value"], reverse=True)
    return results

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='EV+ and Kelly Criterion Calculator')
    parser.add_argument('--ai_probs', type=str, required=True, help='JSON string of AI true probabilities e.g. {"home": 0.55, "draw": 0.25, "away": 0.20}')
    parser.add_argument('--odds', type=str, required=True, help='JSON string of market odds e.g. {"home": 2.1, "draw": 3.4, "away": 3.2}')
    parser.add_argument('--fraction', type=float, default=0.25, help='Kelly fraction (default 0.25 for quarter-Kelly)')
    parser.add_argument('--min_ev', type=float, default=0.02, help='Minimum EV threshold to validate a bet (default 0.02 = 2%)')
    
    args = parser.parse_args()
    try:
        ai_probs_dict = json.loads(args.ai_probs)
        odds_dict = json.loads(args.odds)
        
        results = analyze_market(ai_probs_dict, odds_dict, args.fraction, args.min_ev)
        
        print(json.dumps({
            "status": "success", 
            "validated_bets": results,
            "best_bet": results[0] if len(results) > 0 else None
        }))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
