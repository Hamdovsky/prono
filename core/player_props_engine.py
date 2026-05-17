import sys
import json
import math

def poisson_pmf(k, lam):
    """Probability Mass Function: P(X=k) = (lam^k * e^-lam) / k!"""
    if lam <= 0: return 1.0 if k == 0 else 0.0
    return (math.pow(lam, k) * math.exp(-lam)) / math.factorial(k)

def poisson_cdf(k, lam):
    """Cumulative Distribution Function: P(X<=k) = sum_{i=0}^k PMF(i, lam)"""
    if lam <= 0: return 1.0
    prob = 0
    for i in range(int(k) + 1):
        prob += poisson_pmf(i, lam)
    return prob

def get_poisson_probability(lam, target, exact=False):
    if lam <= 0:
        return 0.0
    if exact:
        return poisson_pmf(target, lam)
    else:
        # P(X >= target) = 1 - P(X <= target-1)
        return 1.0 - poisson_cdf(target - 1, lam)

def analyze_props(data):
    results = []
    
    # Global baselines
    league_goals_avg = 1.3 
    league_shots_avg = 4.0
    league_cards_avg = 4.0
    
    opp_gc_avg = data.get("opponent_goals_conceded_avg", league_goals_avg)
    opp_sc_avg = data.get("opponent_shots_conceded_avg", league_shots_avg)
    ref_yc_avg = data.get("referee_yellows_avg", league_cards_avg)
    
    if opp_gc_avg <= 0: opp_gc_avg = league_goals_avg
    if opp_sc_avg <= 0: opp_sc_avg = league_shots_avg
    if ref_yc_avg <= 0: ref_yc_avg = league_cards_avg
    
    defense_mod = min(max(opp_gc_avg / league_goals_avg, 0.5), 2.0)
    defense_shot_mod = min(max(opp_sc_avg / league_shots_avg, 0.5), 2.0)
    ref_mod = min(max(ref_yc_avg / league_cards_avg, 0.5), 2.0)

    # --- V80 MICRO-SIMULATION: Absence Impact Matrix ---
    absences = data.get("absences", {})
    opp_absences = absences.get("opponent", []) # List of positions like ['G', 'D', 'D']
    
    # 🧤 GK Impact: High boost to all scoring probabilities
    if 'G' in opp_absences:
        defense_mod *= 1.25
        defense_shot_mod *= 1.10
        
    # 🛡️ DF Impact: Boost to specific striker targets
    df_count = opp_absences.count('D')
    if df_count > 0:
        defense_mod *= (1.0 + (0.08 * df_count)) # ~8% boost per missing defender
        defense_shot_mod *= (1.0 + (0.05 * df_count))

    # ⚙️ MD Impact: Defensive transition weakness
    if 'M' in opp_absences:
        defense_shot_mod *= 1.12

    for p in data.get("players", []):
        name = p.get("name", "Unknown")
        player_id = p.get("player_id", "")
        pos = p.get("position", "U").upper()
        
        # 1. Goalscorer Prop (target >= 1)
        # 🚀 [TITANIUM QUANT] Prefer xG (Expected Goals) over actual goals for predictive stability
        p_xg_avg = float(p.get("xg_avg", 0.0))
        p_goals_avg = float(p.get("goals_avg", p.get("goals", 0.0) / 10 if "goals" in p else 0.0))
        
        base_scoring_metric = p_xg_avg if p_xg_avg > 0 else p_goals_avg
        
        # 🔥 [HEATMAP BOOST] If the player spends significant time in the danger zone
        heatmap_danger = float(p.get("heatmap_danger", 0.0))
        heatmap_boost = 1.0 + (heatmap_danger * 0.5) # Up to 1.5x boost if 100% in danger zone
        
        if base_scoring_metric > 0.05:
            lam_goals = base_scoring_metric * defense_mod * heatmap_boost
            prob_goal = get_poisson_probability(lam_goals, 1)
            
            reason_ar = "قناص متميز (معدل xG مرتفع)" if p_xg_avg > 0 else "سجل تهديفي مستقر"
            if 'G' in opp_absences: reason_ar = "غياب الحارس الأساسي يسهل المهمة"
            elif df_count > 0: reason_ar = "ثغرات في دفاع الخصم تزيد الفرص"
            elif heatmap_danger > 0.2: reason_ar = "تمركز خطير مستمر داخل منطقة الجزاء (Heatmap)"

            if prob_goal > 0.05:
                results.append({
                    "player_id": player_id,
                    "player_name": name,
                    "prop_type": "Anytime Goalscorer",
                    "market_ar": "باهداف في أي وقت",
                    "reason_ar": reason_ar,
                    "lam": round(lam_goals, 3),
                    "probability": round(prob_goal * 100, 2)
                })
        
        # 2. Shots on Target (target >= 2 -> Over 1.5)
        p_xgot_avg = float(p.get("xgot_avg", 0.0)) # Expected Goals on Target
        p_shots_avg = float(p.get("shots_on_target_avg", p.get("shots", 0.0) / 10 if "shots" in p else 0.0))
        
        base_shots_metric = p_xgot_avg if p_xgot_avg > 0 else p_shots_avg
        
        if base_shots_metric > 0.1:
            lam_shots = base_shots_metric * defense_shot_mod * heatmap_boost
            prob_shots = get_poisson_probability(lam_shots, 2)
            
            reason_ar = "دقة عالية في التسديد (xGOT)" if p_xgot_avg > 0 else "دقة عالية في التسديد"
            if 'D' in opp_absences: reason_ar = "ضعف الرقابة الدفاعية يفتح مساحات للتسديد"
            elif heatmap_danger > 0.2: reason_ar = "حرية حركة حول منطقة الجزاء"

            if prob_shots > 0.05:
                results.append({
                    "player_id": player_id,
                    "player_name": name,
                    "prop_type": "Over 1.5 Shots on Target",
                    "market_ar": "أكثر من 1.5 تسديدة على المرمى",
                    "reason_ar": reason_ar,
                    "lam": round(lam_shots, 3),
                    "probability": round(prob_shots * 100, 2)
                })
        
        # 3. Yellow Card Prop (target >= 1)
        p_cards_avg = float(p.get("yellow_cards_avg", p.get("yellow_cards", 0.0) / 10 if "yellow_cards" in p else 0.0))
        
        if p_cards_avg > 0.01:
            lam_cards = p_cards_avg * ref_mod
            prob_card = get_poisson_probability(lam_cards, 1)
            
            if prob_card > 0.10:
                results.append({
                    "player_id": player_id,
                    "player_name": name,
                    "prop_type": "To Be Carded",
                    "lam": round(lam_cards, 3),
                    "probability": round(prob_card * 100, 2)
                })
                
    results = sorted(results, key=lambda x: x["probability"], reverse=True)
    return {"success": True, "props": results}

if __name__ == "__main__":
    try:
        input_data = sys.stdin.read()
        if not input_data.strip():
            print(json.dumps({"success": False, "error": "Empty input data"}))
            sys.exit(0)
            
        data = json.loads(input_data)
        out = analyze_props(data)
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
