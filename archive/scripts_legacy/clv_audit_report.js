/**
 * 📉 TITANIUM AI - ADVANCED CLV PERFORMANCE REPORT (V1.0)
 * ------------------------------------------------------
 * This script analyzes how well the Titanium model beats the market.
 * It identifies the leagues where we have the strongest predictive edge
 * and correlates CLV with actual Strike Rate.
 */

const database = require('../core/database');
const chalk = require('chalk');

async function runCLVAudit() {
    console.log(chalk.blue.bold('\n📉 [CLV AUDIT] Starting Market Advantage Analysis...'));
    console.log(chalk.gray('----------------------------------------------------'));

    try {
        // Query matches that have a calculated CLV value and a final score
        const query = `
            SELECT id, homeTeam, awayTeam, league, scoreHome, scoreAway, 
                   prediction, confidence, clv_value,
                   odds_home_open, odds_home as odds_home_close
            FROM matches 
            WHERE clv_value IS NOT NULL
              AND status IN ('FT', 'Finished', 'finished', 'FINISHED')
            ORDER BY startTimestamp DESC
        `;

        const { rows } = await database.query(query);

        if (rows.length === 0) {
            console.log(chalk.yellow('⚠️ No matches with CLV data found. The CLV Service needs to run for upcoming matches first.'));
            return;
        }

        let stats = {
            total: 0,
            clvPlusCount: 0, // Number of times we beat the closing line
            avgClv: 0,
            wins: 0,
            leagues: {}
        };

        rows.forEach(m => {
            const clv = parseFloat(m.clv_value);
            const isWin = isMatchWon(m);
            
            stats.total++;
            if (clv > 0) stats.clvPlusCount++;
            stats.avgClv += clv;
            if (isWin) stats.wins++;

            // League segmentation
            const lg = m.league || 'Other';
            if (!stats.leagues[lg]) {
                stats.leagues[lg] = { total: 0, clvPlus: 0, sumClv: 0, wins: 0 };
            }
            stats.leagues[lg].total++;
            if (clv > 0) stats.leagues[lg].clvPlus++;
            stats.leagues[lg].sumClv += clv;
            if (isWin) stats.leagues[lg].wins++;
        });

        // --- GLOBAL REPORT ---
        const clvPlusRate = (stats.clvPlusCount / stats.total * 100).toFixed(2);
        const globalAvgClv = (stats.avgClv / stats.total * 100).toFixed(2);
        const strikeRate = (stats.wins / stats.total * 100).toFixed(2);

        console.log(chalk.white.bold(`\n🌍 GLOBAL CLV METRICS (${stats.total} Matches Reviewed)`));
        console.log(`- CLV+ Beat Rate : ${clvPlusRate >= 50 ? chalk.green(clvPlusRate + '%') : chalk.yellow(clvPlusRate + '%')}`);
        console.log(`- Average CLV    : ${globalAvgClv >= 0 ? chalk.green('+' + globalAvgClv + '%') : chalk.red(globalAvgClv + '%')}`);
        console.log(`- Global Strike  : ${chalk.cyan(strikeRate + '%')}`);

        // --- STRATEGY INSIGHT ---
        if (globalAvgClv > 2.0 && strikeRate < 45) {
            console.log(chalk.magenta(`\n💡 INSIGHT: Your model is BEATING the market significantly (+${globalAvgClv}%), but your strike rate is low. This suggests a period of high variance (bad luck). Mathematically, your profit should explode soon.`));
        } else if (globalAvgClv < -1.0 && strikeRate > 60) {
            console.log(chalk.red(`\n⚠️ WARNING: Your strike rate is high, but you are LOSING to the market line (${globalAvgClv}%). You are currently in a "lucky streak" that is not mathematically sustainable.`));
        }

        // --- LEAGUE BREAKDOWN ---
        console.log(chalk.yellow.bold(`\n🏆 LEAGUES WITH BEST MARKET EDGE (TOP CLV)`));
        Object.entries(stats.leagues)
            .sort((a, b) => (b[1].sumClv / b[1].total) - (a[1].sumClv / a[1].total))
            .slice(0, 5)
            .forEach(([name, data]) => {
                const avg = (data.sumClv / data.total * 100).toFixed(2);
                const sr = (data.wins / data.total * 100).toFixed(1);
                console.log(`- ${name.padEnd(25)}: ${chalk.green('+' + avg + '%')} CLV | ${sr}% Strike Rate`);
            });

        console.log(chalk.blue.bold('\n✨ CLV Audit Complete.\n'));

    } catch (error) {
        console.error(chalk.red('❌ CLV Audit Failed:'), error);
    }
}

function isMatchWon(m) {
    const scoreH = parseInt(m.scoreHome);
    const scoreA = parseInt(m.scoreAway);
    const actualWinner = scoreH > scoreA ? 'H' : scoreH < scoreA ? 'A' : 'D';
    
    const pred = (m.prediction || '').toLowerCase();
    const homeLower = (m.homeTeam || '').toLowerCase();
    const awayLower = (m.awayTeam || '').toLowerCase();

    if ((pred.includes(homeLower) || pred.includes('home')) && actualWinner === 'H') return true;
    if ((pred.includes(awayLower) || pred.includes('away')) && actualWinner === 'A') return true;
    if ((pred.includes('draw') || pred.includes('تعادل')) && actualWinner === 'D') return true;
    
    return false;
}

runCLVAudit();
