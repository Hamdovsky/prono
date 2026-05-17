const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log(`Using Token: ${token ? token.substring(0, 10) + '...' : 'MISSING'}`);
console.log(`Using Chat ID: ${chatId}`);

const text = "🚀 <b>TITANIUM ALERT</b>\nBroadcast Manuel Initié.\nTicket Promosport & Pronostics 18 Avril en préparation.";

const url = `https://api.telegram.org/bot${token}/sendMessage`;
const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
};

const body = JSON.stringify(payload);
const req = https.request(url, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    }
}, (res) => {
    console.log(`Status Code: ${res.statusCode}`);
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log('Telegram Response:', data);
        process.exit(0);
    });
});

req.on('error', (e) => {
    console.error('Telegram Request Error:', e.message);
    process.exit(1);
});

req.write(body);
req.end();
