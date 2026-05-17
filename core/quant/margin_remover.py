import math
import sys
import json
import argparse

def remove_margin_proportional(odds_list):
    """
    Supprime la marge du bookmaker proportionnellement à la probabilité impliquée.
    Méthode standard et rapide.
    """
    implied_probs = [1 / o if o > 0 else 0 for o in odds_list]
    margin = sum(implied_probs)
    
    if margin <= 1.0:
        return implied_probs # Pas de marge (Arbitrage) ou erreur
        
    true_probs = [p / margin for p in implied_probs]
    return true_probs

def remove_margin_shin(odds_list):
    """
    Méthode Shin (Hedge Fund Standard).
    Prend en compte le biais "Favorite-Longshot" (les bookmakers cachent plus de marge sur les outsiders).
    Requiert une optimisation itérative pour trouver Z (la proportion de parieurs 'sharps' dans le marché).
    Pour des raisons de rapidité en temps réel, nous utilisons une approximation robuste de Shin.
    """
    implied_probs = [1 / o if o > 0 else 0 for o in odds_list]
    margin = sum(implied_probs) - 1.0
    
    if margin <= 0:
        return implied_probs
        
    n = len(odds_list)
    # Approximation de Shin: ajustement non linéaire favorisant légèrement le favori
    true_probs = []
    for p in implied_probs:
        # Formule approchée de la littérature quant pour Shin
        # p_true = (sqrt(Z^2 + 4 * (1-Z) * p^2 / (margin+1)) - Z) / (2*(1-Z))
        # Pour faire simple en V1, on applique un ajustement logarithmique inverse proportionnel
        # qui simule le Favorite-Longshot Bias.
        true_probs.append(p) 
        
    # Appliquons l'algorithme itératif réel de Shin
    z = 0.0 # Proportion of insider trading
    step = 0.001
    best_z = 0
    min_diff = 1000
    
    for i in range(1, 100):
        current_z = i * step
        sum_p = 0
        temp_probs = []
        for p in implied_probs:
            term1 = current_z ** 2
            term2 = 4 * (1 - current_z) * ((p ** 2) / sum(implied_probs))
            if term1 + term2 >= 0:
                calc_p = (math.sqrt(term1 + term2) - current_z) / (2 * (1 - current_z))
                sum_p += calc_p
                temp_probs.append(calc_p)
            else:
                sum_p += p
                temp_probs.append(p)
                
        diff = abs(1.0 - sum_p)
        if diff < min_diff:
            min_diff = diff
            best_z = current_z
            true_probs = temp_probs
            
    # Normalize to exactly 1.0
    total = sum(true_probs)
    return [p / total for p in true_probs]

def process_odds(market_type, odds_dict, method='shin'):
    if market_type == '1X2':
        odds = [odds_dict.get('home', 0), odds_dict.get('draw', 0), odds_dict.get('away', 0)]
    elif market_type == 'OU':
        odds = [odds_dict.get('over', 0), odds_dict.get('under', 0)]
    elif market_type == 'BTTS':
        odds = [odds_dict.get('yes', 0), odds_dict.get('no', 0)]
    else:
        return []
        
    if any(o <= 1.0 for o in odds):
        return [] # Invalid odds
        
    if method == 'shin':
        return remove_margin_shin(odds)
    else:
        return remove_margin_proportional(odds)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Remove Bookmaker Margin')
    parser.add_argument('--market', type=str, required=True, help='Market type: 1X2, OU, BTTS')
    parser.add_argument('--odds', type=str, required=True, help='JSON string of odds e.g. {"home": 2.1, "draw": 3.4, "away": 3.2}')
    parser.add_argument('--method', type=str, default='shin', help='Margin removal method: shin or proportional')
    
    args = parser.parse_args()
    try:
        odds_dict = json.loads(args.odds)
        true_probs = process_odds(args.market, odds_dict, args.method)
        
        result = {}
        if args.market == '1X2':
            result = {'home': true_probs[0], 'draw': true_probs[1], 'away': true_probs[2]}
        elif args.market in ['OU', 'BTTS']:
            result = {'opt1': true_probs[0], 'opt2': true_probs[1]}
            
        print(json.dumps({"status": "success", "true_probabilities": result}))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
