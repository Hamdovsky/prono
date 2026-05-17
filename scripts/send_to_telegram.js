const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');

// 🛡️ CONFIGURATION TITANIUM
const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');

async function run() {
    const args = process.argv.slice(2);
    const chatId = args.find(arg => !arg.startsWith('--'));
    
    if (!chatId) {
        console.error("❌ Erreur: Chat ID manquant. Usage: node scripts/send_to_telegram.js <CHAT_ID>");
        process.exit(1);
    }

    const db = new Database(dbPath, { readonly: true });

    console.log("\n" + "=".repeat(60));
    console.log("🚀  TITANIUM V50 ULTRA - FULL DISPATCHER  🚀");
    console.log("=".repeat(60) + "\n");

    try {
        // Récupérer TOUS les pronostics avec confiance > 45%
        const matches = db.prepare(`
            SELECT homeTeam, awayTeam, tournament_name, prediction, confidence, expected_score 
            FROM matches 
            WHERE prediction IS NOT NULL 
            AND confidence >= 45
            ORDER BY confidence DESC
        `).all();

        if (matches.length === 0) {
            console.log("❌ Aucun pronostic trouvé.");
            return;
        }

        console.log(`📦 Traitement de ${matches.length} pronostics...`);

        // Fonction pour découper en morceaux (chunks) pour Telegram (limite 4096 chars)
        const chunkSize = 20; 
        for (let i = 0; i < matches.length; i += chunkSize) {
            const chunk = matches.slice(i, i + chunkSize);
            let telegramMessage = `🏆 *TITANIUM V50 ULTRA - RAPPORT COMPLET (${i + 1}-${Math.min(i + chunkSize, matches.length)})* 🏆\n\n`;

            chunk.forEach(m => {
                const icon = m.confidence >= 70 ? "✅" : "⚡";
                const type = m.prediction === 'SAFE BET' ? "*SAFE*" : "*RISKY*";
                telegramMessage += `${icon} *${m.homeTeam}* vs *${m.awayTeam}*\n`;
                telegramMessage += `🎯 Prono: ${type} (${m.confidence.toFixed(1)}%) | 🔢 Score: ${m.expected_score || '?'}\n\n`;
            });

            telegramMessage += "🤖 _Généré par Titanium V50 AI Engine_";

            console.log(`📡 Envoi du bloc ${Math.floor(i/chunkSize) + 1}...`);
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: telegramMessage,
                parse_mode: 'Markdown'
            });
            
            // Petit délai pour éviter le spam/limit de Telegram
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log("\n" + "=".repeat(60));
        console.log(`✅ ${matches.length} Pronostics envoyés avec succès sur Telegram !`);
        console.log("=".repeat(60) + "\n");

    } catch (err) {
        console.error("❌ Erreur:", err.message);
        if (err.response) console.error("   Détail Telegram:", err.response.data.description);
    } finally {
        db.close();
    }
}

run();
