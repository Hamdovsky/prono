const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');

// 🛡️ CONFIGURATION TITANIUM
const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');
const db = new Database(dbPath, { readonly: true });

async function getPronos() {
    console.log("\n" + "=".repeat(60));
    console.log("🚀  TITANIUM V50 ULTRA - SURGICAL PREDICTIONS REPORT  🚀");
    console.log("=".repeat(60) + "\n");

    try {
        // Récupérer les 30 derniers pronostics
        const matches = db.prepare(`
            SELECT homeTeam, awayTeam, tournament_name, prediction, confidence, expected_score, last_updated 
            FROM matches 
            WHERE prediction IS NOT NULL 
            AND confidence > 45
            ORDER BY last_updated DESC 
            LIMIT 30
        `).all();

        if (matches.length === 0) {
            console.log("❌ Aucun pronostic trouvé dans la base de données tactique.");
            return;
        }

        let telegramMessage = "🏆 *TITANIUM SURGICAL PRONOSTICS* 🏆\n\n";

        matches.forEach((m, i) => {
            const date = new Date(m.last_updated).toLocaleString('fr-FR');
            const score = m.expected_score || "N/A";
            
            console.log(`[${i + 1}] ⚽ ${m.homeTeam} vs ${m.awayTeam}`);
            console.log(`    🏆 Ligue: ${m.tournament_name || 'Inconnue'}`);
            console.log(`    🎯 Marché: ${m.prediction}`);
            console.log(`    📊 Confiance: ${m.confidence.toFixed(1)}%`);
            console.log(`    🔢 Score Exact: ${score}`);
            console.log(`    🕒 Mis à jour: ${date}\n`);

            telegramMessage += `⚽ *${m.homeTeam}* vs *${m.awayTeam}*\n`;
            telegramMessage += `🎯 Marché: ${m.prediction}\n`;
            telegramMessage += `📊 Confiance: ${m.confidence.toFixed(1)}%\n`;
            telegramMessage += `🔢 Score: ${score}\n\n`;
        });

        console.log("=".repeat(60));
        console.log(`✅ ${matches.length} Pronostics chirurgicaux affichés.`);
        console.log("=".repeat(60) + "\n");
        
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des pronostics:", err.message);
    } finally {
        db.close();
    }
}

getPronos();
