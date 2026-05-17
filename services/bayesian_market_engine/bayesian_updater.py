import json

class BayesianMarketEngine:
    def __init__(self):
        self.market_weight = 0.5  # Dynamic weight between ML and Market

    def update_probabilities(self, prior_probs: dict, market_odds: dict):
        """
        Bayesian Updating: Posterior = Prior × MarketEvidence
        Blends ML intelligence (Prior) with Pinnacle intelligence (Evidence)
        """
        # Convert market odds to implied probabilities (Market Evidence)
        market_implied = self._odds_to_probs(market_odds)
        
        # Disagreement detector
        disagreement = self._calculate_disagreement(prior_probs, market_implied)
        
        if disagreement > 0.15: # 15% diff
            # If the market disagrees heavily with our ML, we trust the sharp market more
            self.market_weight = 0.8
            print("⚠️ High disagreement detected. Shifting weight to Sharp Market.")
        else:
            self.market_weight = 0.5

        # Calculate Posterior (Simplified Bayesian blend)
        posterior = {}
        for key in ['home', 'draw', 'away']:
            posterior[key] = (prior_probs[key] * (1 - self.market_weight)) + (market_implied[key] * self.market_weight)
            
        # Normalize posterior
        total = sum(posterior.values())
        return {k: v/total for k, v in posterior.items()}

    def _odds_to_probs(self, odds: dict):
        # Remove margin (Vig) and return true probabilities
        raw_probs = {k: 1/v for k, v in odds.items() if v > 0}
        margin = sum(raw_probs.values())
        return {k: v/margin for k, v in raw_probs.items()}

    def _calculate_disagreement(self, prior, market):
        # Calculate max delta
        return max(abs(prior[k] - market[k]) for k in prior.keys())

if __name__ == "__main__":
    print("🧠 Bayesian Market Updating Engine initialized.")
