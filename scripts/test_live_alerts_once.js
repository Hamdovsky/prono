const axios = require('axios');

const BOT_TOKEN = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const CHAT_ID = '5637790630';

async function sendTestAlerts() {
    console.log('📡 Tentative de connexion au bot Telegram...');
    console.log(`Bot Token: ${BOT_TOKEN}`);
    console.log(`Chat ID: ${CHAT_ID}`);

    let testGoalMsg = `⚽ *TEST SYSTÈME : TITANIUM LIVE ALERTS* ⚽\n\n`;
    testGoalMsg += `🏆 *Champions League (Simulation)*\n`;
    testGoalMsg += `🔥 *Real Madrid 1 - 0 Barcelona*\n`;
    testGoalMsg += `⏰ *Minute :* 34'\n\n`;
    testGoalMsg += `🎯 *Buteur :* Real Madrid 🏠\n`;
    testGoalMsg += `\n✅ _Le système d'alerte de buts est connecté et opérationnel !_`;

    let testValueMsg = `🚨 *TEST SYSTÈME : TITANIUM LIVE VALUE BET* 🚨\n\n`;
    testValueMsg += `🏆 *La Liga (Simulation)*\n`;
    testValueMsg += `⚽ *Atletico Madrid 1 - 1 Real Betis*\n`;
    testValueMsg += `⏰ *Minute :* 55' | *Score :* 1-1\n\n`;
    testValueMsg += `🔥 *PRONOSTIC LIVE : Victoire de Atletico Madrid* 🏠\n`;
    testValueMsg += `📈 *Côte Actuelle :* \`@1.95\` 🚀\n`;
    testValueMsg += `🧠 *Avantage Mathématique (EV) :* \`+24.5%\`\n`;
    testValueMsg += `📊 *Confiance Pré-Match IA V17 :* \`68%\`\n`;
    testValueMsg += `💰 *Mise Conseillée :* \`5% de la Bankroll\` (Kelly 1/4)\n\n`;
    testValueMsg += `🤖 _Le système de détection de Value Bets est connecté et opérationnel !_`;

    try {
        console.log('📡 Envoi du test d\'alerte de but...');
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: testGoalMsg,
            parse_mode: 'Markdown'
        });
        console.log('✅ Test d\'alerte de but envoyé avec succès !');

        console.log('📡 Envoi du test de Value Bet...');
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: testValueMsg,
            parse_mode: 'Markdown'
        });
        console.log('✅ Test de Value Bet envoyé avec succès !');

        console.log('\n🎉 Connexion Telegram validée à 100% ! Regardez votre application Telegram ! 🎉');
    } catch(err) {
        console.error('❌ Échec de la connexion Telegram :', err.message);
        if (err.response) {
            console.error('   Détail de l\'erreur Telegram :', err.response.data?.description);
        }
    }
}

sendTestAlerts();
