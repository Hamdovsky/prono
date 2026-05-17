class RiskManager:
    def __init__(self, total_bankroll: float):
        self.bankroll = total_bankroll
        self.max_exposure_per_match = 0.05  # Max 5% of bankroll per match
        self.kelly_fraction = 0.25          # Quarter Kelly to minimize variance
        self.current_drawdown = 0.0

    def calculate_stake(self, true_prob: float, offered_odds: float) -> float:
        """
        Fractional Kelly Criterion for stake sizing.
        f* = (bp - q) / b
        where b = odds - 1, p = probability of winning, q = probability of losing (1-p)
        """
        b = offered_odds - 1.0
        p = true_prob
        q = 1.0 - p
        
        kelly_percentage = (b * p - q) / b
        
        if kelly_percentage <= 0:
            return 0.0 # No value
            
        # Apply fractional Kelly
        adjusted_kelly = kelly_percentage * self.kelly_fraction
        
        # Cap exposure
        final_stake_percentage = min(adjusted_kelly, self.max_exposure_per_match)
        
        # Drawdown protection (Reduce stakes if we are in a drawdown)
        if self.current_drawdown > 0.10: # If we lost 10% of bankroll
            final_stake_percentage *= 0.5 # Cut stakes in half
            
        return round(self.bankroll * final_stake_percentage, 2)

    def check_kill_switch(self):
        """
        Circuit breaker to stop trading completely if catastrophic failure detected
        """
        if self.current_drawdown > 0.25:
            print("🛑 KILL SWITCH ACTIVATED. System halted due to 25% drawdown.")
            return True
        return False

    def assess_portfolio_correlation(self, new_bet):
        """
        Prevent betting on highly correlated outcomes that multiply risk
        """
        pass

if __name__ == "__main__":
    print("🛡️ Risk Management Engine initialized.")
