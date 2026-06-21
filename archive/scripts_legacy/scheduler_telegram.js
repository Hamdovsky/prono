const { exec } = require('child_process');
const path = require('path');

// CONFIGURATION
const CHAT_ID = '5637790630';
const INTERVAL_MS = 60 * 60 * 1000; // 1 Heure

const scriptPath = path.resolve(__dirname, 'send_to_telegram.js');

function sendUpdate() {
    console.log(`[${new Date().toLocaleString()}] 🔄 Lancement de la mise à jour automatique Titanium...`);
    
    exec(`node "${scriptPath}" ${CHAT_ID}`, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Erreur d'exécution: ${error.message}`);
            return;
        }
        console.log(stdout);
    });
}

// Premier envoi immédiat
sendUpdate();

// Planification
setInterval(sendUpdate, INTERVAL_MS);

console.log(`\n✅ Planificateur TITANIUM actif.`);
console.log(`📡 Les pronostics seront envoyés au Chat ID ${CHAT_ID} toutes les 60 minutes.`);
console.log(`(Appuyez sur Ctrl+C pour arrêter le planificateur)\n`);
