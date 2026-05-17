const axios = require('axios');
const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';

async function findId() {
    console.log("🔍 En attente d'un message sur votre Bot Telegram...");
    console.log("👉 ACTION : Envoyez n'importe quel message à votre Bot maintenant.");
    
    try {
        const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
        const updates = response.data.result;
        
        if (updates.length === 0) {
            console.log("\n❌ Aucun message reçu récemment.");
            console.log("Assurez-vous d'avoir envoyé un message au bot (@votre_bot_username).");
        } else {
            const latest = updates[updates.length - 1];
            const chatId = latest.message.chat.id;
            const firstName = latest.message.chat.first_name;
            
            console.log("\n✅ ID TROUVÉ !");
            console.log(`👤 Utilisateur : ${firstName}`);
            console.log(`🆔 Chat ID     : ${chatId}`);
            console.log(`\n🚀 Utilisez cette commande pour envoyer les pronostics :`);
            console.log(`node scripts/send_to_telegram.js ${chatId}`);
        }
    } catch (err) {
        console.error("❌ Erreur:", err.message);
    }
}

findId();
