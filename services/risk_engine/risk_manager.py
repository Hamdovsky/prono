class RiskManager:
    def __init__(self, total_bankroll: float):
        self.bankroll = total_bankroll
        self.max_exposure_per_match = 0.015  # Max 1.5% of bankroll per match (Phase 4)
        self.kelly_fraction = 0.25          # Quarter Kelly to minimize variance
        self.current_drawdown = 0.0
        self.peak_bankroll = total_bankroll  # Initialize peak for drawdown tracking
        self.open_positions = []  # Track open bets for correlation check

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
            return 0.0  # No value
            
        # Apply fractional Kelly
        adjusted_kelly = kelly_percentage * self.kelly_fraction
        
        # Cap exposure at 1.5% max
        final_stake_percentage = min(adjusted_kelly, self.max_exposure_per_match)
        
        # Drawdown protection - Step-based reduction
        if self.current_drawdown >= 0.20:
            final_stake_percentage *= 0.0  # KILL SWITCH at 20%
        elif self.current_drawdown >= 0.15:
            final_stake_percentage *= 0.25  # Cut to 25% at 15%
        elif self.current_drawdown >= 0.10:
            final_stake_percentage *= 0.5   # Cut to 50% at 10%
        elif self.current_drawdown >= 0.05:
            final_stake_percentage *= 0.75  # Cut to 75% at 5%
            
        # Additional hard cap at 1.5% bankroll
        final_stake_percentage = min(final_stake_percentage, 0.015)
        
        return round(self.bankroll * final_stake_percentage, 2)

    def check_kill_switch(self):
        """
        Circuit breaker to stop trading completely if catastrophic failure detected
        """
        if self.current_drawdown >= 0.20:
            print("🛑 KILL SWITCH ACTIVATED. System halted due to 20% drawdown.")
            return True
        return False

    def update_drawdown(self, current_bankroll: float):
        """Update current drawdown based on peak bankroll"""
        if not hasattr(self, 'peak_bankroll') or current_bankroll > self.peak_bankroll:
            self.peak_bankroll = current_bankroll
        self.current_drawdown = (self.peak_bankroll - current_bankroll) / self.peak_bankroll if self.peak_bankroll > 0 else 0.0

    def assess_portfolio_correlation(self, new_bet: dict) -> bool:
        """
        Prevent betting on highly correlated outcomes that multiply risk.
        
        Args:
            new_bet: dict with keys 'league', 'selection' (Home/Draw/Away), 'market_type'
        
        Returns:
            True if bet is allowed, False if correlation risk too high
        """
        if not self.open_positions:
            return True
            
        # Count same-league same-direction bets
        same_league_same_dir = sum(
            1 for pos in self.open_positions 
            if pos.get('league') == new_bet.get('league') 
            and pos.get('selection') == new_bet.get('selection')
        )
        
        # Max 2 bets on same outcome in same league
        if same_league_same_dir >= 2:
            return False
            
        # Count total bets in same league
        same_league_total = sum(
            1 for pos in self.open_positions 
            if pos.get('league') == new_bet.get('league')
        )
        
        # Max 3 bets total in same league
        if same_league_total >= 3:
            return False
            
        return True

    def add_position(self, bet: dict):
        """Track open position for correlation monitoring"""
        self.open_positions.append({
            'league': bet.get('league'),
            'selection': bet.get('selection'),  # Home/Draw/Away
            'market_type': bet.get('market_type', '1X2'),
            'stake': bet.get('stake', 0),
            'timestamp': bet.get('timestamp')
        })
        # Keep only last 50 positions
        if len(self.open_positions) > 50:
            self.open_positions = self.open_positions[-50:]

    def remove_position(self, bet: dict):
        """Remove settled position"""
        league = bet.get('league')
        selection = bet.get('selection')
        self.open_positions = [
            p for p in self.open_positions 
            if not (p.get('league') == league and p.get('selection') == selection)
        ]

if __name__ == "__main__":
    print("🛡️ Risk Management Engine initialized.")
    # Quick test
    rm = RiskManager(10000)
    print(f"Max stake per match: {rm.max_exposure_per_match*100}% of bankroll")
    stake = rm.calculate_stake(0.55, 2.0)
    print(f"Stake for 55% prob @ 2.0: ${stake}")