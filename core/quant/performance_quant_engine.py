import math
import json
import argparse
from datetime import datetime

class PerformanceQuantEngine:
    def __init__(self, trades):
        """
        trades: list of dicts with keys: ['pnl', 'stake', 'clv', 'timestamp']
        """
        self.trades = trades
        self.total_trades = len(trades)
        
    def calculate_yield(self):
        total_stake = sum(t['stake'] for t in self.trades)
        total_pnl = sum(t['pnl'] for t in self.trades)
        if total_stake == 0: return 0.0
        return (total_pnl / total_stake) * 100

    def calculate_roi(self, initial_bankroll=100.0):
        total_pnl = sum(t['pnl'] for t in self.trades)
        return (total_pnl / initial_bankroll) * 100

    def calculate_sharpe_ratio(self, risk_free_rate=0.0):
        if self.total_trades < 2: return 0.0
        returns = [t['pnl'] / t['stake'] if t['stake'] > 0 else 0 for t in self.trades]
        avg_return = sum(returns) / len(returns)
        variance = sum((r - avg_return) ** 2 for r in returns) / (len(returns) - 1)
        std_dev = math.sqrt(variance)
        if std_dev == 0: return 0.0
        # Sharpe = (R_p - R_f) / std_p
        # Annualizing would require knowing the time period, but for betting we use per-trade or per-day
        return (avg_return - risk_free_rate) / std_dev

    def calculate_max_drawdown(self):
        if not self.trades: return 0.0
        
        cumulative_pnl = 0
        peak = 0
        max_dd = 0
        
        for t in self.trades:
            cumulative_pnl += t['pnl']
            if cumulative_pnl > peak:
                peak = cumulative_pnl
            
            drawdown = peak - cumulative_pnl
            if drawdown > max_dd:
                max_dd = drawdown
                
        return max_dd

    def calculate_clv_efficiency(self):
        if not self.trades: return 0.0
        avg_clv = sum(t['clv'] for t in self.trades) / self.total_trades
        return avg_clv * 100

    def get_summary(self):
        if self.total_trades == 0:
            return {"status": "no_data"}
            
        return {
            "total_trades": self.total_trades,
            "yield_pct": round(self.calculate_yield(), 2),
            "sharpe_ratio": round(self.calculate_sharpe_ratio(), 2),
            "max_drawdown": round(self.calculate_max_drawdown(), 2),
            "clv_efficiency_pct": round(self.calculate_clv_efficiency(), 2),
            "win_rate": round(sum(1 for t in self.trades if t['pnl'] > 0) / self.total_trades * 100, 2)
        }

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Quantitative Performance Engine')
    parser.add_argument('--trades', type=str, required=True, help='JSON list of trades')
    
    args = parser.parse_args()
    try:
        trades_data = json.loads(args.trades)
        engine = PerformanceQuantEngine(trades_data)
        print(json.dumps({
            "status": "success",
            "metrics": engine.get_summary()
        }))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
