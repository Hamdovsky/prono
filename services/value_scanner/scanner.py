class ValueScanner:
    def __init__(self):
        self.min_ev_threshold = 0.02 # 2% Edge minimum

    def scan_for_value(self, true_probs: dict, market_odds: dict):
        """
        Compare True Probabilities (from our ML + Bayesian Engine) against Live Market Odds.
        EV = (TrueProbability * Odds) - 1
        """
        opportunities = []
        
        for selection, prob in true_probs.items():
            offered_odds = market_odds.get(selection, 0)
            if offered_odds <= 1.0:
                continue
                
            ev = (prob * offered_odds) - 1.0
            
            if ev >= self.min_ev_threshold:
                opportunities.append({
                    "selection": selection,
                    "true_prob": prob,
                    "offered_odds": offered_odds,
                    "ev": ev,
                    "edge_percentage": ev * 100
                })
                
        return sorted(opportunities, key=lambda x: x['ev'], reverse=True)

    def detect_stale_line(self, pinnacle_odds: dict, soft_book_odds: dict):
        """
        Detect if a soft bookmaker has not yet updated their odds to match a Pinnacle sharp move.
        """
        pass

if __name__ == "__main__":
    print("🔎 Arbitrage & Value Detection Scanner initialized.")
