const path = require('path');
const botService = require('../services/botService');
const { runDailyMegaPronostic } = require('../scripts/daily_mega_pronostic');

async function main() {
    try {
        console.log("🚀 Starting manual broadcast request...");
        
        // 1. Send Promosport
        console.log("📡 Sending Promosport AI Ticket...");
        await botService._handlePromosport(botService.chatId);
        
        // 2. Send Daily Pronostic (18 April)
        console.log("📡 Sending Daily Mega Pronostic 18 Avril...");
        // This will automatically send to the default chatId defined in botService
        await runDailyMegaPronostic(true);
        
        console.log("✅ All reports sent to Telegram!");
    } catch (error) {
        console.error("❌ Error during broadcast:", error);
    }
}

main();
