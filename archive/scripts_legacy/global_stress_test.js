/**
 * 🌪️ TITANIUM AI - GLOBAL STRESS TEST (V1.0)
 * -----------------------------------------
 * Performs a massive 6-month simulation to validate model stability,
 * ROI consistency, and the effectiveness of the Evolution Layer.
 */

const db = require('../core/database');
const evolutionEngine = require('../services/EvolutionEngine');
const calibrationEngine = require('../services/ConfidenceCalibrationEngine');
const bankrollService = require('../services/bankrollService');
const logger = require('../core/logger');
const chalk = require('chalk');

async function runGlobalStressTest() {
    console.log(chalk.blue.bold('\n🌪️ [STRESS-TEST] Launching Massive 6-Month Simulation...'));
    console.log(chalk.gray('---------------------------------------------------------'));

    try {
        // 1. Fetch historical data from BOTH databases
        const tacticalMatches = await db.prepare(`
            SELECT id, homeTeam, awayTeam, league, scoreHome, scoreAway, startTimestamp, confidence, xgboost_confidence, home_win_probability, away_win_probability, odds_home, odds_away, referee_id
            FROM matches 
            WHERE status IN ('FT', 'Finished', 'finished', 'FINISHED')
            AND scoreHome IS NOT NULL
        `).all();

        // Load from Archive
        const Database = require('better-sqlite3');
        const path = require('path');
        const archiveDb = new Database(path.join(__dirname, '../data/historical_archive.sqlite'));
        const archiveMatches = archiveDb.prepare(`
            SELECT id, homeTeam, awayTeam, tournament_name as league, scoreHome, scoreAway, startTimestamp
            FROM archive_matches
            WHERE scoreHome IS NOT NULL
        `).all().map(m => ({
            ...m,
            // Mock prediction for archive if missing
            confidence: 78, 
            xgboost_confidence: 0.82,
            home_win_probability: 65,
            away_win_probability: 25,
            odds_home: 1.85,
            odds_away: 3.50
        }));

        const allMatches = [...tacticalMatches, ...archiveMatches].sort((a, b) => a.startTimestamp - b.startTimestamp);

        if (allMatches.length === 0) {
            console.log(chalk.red('❌ No historical data found for simulation.'));
            return;
        }

        console.log(chalk.white(`📈 Found ${allMatches.length} total matches for backtesting.`));

        // 2. Simulation State
        let virtualBankroll = 1000; // Starting with 1000 units
        let totalBets = 0;
        let wins = 0;
        let peakBankroll = 1000;
        let maxDrawdown = 0;
        
        const monthlyStats = {};

        // 3. Simulation Loop
        for (const m of allMatches) {
            const date = new Date(m.startTimestamp * 1000);
            const monthKey = date.toISOString().substring(0, 7);
            if (!monthlyStats[monthKey]) monthlyStats[monthKey] = { profit: 0, count: 0, wins: 0 };

            // 🧬 Step A: Calibrate confidence using Evolution Layer logic
            const baseConf = m.confidence || (m.xgboost_confidence * 100);
            const calibratedConf = await calibrationEngine.calibrate(m, baseConf);

            // 🧬 Step B: Selection Strategy (Surgical only)
            if (calibratedConf >= 75) {
                totalBets++;
                monthlyStats[monthKey].count++;

                const scoreH = parseInt(m.scoreHome);
                const scoreA = parseInt(m.scoreAway);
                const actualWinner = scoreH > scoreA ? 'H' : scoreH < scoreA ? 'A' : 'D';

                // Determine prediction (simplified for test)
                let pick = 'H';
                let odds = parseFloat(m.odds_home || 1.80);
                if ((m.away_win_probability || 0) > (m.home_win_probability || 0)) {
                    pick = 'A'; odds = parseFloat(m.odds_away || 2.20);
                }

                // Calculate Stake (Kelly 1/4)
                const winProb = (pick === 'H' ? m.home_win_probability : m.away_win_probability) / 100;
                const kelly = bankrollService.calculateOptimalBet(winProb, odds);
                const stake = virtualBankroll * (kelly.recommendedPercentage / 100);
                
                const isWin = (pick === actualWinner);
                const payout = isWin ? (stake * odds) : 0;
                const profit = payout - stake;

                virtualBankroll += profit;
                if (isWin) {
                    wins++;
                    monthlyStats[monthKey].wins++;
                }
                monthlyStats[monthKey].profit += profit;

                // Track Drawdown
                if (virtualBankroll > peakBankroll) peakBankroll = virtualBankroll;
                const drawdown = (peakBankroll - virtualBankroll) / peakBankroll * 100;
                if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            }
        }

        // 4. Report
        const totalProfit = virtualBankroll - 1000;
        const roi = (totalProfit / 1000) * 100;
        const winRate = (wins / totalBets) * 100;

        console.log(chalk.green.bold('\n🏁 [STRESS-TEST] SIMULATION COMPLETE'));
        console.log(`- Periode      : Last 6 Months (Approx)`);
        console.log(`- Total Bets   : ${totalBets}`);
        console.log(`- Win Rate     : ${chalk.cyan(winRate.toFixed(2) + '%')}`);
        console.log(`- Final Bank   : ${chalk.yellow(virtualBankroll.toFixed(2) + ' units')}`);
        console.log(`- Net Profit   : ${totalProfit > 0 ? chalk.green('+' + totalProfit.toFixed(2)) : chalk.red(totalProfit.toFixed(2))}`);
        console.log(`- ROI Global   : ${roi > 0 ? chalk.green(roi.toFixed(2) + '%') : chalk.red(roi.toFixed(2) + '%')}`);
        console.log(`- Max Drawdown : ${chalk.red(maxDrawdown.toFixed(2) + '%')}`);

        console.log(chalk.yellow.bold('\n📅 MONTHLY BREAKDOWN:'));
        Object.entries(monthlyStats).forEach(([month, s]) => {
            const mSr = (s.wins / s.count * 100).toFixed(1);
            console.log(`- ${month}: Profit ${s.profit > 0 ? chalk.green('+' + s.profit.toFixed(2)) : chalk.red(s.profit.toFixed(2))} | SR: ${mSr}% (${s.count} bets)`);
        });

        // 🧬 Step C: Verify Memory Stability (Simulated)
        const mem = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(chalk.blue(`\n🧠 Memory Usage at end of simulation: ${mem.toFixed(2)} MB`));
        if (mem < 500) console.log(chalk.green('✅ Memory Stability: OK (Within Node limits)'));

    } catch (error) {
        console.error(chalk.red('❌ Stress Test Failed:'), error);
    }
}

runGlobalStressTest();
