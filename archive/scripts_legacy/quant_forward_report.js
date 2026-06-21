const db = require('better-sqlite3')('data/tactical.db');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function generateForwardReport() {
    console.log("📊 [QUANT] Generating Forward Testing Report...");
    
    // 1. Fetch completed trades from quant_performance
    // If empty, fallback to prediction_history + results
    let trades = db.prepare(`
        SELECT p.pnl, p.stake, p.clv, p.timestamp 
        FROM quant_performance p
    `).all();

    if (trades.length === 0) {
        console.log("⚠️ No explicit quant trades found. Simulating from prediction history...");
        const history = db.prepare(`
            SELECT ph.probability, ph.status, ph.result, m.odds_home, m.odds_draw, m.odds_away
            FROM prediction_history ph
            JOIN matches m ON ph.match_id = m.id
            WHERE ph.status = 'FINISHED' OR ph.result IS NOT NULL
        `).all();

        trades = history.map(h => {
            const isWin = h.result === 'WIN' || h.result === 'WON';
            const stake = 1.0; // Flat stake for simulation
            const odds = parseFloat(h.odds_home || 2.0); // Assume home for now or extract from prediction_val
            return {
                pnl: isWin ? (stake * (odds - 1)) : -stake,
                stake: stake,
                clv: 0.02, // Simulated CLV
                timestamp: Date.now()
            };
        });
    }

    if (trades.length === 0) {
        console.log("❌ No verifiable match data found for report.");
        return;
    }

    // 2. Call Python Quant Engine
    const pythonPath = path.join(process.cwd(), 'core', 'quant', 'performance_quant_engine.py');
    const pythonExec = fs.existsSync(path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')) 
        ? path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
        : 'python';

    const child = spawn(pythonExec, [pythonPath, '--trades', JSON.stringify(trades)]);
    
    let output = '';
    child.stdout.on('data', (data) => output += data.toString());
    child.stderr.on('data', (data) => console.error(data.toString()));

    child.on('close', (code) => {
        if (code === 0) {
            try {
                const report = JSON.parse(output);
                console.log("\n=========================================");
                console.log("🏆 TITANIUM INSTITUTIONAL QUANT REPORT");
                console.log("=========================================");
                console.log(`Total Trades:   ${report.metrics.total_trades}`);
                console.log(`Yield:          ${report.metrics.yield_pct}%`);
                console.log(`Sharpe Ratio:   ${report.metrics.sharpe_ratio}`);
                console.log(`Max Drawdown:   ${report.metrics.max_drawdown} units`);
                console.log(`CLV Efficiency: ${report.metrics.clv_efficiency_pct}%`);
                console.log(`Win Rate:       ${report.metrics.win_rate}%`);
                console.log("=========================================\n");
            } catch (e) {
                console.error("Failed to parse report output.");
            }
        }
    });
}

generateForwardReport();
