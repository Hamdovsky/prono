const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');
const IntegrityService = require('../services/integrity_service');

// 🛡️ CONFIGURATION TITANIUM
const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const CHAT_ID = '5637790630';
const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');

async function runGolden50() {
    const db = new Database(dbPath, { readonly: true });
    
    console.log("\n" + "=".repeat(60));
    console.log("🌟  TITANIUM GOLDEN 50 - QUALITY OVER QUANTITY  🌟");
    console.log("=".repeat(60) + "\n");

    try {
        // 1. Fetch all available matches for the upcoming window
        const allMatches = db.prepare(`
            SELECT * FROM matches 
            WHERE status IN ('scheduled', 'NOT_STARTED', 'NS')
            AND (date(datetime(startTimestamp, 'unixepoch')) >= date('now'))
            ORDER BY startTimestamp ASC
        `).all();

        if (allMatches.length === 0) {
            console.log("⚠️ Aucun match trouvé dans la base de données.");
            return;
        }

        console.log(`🔍 Analyse de ${allMatches.length} matchs pour extraire le "Golden 50"...`);

        const analyzed = [];
        for (const m of allMatches) {
            // Parse DB probabilities (stored as 0-100)
            const pH = parseFloat(m.home_win_probability) || 33;
            const pD = parseFloat(m.draw_probability) || 33;
            const pA = parseFloat(m.away_win_probability) || 33;
            const pOU25 = parseFloat(m.ou_25_prob) || 50;
            const pBTTS = parseFloat(m.btts_prob) || 50;
            const pHT05 = Math.min(95, 60 + (pOU25 * 0.2));

            const markets = [
                { type: '1X2', prob: Math.max(pH, pA), label: pH > pA ? `فوز ${m.homeTeam}` : `فوز ${m.awayTeam}` },
                { type: 'BTTS', prob: pBTTS, label: 'كلا الفريقين يسجل (BTTS)' },
                { type: 'Over 2.5', prob: pOU25, label: 'أكثر من 2.5 هدف' },
                { type: 'HT 0.5', prob: pHT05, label: 'هدف في الشوط الأول (HT 0.5)' }
            ];
            markets.sort((a, b) => b.prob - a.prob);
            const strongest = markets[0];
            const fallback = markets[1];

            // Integrity Analysis
            const modelPreds = { home_win_probability: pH / 100, draw_probability: pD / 100, away_win_probability: pA / 100 };
            const integrity = await IntegrityService.analyzeMatch(m, modelPreds, {});

            // Quality Score
            const qualityScore = strongest.prob * (1 - (integrity.score / 100));

            analyzed.push({
                ...m,
                strongest,
                fallback,
                integrity,
                qualityScore,
                confidence: Math.round(strongest.prob)
            });
        }

        // Filtering: Surgical Quality Filter
        const filtered = analyzed.filter(a => {
            if (a.integrity.trafficLight === 'RED') return false;          // 🔴 No suspicious matches
            if (a.integrity.trafficLight === 'YELLOW' && a.integrity.score > 18) return false; // Strict yellow
            if (a.confidence < 65) return false;                           // 🟢 Relaxed: 68 → 65 for volume
            if (a.integrity.score > 25) return false;                      // 🟢 Relaxed: 22 → 25
            // Require at least one dominant side (prob > 52%)
            const domProb = Math.max(a.strongest.prob, 0);
            if (domProb < 52) return false;
            return true;
        });

        // 3. Selection: Take Top 50 by Quality Score
        filtered.sort((a, b) => b.qualityScore - a.qualityScore);
        const golden50 = filtered.slice(0, 50);

        console.log(`✅ ${golden50.length} matchs sélectionnés pour le rapport final.`);

        // 4. Dispatch to Telegram
        const chunkSize = 10; // Smaller chunks for premium feel
        for (let i = 0; i < golden50.length; i += chunkSize) {
            const chunk = golden50.slice(i, i + chunkSize);
            let message = `🌟 *TITANIUM GOLDEN 50 - النخبة المختارة* 🌟\n`;
            message += `📈 *الهدف:* الجودة العالية والحد من المخاطر\n`;
            message += `📦 *المجموعة:* ${Math.floor(i/chunkSize) + 1}\n\n`;

            chunk.forEach(m => {
                const integrityIcon = m.integrity.trafficLight === 'GREEN' ? "✅" : "⚠️";
                // Confidence tier badge
                let tierBadge = "";
                if (m.confidence >= 85)      tierBadge = "🔥🔥 TRÈS SÛR";
                else if (m.confidence >= 78) tierBadge = "🔥 SÛR";
                else if (m.confidence >= 68) tierBadge = "✅ BON";
                else                          tierBadge = "📊";

                message += `${integrityIcon} *${m.homeTeam}* vs *${m.awayTeam}*\n`;
                message += `🎯 *Pick:* ${m.strongest.label}  |  *Backup:* ${m.fallback.label}\n`;
                message += `📊 *Confiance:* ${m.confidence}%  ${tierBadge}  |  *Qualité:* ${Math.round(m.qualityScore)}/100\n\n`;
            });

            message += `🤖 _Généré par Titanium Quality Engine v4.5_`;

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            }).catch(e => console.error("Telegram Error:", e.response?.data?.description || e.message));

            await new Promise(resolve => setTimeout(resolve, 2000));
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        db.close();
    }
}

runGolden50();
