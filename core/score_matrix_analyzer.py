import numpy as np
import pandas as pd
from scipy.stats import poisson

def build_score_matrix(xg_home, xg_away, max_goals=6):
    """
    Builds a full score matrix using Poisson distribution.
    
    Args:
        xg_home (float): Expected goals for the home team.
        xg_away (float): Expected goals for the away team.
        max_goals (int): Maximum number of goals to consider for each team.
        
    Returns:
        pd.DataFrame: A matrix where rows are home goals and columns are away goals.
                      Values are the joint probabilities of the specific scoreline.
    """
    # Calculate zero to max_goals probabilities for each team
    probs_home = [poisson.pmf(i, xg_home) for i in range(max_goals + 1)]
    probs_away = [poisson.pmf(i, xg_away) for i in range(max_goals + 1)]
    
    # Create the cross-matrix obtained by outer product of vectors
    matrix = np.outer(probs_home, probs_away)
    
    # Convert to DataFrame for readability
    df_matrix = pd.DataFrame(matrix)
    df_matrix.index.name = "Home Goals"
    df_matrix.columns.name = "Away Goals"
    
    return df_matrix

def extract_all_scores(matrix):
    """
    Extracts all possible scorelines from the score matrix and sorts them by probability.
    
    Args:
        matrix (np.ndarray or pd.DataFrame): The score matrix.
        
    Returns:
        pd.DataFrame: A sorted list of scorelines with their probabilities.
    """
    if isinstance(matrix, pd.DataFrame):
        matrix_array = matrix.values
    else:
        matrix_array = matrix

    scores = []
    max_goals_home, max_goals_away = matrix_array.shape
    
    for h in range(max_goals_home):
        for a in range(max_goals_away):
            prob = matrix_array[h, a]
            scores.append({
                "Score": f"{h}-{a}",
                "Probability (%)": round(prob * 100, 2),
                "Implied Odds": round(1 / prob, 2) if prob > 0 else float('inf')
            })
            
    df_scores = pd.DataFrame(scores).sort_values(by="Probability (%)", ascending=False).reset_index(drop=True)
    return df_scores

def calculate_markets(matrix):
    """
    Calculates betting market probabilities (1X2, Over/Under, BTTS) from the score matrix.
    
    Args:
        matrix (np.ndarray or pd.DataFrame): The score matrix.
        
    Returns:
        dict: A dictionary of market probabilities.
    """
    if isinstance(matrix, pd.DataFrame):
        matrix_array = matrix.values
    else:
        matrix_array = matrix

    max_goals_home, max_goals_away = matrix_array.shape
    
    # 1X2 Probabilities
    # Note: Using matrix indices, the lower triangle (home > away) represents home win
    prob_home_win = np.tril(matrix_array, -1).sum()
    prob_draw = np.trace(matrix_array)
    # Upper triangle (away > home) represents away win
    prob_away_win = np.triu(matrix_array, 1).sum()
    
    # BTTS (Both Teams To Score)
    # Matrix from (1,1) to (max,max) represents both teams scoring at least 1
    prob_btts_yes = matrix_array[1:, 1:].sum()
    prob_btts_no = 1 - prob_btts_yes
    
    # Over/Under Probabilities
    over_under_markets = [1.5, 2.5, 3.5]
    ou_probs = {}
    
    for threshold in over_under_markets:
        prob_under = 0
        prob_over = 0
        for h in range(max_goals_home):
            for a in range(max_goals_away):
                if h + a < threshold:
                    prob_under += matrix_array[h, a]
                else:
                    prob_over += matrix_array[h, a]
        ou_probs[f"Over {threshold}"] = prob_over
        ou_probs[f"Under {threshold}"] = prob_under

    return {
        "1X2": {
            "Home Win": prob_home_win,
            "Draw": prob_draw,
            "Away Win": prob_away_win
        },
        "BTTS": {
            "Yes": prob_btts_yes,
            "No": prob_btts_no
        },
        "Over/Under": ou_probs
    }

def print_analysis(xg_h, xg_a):
    print(f"--- Analysis for xG: Home {xg_h:.2f} vs Away {xg_a:.2f} ---")
    
    matrix_df = build_score_matrix(xg_h, xg_a)
    print("\n🟢 Score Matrix (Probabilities %):")
    # Format matrix to percentages for display
    display_df = (matrix_df * 100).round(2).astype(str) + "%"
    print(display_df)
    
    scores_df = extract_all_scores(matrix_df)
    print("\n🔴 Top 10 Most Likely Scores:")
    print(scores_df.head(10).to_string(index=False))
    
    markets = calculate_markets(matrix_df)
    
    print("\n🔵 1X2 Market:")
    for outcome, prob in markets["1X2"].items():
        if prob > 0:
            print(f"  {outcome}: {prob*100:.2f}% (Odds: {1/prob:.2f})")
        else:
            print(f"  {outcome}: {prob*100:.2f}%")
        
    print("\n🟣 BTTS Market:")
    for outcome, prob in markets["BTTS"].items():
        if prob > 0:
            print(f"  {outcome}: {prob*100:.2f}% (Odds: {1/prob:.2f})")
        else:
             print(f"  {outcome}: {prob*100:.2f}%")
        
    print("\n🟡 Over/Under Markets:")
    for k, v in markets["Over/Under"].items():
        if v > 0:
            print(f"  {k}: {v*100:.2f}% (Odds: {1/v:.2f})")
        else:
            print(f"  {k}: {v*100:.2f}%")
        
    print("-" * 50)


# Example usage
if __name__ == "__main__":
    # Example 1: Balanced Match
    print_analysis(xg_h=1.5, xg_a=1.2)
    
    # Example 2: Strong Favorite
    print_analysis(xg_h=2.8, xg_a=0.5)

