const database = require('../core/database');
const botService = require('../services/botService');

async function main() {
    try {
        console.log("🚀 Starting Quick Send for 18 April...");

        // 1. Send Promosport Ticket
        console.log("📡 Sending Promosport AI Ticket...");
        await botService._handlePromosport(botService.chatId);

        // 2. Generate and Send Mega Pronostic from DB
        console.log("📡 Generating Mega Pronostic from existing DB data...");
        
        const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS', 'LIVE', 'IN_PROGRESS']);
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
        
        const todaysMatches = matches.filter(m => {
            let ts = m.startTimestamp ? m.startTimestamp * 1000 : (m.timestamp ? new Date(m.timestamp).getTime() : 0);
            return ts >= startOfDay && ts <= endOfDay;
        });

        const enriched = todaysMatches.filter(m => m.home_win_probability > 0);
        console.log(`📊 Found ${todaysMatches.length} matches, ${enriched.length} enriched.`);

        if (enriched.length === 0) {
            await botService.sendAlert("⚠️ Aucun match enrichi trouvé pour aujourd'hui dans la base de données.");
            return;
        }

        let vipPicks = enriched.map(m => {
            const winProb = Math.max(m.home_win_probability || 0, m.away_win_probability || 0);
            const winner = m.home_win_probability > m.away_win_probability ? m.homeTeam : m.awayTeam;
            return {
                home: m.homeTeam,
                away: m.awayTeam,
                league: m.league || m.tournament || 'Unknown',
                winner: winner,
                prob: winProb,
                score: m.expected_score || '? - ?'
            };
        });

        // Filter for high confidence
        const filteredVips = vipPicks.filter(p => p.prob >= 65).sort((a, b) => b.prob - a.prob);
        const topPicks = filteredVips.slice(0, 15);

        let reportMsg = `🔥 <b>TITANIUM MEGA DAILY PRONOSTIC</b> 🔥\n\n`;
        reportMsg += `📅 <b>Date:</b> 2026-04-18\n`;
        reportMsg += `🤖 <i>Powered by Titanium AI Force</i>\n\n`;

        const vipByLeague = {};
        topPicks.forEach(p => {
            if (!vipByLeague[p.league]) vipByLeague[p.league] = [];
            vipByLeague[p.league].push(p);
        });

        for (const lg in vipByLeague) {
            reportMsg += `🌍 <b>${lg}</b>\n`;
            vipByLeague[lg].forEach(p => {
                reportMsg += `⚔️ ${p.home} vs ${p.away}\n`;
                reportMsg += `   └ 🎯 <b>Winner:</b> ${p.winner} (${p.prob.toFixed(1)}%)\n`;
                reportMsg += `   └ ⚽ <b>Score:</b> ${p.score}\n\n`;
            });
        }

        reportMsg += `💎 <i>VIP Exclusive Intelligence</i>`;

        console.log("📡 Sending Pronostic Report...");
        await botService.sendAlert(reportMsg);
        
        console.log("✅ Quick Send Completed!");
    } catch (e) {
        console.error("❌ Error:", e);
    }
    process.exit(0);
}

main();
