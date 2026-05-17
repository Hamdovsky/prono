import numpy as np
import matplotlib.pyplot as plt

class MonteCarloLab:
    def __init__(self, initial_bankroll=10000):
        self.initial_bankroll = initial_bankroll

    def simulate_bankroll(self, win_rates: list, avg_odds: list, bet_sizes: list, simulations=10000):
        """
        Runs Monte Carlo simulations to calculate Risk of Ruin and Expected Drawdown.
        """
        print(f"🎲 Running {simulations} Monte Carlo simulations...")
        
        final_bankrolls = []
        ruin_count = 0
        
        for _ in range(simulations):
            bankroll = self.initial_bankroll
            for i in range(len(win_rates)):
                if bankroll <= 0:
                    break
                    
                stake = bet_sizes[i]
                if np.random.random() <= win_rates[i]:
                    bankroll += stake * (avg_odds[i] - 1)
                else:
                    bankroll -= stake
                    
            if bankroll <= 0:
                ruin_count += 1
            else:
                final_bankrolls.append(bankroll)
                
        risk_of_ruin = ruin_count / simulations
        avg_ending_bankroll = np.mean(final_bankrolls) if final_bankrolls else 0
        
        print(f"📉 Risk of Ruin: {risk_of_ruin * 100:.2f}%")
        print(f"💰 Average Ending Bankroll: ${avg_ending_bankroll:.2f}")
        return risk_of_ruin, avg_ending_bankroll

if __name__ == "__main__":
    lab = MonteCarloLab()
    # Dummy data
    lab.simulate_bankroll([0.55]*1000, [1.90]*1000, [100]*1000)
