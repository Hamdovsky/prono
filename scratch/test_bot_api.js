const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log('Token exists:', !!token);
console.log('ChatId exists:', !!chatId);

if (!token) {
    process.exit(1);
}

// Fetch bot details
https.get(`https://api.telegram.org/bot${token}/getMe`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log('Bot details:', data);
    });
}).on('error', (err) => {
    console.error('Error fetching bot details:', err.message);
});
