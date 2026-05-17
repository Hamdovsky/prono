const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');
const botService = require('../services/botService');
const logger = require('../core/logger');

/**
 * Runs the daily mega pronostic.
 * @param {boolean} executeBotAlert - Whether to trigger the botService alert globally.
 * @returns {Promise<object>} Returns an object with the VIP picks and all processed matches by league.
 */
async function runDailyMegaPronostic(executeBotAlert = true) {
    console.log('\n=======================================================');
    console.log('🚀 [TITANIUM AI] STARTING DAILY MEGA PRONOSTIC');
    console.log('=======================================================\n');
    
    try {
        // 1. Get all scheduled matches
        const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        
        // Filter matches that are happening today
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
        
        const todaysMatches = matches.filter(m => {
            let ts = m.startTimestamp ? m.startTimestamp * 1000 : (m.timestamp ? new Date(m.timestamp).getTime() : 0);
            return ts >= startOfDay && ts <= endOfDay;
        });

        console.log(`📊 Found ${todaysMatches.length} matches for today. Commencing deep analysis...`);
        
        if (todaysMatches.length === 0) {
            console.log('✅ No matches to process for today.');
            return { vipPicks: [], allByLeague: {} };
        }

        let vipPicks = [];
        let allByLeague = {};
        let count = 0;

        for (const m of todaysMatches) {
            try {
                const enriched = await enrichedPredictions.enrichMatch({...m});
                
                const winProb = Math.max(enriched.home_win_probability || 0, enriched.away_win_probability || 0);
                const isConfirmed = enriched.xgboost_confidence >= 0.70 || winProb >= 65 || (enriched.enriched && enriched.enriched.confidence >= 65);
                
                // Save to database
                const data = {
                    home_win_probability: enriched.home_win_probability || 0,
                    draw_probability: enriched.draw_probability || 0,
                    away_win_probability: enriched.away_win_probability || 0,
                    expected_score: enriched.expected_score || '? - ?',
                    chaos_score: enriched.chaos_score || 50,
                    ou_25_prob: enriched.ou_25_prob || 0,
                    btts_prob: enriched.btts_prob || 0,
                    xgboost_confidence: enriched.xgboost_confidence || 0,
                };
                await database.updatePredictions(m.id, data);

                const winner = enriched.home_win_probability > enriched.away_win_probability ? m.homeTeam : m.awayTeam;
                
                const pickData = {
                    home: m.homeTeam,
                    away: m.awayTeam,
                    league: m.league || 'Unknown',
                    winner: winner,
                    prob: winProb,
                    score: enriched.expected_score || '? - ?',
                    isTrap: enriched.enriched?.trap_alert || false,
                    trapDetails: enriched.enriched?.trap_details || null
                };

                // Add to VIP if confident AND NOT A TRAP
                if (isConfirmed && !pickData.isTrap) {
                    vipPicks.push(pickData);
                } else if (isConfirmed && pickData.isTrap) {
                    // It was a VIP pick, but it's a trap. We should still report it to save the user from betting it.
                    vipPicks.push(pickData);
                }

                // Add to All by league
                if (!allByLeague[pickData.league]) {
                    allByLeague[pickData.league] = [];
                }
                allByLeague[pickData.league].push(pickData);
                
                count++;
                if (count % 10 === 0) {
                    console.log(`✅ Processed ${count}/${todaysMatches.length} matches...`);
                }
            } catch (e) {
                console.error(`❌ Error enriching match ${m.homeTeam} vs ${m.awayTeam}: ${e.message}`);
            }
        }
        
        // Sort by probability descending
        vipPicks.sort((a, b) => b.prob - a.prob);
        // Sort leagues by match count
        for (let lg in allByLeague) {
            allByLeague[lg].sort((a, b) => b.prob - a.prob);
        }

        const topPicks = vipPicks.slice(0, 50);

        console.log(`\n=======================================================`);
        console.log(`🏆 DAILY VIP PICKS GENERATED (${topPicks.length} high confidence matches)`);
        console.log(`=======================================================\n`);
        
        let reportMsg = '';
        if (topPicks.length > 0) {
            reportMsg = `🔥 <b>TITANIUM MEGA DAILY PRONOSTIC (TOP 50)</b> 🔥\n\n`;
            reportMsg += `📅 <b>Date:</b> ${now.toISOString().split('T')[0]}\n`;
            reportMsg += `🤖 <i>Powered by full Titanium AI Forces</i>\n\n`;
            
            // On group les VIP par league dans le report pour une meilleure clarté
            const vipByLeague = {};
            topPicks.forEach(p => {
                if (!vipByLeague[p.league]) vipByLeague[p.league] = [];
                vipByLeague[p.league].push(p);
            });

            for (const lg in vipByLeague) {
                reportMsg += `🌍 <b>${lg}</b>\n`;
                vipByLeague[lg].forEach(p => {
                    reportMsg += `⚔️ ${p.home} vs ${p.away}\n`;
                    if (p.isTrap) {
                        reportMsg += `   └ 🛑 <b>TRAP DETECTED:</b> DANGER - ${p.trapDetails}\n`;
                    } else {
                        reportMsg += `   └ 🎯 <b>Winner:</b> ${p.winner} (${p.prob.toFixed(1)}%)\n`;
                        reportMsg += `   └ ⚽ <b>Score:</b> ${p.score}\n`;
                    }
                    reportMsg += `\n`;
                });
            }

            reportMsg += `💎 <i>VIP Exclusive Intelligence</i>`;
            
            if (executeBotAlert) {
                botService.sendAlert(reportMsg);
                console.log('\n📲 Report sent to Telegram successfully.');
            }
        } else {
            console.log('⚠️ No high confidence matches found for today.');
            reportMsg = `⚠️ <b>TITANIUM MEGA DAILY PRONOSTIC</b>\n\nNo high confidence matches found for today using strict constraints. Preserving bankroll.`;
            if (executeBotAlert) {
                botService.sendAlert(reportMsg);
            }
        }

        console.log('\n✅ Task completed.');
        return { vipPicks: topPicks, allByLeague, reportMsg };

    } catch (e) {
        console.error('❌ Critical Error in Daily Mega Pronostic:', e);
        throw e;
    }
}

// Execute normally if run directly from terminal/cron
if (require.main === module) {
    runDailyMegaPronostic(true).then(() => {
        process.exit(0);
    }).catch(e => {
        process.exit(1);
    });
}

module.exports = { runDailyMegaPronostic };
