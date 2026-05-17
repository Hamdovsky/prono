import json
import math
import numpy as np

_poisson = None
def get_poisson():
    global _poisson
    if _poisson is None:
        try:
            from scipy.stats import poisson
            _poisson = poisson
        except Exception as e:
            print(f"DEBUG: scipy.stats.poisson not available: {e}")
            _poisson = "NOT_AVAILABLE"
    return _poisson

def calculate_implied_probability(odds):
    """Convert odds to implied probability."""
    try:
        if odds <= 1.0: return 0.0
        return 1.0 / odds
    except:
        return 0.0

def remove_vig(odds_h, odds_d, odds_a):
    """Calculate true probabilities by removing bookmaker margin."""
    try:
        prob_h = calculate_implied_probability(odds_h)
        prob_d = calculate_implied_probability(odds_d)
        prob_a = calculate_implied_probability(odds_a)
        
        margin = prob_h + prob_d + prob_a
        if margin <= 0.0: return 0.33, 0.33, 0.34
        
        return prob_h / margin, prob_d / margin, prob_a / margin
    except:
        return 0.33, 0.33, 0.34

def analyze_1x2_odds(match_obj):
    """Analyzes 1X2 odds, calculates true probabilities, and detects Sharp Money."""
    odds_h = float(match_obj.get('odds_home') or 0.0)
    odds_d = float(match_obj.get('odds_draw') or 0.0)
    odds_a = float(match_obj.get('odds_away') or 0.0)
    
    odds_h_open = float(match_obj.get('odds_home_open') or odds_h)
    odds_d_open = float(match_obj.get('odds_draw_open') or odds_d)
    odds_a_open = float(match_obj.get('odds_away_open') or odds_a)
    
    true_prob_h, true_prob_d, true_prob_a = remove_vig(odds_h, odds_d, odds_a)
    
    # Sharp Money Detection: Sudden drop in odds > 10%
    sharp_money_h, sharp_money_d, sharp_money_a = 0, 0, 0
    odds_change_speed_h, odds_change_speed_a = 0.0, 0.0
    
    if odds_h_open > 0 and odds_h > 0:
        drop_h = (odds_h_open - odds_h) / odds_h_open
        if drop_h >= 0.10: sharp_money_h = 1
        odds_change_speed_h = drop_h # Positive value means odds dropped (confidence increased)
        
    if odds_a_open > 0 and odds_a > 0:
        drop_a = (odds_a_open - odds_a) / odds_a_open
        if drop_a >= 0.10: sharp_money_a = 1
        odds_change_speed_a = drop_a
        
    if odds_d_open > 0 and odds_d > 0:
        drop_d = (odds_d_open - odds_d) / odds_d_open
        if drop_d >= 0.10: sharp_money_d = 1
        
    sharp_money_indicator = 1 if (sharp_money_h or sharp_money_a or sharp_money_d) else 0
    
    return {
        "true_prob_h": true_prob_h,
        "true_prob_d": true_prob_d,
        "true_prob_a": true_prob_a,
        "sharp_money_h": sharp_money_h,
        "sharp_money_a": sharp_money_a,
        "sharp_money_d": sharp_money_d,
        "sharp_money_indicator": sharp_money_indicator,
        "odds_change_speed_h": odds_change_speed_h,
        "odds_change_speed_a": odds_change_speed_a,
        "odds_h": odds_h,
        "odds_d": odds_d,
        "odds_a": odds_a
    }

def poisson_prob(lam, k):
    if k < 0: return 0
    if lam <= 0: return 1.0 if k == 0 else 0.0
    return (math.exp(-lam) * (lam**k)) / math.factorial(k)

def calculate_correct_score(xg_h, xg_a):
    """Find the most probable exact score using full Poisson distribution."""
    best_score = (1, 1)
    best_prob = -1
    for h in range(8):
        for a in range(8):
            prob = poisson_prob(xg_h, h) * poisson_prob(xg_a, a)
            if prob > best_prob:
                best_prob = prob
                best_score = (h, a)
    return best_score, best_prob

def analyze_over_under_and_cs(xg_h, xg_a):
    """Determines probability of Over/Under goals and correct score."""
    expected_total_goals = xg_h + xg_a
    
    # Try to use scipy if available, otherwise fallback to local poisson
    poisson_mod = get_poisson()
    
    def _get_prob(lam, k):
        if poisson_mod != "NOT_AVAILABLE":
            return poisson_mod.pmf(k, lam)
        return poisson_prob(lam, k)

    # Poisson calculation for Over 2.5
    under_25_prob = 0.0
    for h in range(4):
        for a in range(4):
            if h + a < 3:
                under_25_prob += _get_prob(xg_h, h) * _get_prob(xg_a, a)
                
    over_25_prob = 1.0 - under_25_prob
    
    # Correct Score Calculation
    best_score = (1, 1)
    best_prob = -1
    for h in range(8):
        for a in range(8):
            prob = _get_prob(xg_h, h) * _get_prob(xg_a, a)
            if prob > best_prob:
                best_prob = prob
                best_score = (h, a)
    
    return {
        "expected_total_goals": expected_total_goals,
        "over_25_prob": over_25_prob,
        "under_25_prob": under_25_prob,
        "predicted_score_h": best_score[0],
        "predicted_score_a": best_score[1],
        "predicted_score_prob": best_prob
    }

def analyze_asian_handicap(odds_analysis, xg_h, xg_a):
    """Evaluates the strongest team based on Asian Handicap with quarter-line support."""
    xg_diff = xg_h - xg_a
    true_prob_h = odds_analysis['true_prob_h']
    true_prob_a = odds_analysis['true_prob_a']
    
    strongest_team = "Draw"
    suggested_handicap = 0.0
    
    # Home Favorite logic
    if xg_diff > 0.2 and true_prob_h > 0.45:
        strongest_team = "Home"
        if xg_diff > 1.75: suggested_handicap = -2.0
        elif xg_diff > 1.5: suggested_handicap = -1.75
        elif xg_diff > 1.25: suggested_handicap = -1.5
        elif xg_diff > 1.0: suggested_handicap = -1.25
        elif xg_diff > 0.75: suggested_handicap = -1.0
        elif xg_diff > 0.5: suggested_handicap = -0.75
        elif xg_diff > 0.25: suggested_handicap = -0.5
        else: suggested_handicap = -0.25
    # Away Favorite logic
    elif xg_diff < -0.2 and true_prob_a > 0.45:
        strongest_team = "Away"
        abs_diff = abs(xg_diff)
        if abs_diff > 1.75: suggested_handicap = -2.0
        elif abs_diff > 1.5: suggested_handicap = -1.75
        elif abs_diff > 1.25: suggested_handicap = -1.5
        elif abs_diff > 1.0: suggested_handicap = -1.25
        elif abs_diff > 0.75: suggested_handicap = -1.0
        elif abs_diff > 0.5: suggested_handicap = -0.75
        elif abs_diff > 0.25: suggested_handicap = -0.5
        else: suggested_handicap = -0.25
        
    return {
        "ah_strongest_team": strongest_team,
        "ah_suggested_line": suggested_handicap,
        "confidence": max(true_prob_h, true_prob_a) if strongest_team != "Draw" else 0.33
    }

def analyze_referee(match_obj):
    """Analyzes referee strictness from match context or database."""
    ref_name = match_obj.get('referee_name') or match_obj.get('referee') or 'Unknown'
    # Use real historical data populated by Workflow.js
    yellow_avg = float(match_obj.get('referee_yellow_avg') or 3.8)
    red_avg = float(match_obj.get('referee_red_avg') or 0.15)
    pen_avg = float(match_obj.get('referee_penalties_avg') or 0.25)
    
    strictness = 50.0
    if yellow_avg > 4.5: strictness += 20
    if red_avg > 0.25: strictness += 15
    if pen_avg > 0.4: strictness += 15
    
    return {
        "referee": ref_name,
        "strictness_index": min(100, strictness),
        "yellow_avg": yellow_avg,
        "red_avg": red_avg,
        "pen_avg": pen_avg,
        "cards_expectation": "High" if strictness > 70 else ("Low" if strictness < 35 else "Normal")
    }

def extract_advanced_stats(match_obj):
    """Extracts advanced stats like xG, Shots On Target, Form, H2H."""
    xg_h = float(match_obj.get('home_xg') or 1.2)
    xg_a = float(match_obj.get('away_xg') or 1.2)
    
    h_sot = float(match_obj.get('home_sot') or 4.0)
    a_sot = float(match_obj.get('away_sot') or 4.0)
    
    # Retrieve form or motivation
    form_ctx = match_obj.get('form_context')
    if isinstance(form_ctx, str):
        try: form_ctx = json.loads(form_ctx)
        except: form_ctx = {}
    if not isinstance(form_ctx, dict): form_ctx = {}
        
    h_form = form_ctx.get('home', {})
    a_form = form_ctx.get('away', {})
    
    h_motivation = float(match_obj.get('home_motivation') or 1.0)
    a_motivation = float(match_obj.get('away_motivation') or 1.0)
    
    news_impact = float(match_obj.get('news_impact') or 0.0)
    news_sentiment = float(match_obj.get('news_sentiment') or 0.0)
    
    # Player Ratings Integration
    def _avg_rating(ratings_raw):
        if not ratings_raw: return 7.0
        try:
            ratings = json.loads(ratings_raw) if isinstance(ratings_raw, str) else ratings_raw
            if not ratings: return 7.0
            # If ratings is a list of player objects with 'rating' field
            vals = [float(p.get('rating', 7.0)) for p in ratings if isinstance(p, dict)]
            return sum(vals)/len(vals) if vals else 7.0
        except: return 7.0

    h_rating = _avg_rating(match_obj.get('player_ratings_home'))
    a_rating = _avg_rating(match_obj.get('player_ratings_away'))

    return {
        "xg_h": xg_h,
        "xg_a": xg_a,
        "h_sot": h_sot,
        "a_sot": a_sot,
        "h_motivation": h_motivation,
        "a_motivation": a_motivation,
        "news_impact": news_impact,
        "news_sentiment": news_sentiment,
        "h_rating": h_rating,
        "a_rating": a_rating,
        "rating_diff": h_rating - a_rating
    }

def evaluate_value_bets(odds_analysis, ou_cs_analysis, xg_h, xg_a):
    """
    Detects Value Bets by comparing xG-model Poisson probability against
    the MARKET implied probability (1/odds).
    A Value Bet exists when our model probability > market implied probability by >= 5%.
    """
    odds_h = odds_analysis['odds_h']
    odds_d = odds_analysis['odds_d']
    odds_a = odds_analysis['odds_a']
    
    # Market implied probabilities (raw, with vig included)
    market_impl_h = (1.0 / odds_h) if odds_h > 1.0 else 0.0
    market_impl_d = (1.0 / odds_d) if odds_d > 1.0 else 0.0
    market_impl_a = (1.0 / odds_a) if odds_a > 1.0 else 0.0
    
    # Our model's probabilities derived from xG (Poisson-based)
    # Monte Carlo shortcut: derive 1X2 probs from Poisson integrals
    home_win_prob = 0.0
    draw_prob = 0.0
    away_win_prob = 0.0
    poisson_mod = get_poisson()
    def _get_prob(lam, k):
        if poisson_mod != "NOT_AVAILABLE":
            return poisson_mod.pmf(k, lam)
        return poisson_prob(lam, k)

    for h_g in range(8):
        for a_g in range(8):
            p = _get_prob(xg_h, h_g) * _get_prob(xg_a, a_g)
            if h_g > a_g: home_win_prob += p
            elif h_g == a_g: draw_prob += p
            else: away_win_prob += p
    
    value_bet_flag = 0
    best_value_selection = "None"
    highest_value_index = 0.0
    
    # Value = when MODEL probability > MARKET implied probability by >= 5% (edge)
    # Value Index = MODEL_PROB * MARKET_ODDS (> 1.0 means positive expected value)
    outcomes_value = [
        ("Home", home_win_prob, odds_h, market_impl_h),
        ("Draw", draw_prob, odds_d, market_impl_d),
        ("Away", away_win_prob, odds_a, market_impl_a),
    ]
    
    for outcome, model_prob, market_odds, market_impl in outcomes_value:
        if market_odds <= 1.0: continue
        value_index = model_prob * market_odds  # > 1.0 means value
        edge = model_prob - market_impl  # Positive means our model disagrees favourably
        
        if value_index > 1.05 and edge > 0.03:  # at least 3% edge AND positive EV
            if value_index > highest_value_index:
                highest_value_index = value_index
                best_value_selection = outcome
                value_bet_flag = 1
    
    # Over/Under value based on xG model
    if ou_cs_analysis['over_25_prob'] > 0.60:
        if value_bet_flag == 0: best_value_selection = "Over 2.5"
        value_bet_flag = 1
    elif ou_cs_analysis['under_25_prob'] > 0.65:
        if value_bet_flag == 0: best_value_selection = "Under 2.5"
        value_bet_flag = 1
            
    return {
        "value_bet_flag": value_bet_flag,
        "best_value_selection": best_value_selection,
        "highest_value_index": highest_value_index,
        "model_prob_h": home_win_prob,
        "model_prob_d": draw_prob,
        "model_prob_a": away_win_prob
    }

def process_match_for_top_analyst(match_obj):
    """Main function that processes a match object and returns ML features and direct prediction."""
    
    odds_analysis = analyze_1x2_odds(match_obj)
    stats_analysis = extract_advanced_stats(match_obj)
    
    xg_h = stats_analysis['xg_h']
    xg_a = stats_analysis['xg_a']
    
    ou_cs_analysis = analyze_over_under_and_cs(xg_h, xg_a)
    ah_analysis = analyze_asian_handicap(odds_analysis, xg_h, xg_a)
    value_analysis = evaluate_value_bets(odds_analysis, ou_cs_analysis, xg_h, xg_a)
    referee_analysis = analyze_referee(match_obj)
    
    # [V26] Trend Analysis (LSTM)
    from lstm_engine import analyze_sequence
    # Prepare history for LSTM
    h_hist = match_obj.get('history_home', [])[:10]
    lstm_data = []
    for m in h_hist:
        lstm_data.append({
            "xg": m.get('home_xg', 1.2),
            "points": m.get('points', 1),
            "shots": m.get('shots_home', 10),
            "possession": m.get('poss_home', 50)
        })
    trend_analysis = analyze_sequence(lstm_data)
    
    # Build Indicators
    market_confidence_indicator = 1 if (odds_analysis['sharp_money_indicator'] == 1 and value_analysis['value_bet_flag'] == 1) else 0
    team_strength_indicator = xg_h - xg_a # Positive means Home is stronger, Negative means Away
    momentum_indicator = stats_analysis['h_motivation'] - stats_analysis['a_motivation']
    goal_expectation_indicator = ou_cs_analysis['expected_total_goals']
    
    # ML Features Flat Output (Safe for XGBoost)
    ml_features = {
        "ta_true_prob_h": float(odds_analysis['true_prob_h']),
        "ta_true_prob_d": float(odds_analysis['true_prob_d']),
        "ta_true_prob_a": float(odds_analysis['true_prob_a']),
        "ta_odds_change_speed_h": float(odds_analysis['odds_change_speed_h']),
        "ta_odds_change_speed_a": float(odds_analysis['odds_change_speed_a']),
        "ta_sharp_money_h": float(odds_analysis['sharp_money_h']),
        "ta_sharp_money_a": float(odds_analysis['sharp_money_a']),
        "ta_sharp_money_d": float(odds_analysis['sharp_money_d']),
        "ta_sharp_money_indicator": float(odds_analysis['sharp_money_indicator']),
        "ta_xg_h": float(xg_h),
        "ta_xg_a": float(xg_a),
        "ta_sot_h": float(stats_analysis['h_sot']),
        "ta_sot_a": float(stats_analysis['a_sot']),
        "ta_news_impact": float(stats_analysis['news_impact']),
        "ta_news_sentiment": float(stats_analysis['news_sentiment']),
        "ta_over_25_prob": float(ou_cs_analysis['over_25_prob']),
        "ta_under_25_prob": float(ou_cs_analysis['under_25_prob']),
        "ta_expected_total_goals": float(ou_cs_analysis['expected_total_goals']),
        "ta_value_bet_flag": float(value_analysis['value_bet_flag']),
        "ta_highest_value_index": float(value_analysis['highest_value_index']),
        "ta_market_confidence_indicator": float(market_confidence_indicator),
        "ta_team_strength_indicator": float(team_strength_indicator),
        "ta_momentum_indicator": float(momentum_indicator),
        "ta_goal_expectation_indicator": float(goal_expectation_indicator),
        "ta_h_rating": float(stats_analysis['h_rating']),
        "ta_a_rating": float(stats_analysis['a_rating']),
        "ta_rating_diff": float(stats_analysis['rating_diff'])
    }
    
    # Direct Prediction Generation
    home_name = match_obj.get('homeTeam', 'Home')
    away_name = match_obj.get('awayTeam', 'Away')
    
    # Final Verdict & Tip Generation
    winner_tip = "Home" if xg_h - xg_a > 0.4 and odds_analysis['true_prob_h'] > 0.42 else ("Away" if xg_a - xg_h > 0.4 and odds_analysis['true_prob_a'] > 0.42 else "Draw")
    verdict = "SAFE BET" if (value_analysis['value_bet_flag'] == 1 and market_confidence_indicator == 1) else ("STRONG BET" if max(value_analysis['model_prob_h'], value_analysis['model_prob_a']) > 0.55 else "RISKY BET")
    power_score = int(50 + (xg_h * 15) + (trend_analysis['trend_score']/5))

    return {
        "verdict": verdict,
        "power_score": min(99, power_score),
        "main_predictions": [
            {"label": "Direct Tip", "val": winner_tip, "conf": round(value_analysis['model_prob_h' if "Home" in winner_tip else ('model_prob_a' if "Away" in winner_tip else 'model_prob_d')]*100, 1)},
            {"label": "Goals (2.5)", "val": "Over 2.5" if ou_cs_analysis['over_25_prob'] > 0.5 else "Under 2.5", "conf": round(max(ou_cs_analysis['over_25_prob'], ou_cs_analysis['under_25_prob'])*100, 1)},
            {"label": "Correct Score", "val": f"{ou_cs_analysis['predicted_score_h']}-{ou_cs_analysis['predicted_score_a']}", "conf": round(ou_cs_analysis['over_25_prob']*50, 1)},
            {"label": "Trend", "val": trend_analysis['momentum'], "score": trend_analysis['trend_score']}
        ],
        "ml_features": ml_features,
        "direct_prediction": f"{winner_tip} | Trend: {trend_analysis['momentum']} ({trend_analysis['trend_score']})",
        "analysis_data": {
            "odds": odds_analysis,
            "stats": stats_analysis,
            "ou": ou_cs_analysis,
            "ah": ah_analysis,
            "value": value_analysis,
            "referee": referee_analysis,
            "trend": trend_analysis
        },
        "power_tubes": {
            "Attack Strength": "█" * min(10, int(xg_h * 2.5)) + "░" * max(0, 10 - int(xg_h * 2.5)),
            "Defense Strength": "█" * min(10, int(4 - xg_a)) + "░" * max(0, 10 - int(4 - xg_a)),
            "Trend Momentum": "█" * int(trend_analysis['trend_score']/10) + "░" * (10 - int(trend_analysis['trend_score']/10)),
            "Referee Strictness": "█" * int(referee_analysis['strictness_index']/10) + "░" * (10 - int(referee_analysis['strictness_index']/10)),
            "Market Value": "█" * min(10, int(value_analysis['highest_value_index'] * 5)) + "░" * max(0, 10 - int(value_analysis['highest_value_index'] * 5))
        }
    }

if __name__ == "__main__":
    import sys
    try:
        input_data = sys.stdin.read()
        if input_data.strip():
            print(json.dumps(process_match_for_top_analyst(json.loads(input_data)), indent=2))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
