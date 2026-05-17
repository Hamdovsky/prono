const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');
const autopsyService = require('../services/autopsyService');
const adaptiveLearning = require('../services/adaptiveLearningEngine');

const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const CHAT_ID = '5637790630';
const dbPath = path.join(__dirname, '..', 'data', 'tactical.db');

function isPredictionCorrect(prediction, scoreH, scoreA) {
    if (scoreH === null || scoreA === null) return false;
    const pred = (prediction || '').toLowerCase();
    const totalGoals = scoreH + scoreA;

    // 1X2 Logic
    if (pred.includes('home') || pred === '1') return scoreH > scoreA;
    if (pred.includes('away') || pred === '2') return scoreA > scoreH;
    if (pred.includes('draw') || pred.toLowerCase() === 'x') return scoreH === scoreA;

    // Over/Under Logic
    if (pred.includes('over 2.5') || pred.includes('+2.5')) return totalGoals > 2.5;
    if (pred.includes('under 2.5') || pred.includes('-2.5')) return totalGoals < 2.5;
    if (pred.includes('over 1.5') || pred.includes('+1.5')) return totalGoals > 1.5;
    if (pred.includes('under 1.5') || pred.includes('-1.5')) return totalGoals < 1.5;

    // BTTS Logic
    if (pred.includes('btts') || pred.includes('both teams')) return scoreH > 0 && scoreA > 0;

    return false;
}

async function runResultsReport() {
    const db = new Database(dbPath, { readonly: true });
    
    try {
        // Fetch matches finished in the last 12h
        const matches = db.prepare(`
            SELECT * FROM matches 
            WHERE status IN ('FINISHED', 'FT', 'Ended', 'AET', 'PEN')
            AND scoreHome IS NOT NULL 
            AND scoreAway IS NOT NULL
            AND datetime(timestamp, 'unixepoch') >= datetime('now', '-12 hours')
            ORDER BY timestamp DESC
        `).all();

        if (matches.length === 0) {
            console.log("No finished matches in the last 12h.");
            return;
        }

        let message = `📊 *TITANIUM AUTO-AUTOPSY & RESULTS*\n`;
        message += `📅 Date: ${new Date().toLocaleDateString()}\n`;
        message += `🧠 _Le système apprend de chaque erreur pour les prochaines ligues._\n\n`;

        for (const m of matches) {
            const h = m.scoreHome;
            const a = m.scoreAway;
            const total = h + a;
            
            // 1. SMART PICK (Strongest 1X2)
            const smartCorrect = isPredictionCorrect(m.prediction, h, a);
            const smartIcon = smartCorrect ? '🟢' : '🔴';

            // 2. CS (AI) - Exact Score
            let csPred = m.expected_score || "";
            if (!csPred && m.fullData) {
                try { csPred = JSON.parse(m.fullData).expected_score || ""; } catch(e){}
            }
            const csCorrect = (csPred === `${h}-${a}`);
            const csIcon = csCorrect ? '🟢' : '🔴';

            // 3. TG (O/U) - Total Goals
            const ouPred = m.ou_25_prob > 50 ? "Over 2.5" : "Under 2.5";
            const ouCorrect = (ouPred === "Over 2.5") ? (total > 2.5) : (total < 2.5);
            const ouIcon = ouCorrect ? '🟢' : '🔴';

            message += `⚽ *${m.homeTeam} vs ${m.awayTeam}* (${h}-${a})\n`;
            message += `${smartIcon} *SMART PICK:* ${m.prediction}\n`;
            message += `${csIcon} *CS (AI):* ${csPred || 'N/A'}\n`;
            message += `${ouIcon} *TG (O/U):* ${ouPred}\n`;

            // 🔬 AUTOPSY for failed Smart Picks
            if (!smartCorrect) {
                const diagnosis = await autopsyService.diagnoseMatch(m.id);
                if (diagnosis && diagnosis.ar) {
                    message += `🧐 *تحليل الخسارة:* ${diagnosis.ar}\n`;
                    message += `🔄 _تم تحديث أوزان الدوري (${m.tournament_name}) لنتفادى هذا مستقبلاً._\n`;
                }
                // Trigger learning immediately for this match
                try {
                    await adaptiveLearning.learn(m);
                } catch(e) { console.error("Learning error:", e.message); }
            }
            message += `\n`;
        }

        message += `🤖 _Titanium Intelligence Artificielle v5.0_`;

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });

        console.log(`✅ Results report sent (${matches.length} matches).`);

    } catch (err) {
        console.error("Error:", err.message);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    runResultsReport();
}
