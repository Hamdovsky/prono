const botService = require('../services/botService');

async function test() {
    console.log("Sending test message to Telegram...");
    try {
        await botService._executeSend("🔔 <b>TEST: Titanium AI est en ligne</b>\nSi vous recevez ce message, la connexion Telegram est fonctionnelle.");
        console.log("Test message triggered.");
    } catch (e) {
        console.error("Test failed:", e);
    }
}

test();
