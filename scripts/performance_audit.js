/**
 * 🚀 TITANIUM AI - PERFORMANCE AUDIT ENGINE (V3.5)
 * -----------------------------------------------
 * This script performs a deep quantitative analysis of the platform's performance.
 * It calculates Strike Rate, ROI, and Profit/Loss segmented by League and Model Confidence.
 */

const database = require('../core/database');
const chalk = require('chalk');

async function runPerformanceAudit() {
    console.log(chalk.blue.bold('\n📊 [AUDIT] Starting Quantitative Performance Audit...'));
    console.log(chalk.gray('--------------------------------------------------'));

    try {
        // 1. Fetch finished matches with predictions and odds
        const query = `
            SELECT id, homeTeam, awayTeam, league, scoreHome, scoreAway, 
                   prediction, confidence, xgboost_confidence,
                   odds_home, odds_draw, odds_away, 
                   home_win_probability, draw_probability, away_win_probability,
                   fullData
            FROM matches 
            WHERE status IN ('FT', 'Finished', 'finished', 'FINISHED')
              AND prediction IS NOT NULL
              AND odds_home IS NOT NULL
            ORDER BY last_updated DESC
            LIMIT 500
        `;

        const { rows } = await database.query(query);

        if (rows.length === 0) {
            console.log(chalk.yellow('⚠️ No finished matches with predictions and odds found for audit.'));
            return;
        }

        let stats = {
            total: 0,
            wins: 0,
            losses: 0,
            totalStaked: 0,
            totalReturn: 0,
            surgical: { total: 0, wins: 0, losses: 0, profit: 0 },
            leagues: {}
        };

        rows.forEach(m => {
            const scoreH = parseInt(m.scoreHome);
            const scoreA = parseInt(m.scoreAway);
            const actualWinner = scoreH > scoreA ? 'H' : scoreH < scoreA ? 'A' : 'D';
            
            // Determine if the prediction was a win
            let isWin = false;
            let odds = 1.0;
            const pred = (m.prediction || '').toLowerCase();
            const homeLower = (m.homeTeam || '').toLowerCase();
            const awayLower = (m.awayTeam || '').toLowerCase();

            // Detect Home Win prediction
            if (pred.includes(homeLower) || pred.includes('🏠') || pred.includes('home') || (pred === '1')) {
                if (actualWinner === 'H') isWin = true;
                odds = parseFloat(m.odds_home || 1.0);
            } 
            // Detect Away Win prediction
            else if (pred.includes(awayLower) || pred.includes('✈️') || pred.includes('away') || (pred === '2')) {
                if (actualWinner === 'A') isWin = true;
                odds = parseFloat(m.odds_away || 1.0);
            }
            // Detect Draw prediction
            else if (pred.includes('draw') || pred.includes('x') || pred.includes('تعادل')) {
                if (actualWinner === 'D') isWin = true;
                odds = parseFloat(m.odds_draw || 1.0);
            }

            // Financial Calculations (Base unit stake = 1.0)
            const stake = 1.0;
            const payout = isWin ? (stake * odds) : 0;
            const profit = payout - stake;

            stats.total++;
            if (isWin) stats.wins++; else stats.losses++;
            stats.totalStaked += stake;
            stats.totalReturn += payout;

            // League Segmentation
            const league = m.league || 'Unknown';
            if (!stats.leagues[league]) {
                stats.leagues[league] = { total: 0, wins: 0, profit: 0 };
            }
            stats.leagues[league].total++;
            if (isWin) stats.leagues[league].wins++;
            stats.leagues[league].profit += profit;

            // Surgical Mode (Confidence > 75% or XGB > 0.8)
            const conf = m.confidence || (m.xgboost_confidence * 100) || 0;
            if (conf >= 75 || m.xgboost_confidence >= 0.78) {
                stats.surgical.total++;
                if (isWin) stats.surgical.wins++; else stats.surgical.losses++;
                stats.surgical.profit += profit;
            }
        });

        // --- REPORT GENERATION ---
        const strikeRate = (stats.wins / stats.total * 100).toFixed(2);
        const roi = ((stats.totalReturn / stats.totalStaked - 1) * 100).toFixed(2);
        const totalProfit = (stats.totalReturn - stats.totalStaked).toFixed(2);

        console.log(chalk.white.bold(`\n🌍 GLOBAL PERFORMANCE (${stats.total} Matches)`));
        console.log(`- Strike Rate : ${chalk.cyan(strikeRate + '%')}`);
        console.log(`- Total Profit: ${totalProfit > 0 ? chalk.green('+' + totalProfit + ' units') : chalk.red(totalProfit + ' units')}`);
        console.log(`- ROI         : ${roi > 0 ? chalk.green(roi + '%') : chalk.red(roi + '%')}`);

        const surgSR = (stats.surgical.wins / stats.surgical.total * 100).toFixed(2);
        const surgProfit = stats.surgical.profit.toFixed(2);
        
        console.log(chalk.magenta.bold(`\n🎯 SURGICAL MODE PERFORMANCE (${stats.surgical.total} High-Confidence Picks)`));
        console.log(`- Strike Rate : ${chalk.cyan(surgSR + '%')}`);
        console.log(`- Net Profit  : ${surgProfit > 0 ? chalk.green('+' + surgProfit + ' units') : chalk.red(surgProfit + ' units')}`);

        console.log(chalk.yellow.bold(`\n🏆 TOP 5 LEAGUES BY PROFIT`));
        Object.entries(stats.leagues)
            .sort((a, b) => b[1].profit - a[1].profit)
            .slice(0, 5)
            .forEach(([name, data]) => {
                const lSr = (data.wins / data.total * 100).toFixed(1);
                console.log(`- ${name.padEnd(25)}: ${chalk.green('+' + data.profit.toFixed(2))} units (${lSr}% SR)`);
            });

        console.log(chalk.red.bold(`\n📉 WORST 3 LEAGUES (STOP BETTING HERE)`));
        Object.entries(stats.leagues)
            .sort((a, b) => a[1].profit - b[1].profit)
            .slice(0, 3)
            .forEach(([name, data]) => {
                console.log(`- ${name.padEnd(25)}: ${chalk.red(data.profit.toFixed(2))} units`);
            });

        console.log(chalk.blue.bold('\n✨ Audit Complete.\n'));

    } catch (error) {
        console.error(chalk.red('❌ Audit Failed:'), error);
    }
}

runPerformanceAudit();
