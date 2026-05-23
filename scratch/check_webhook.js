const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error('No TELEGRAM_BOT_TOKEN found.');
    process.exit(1);
}

https.get(`https://api.telegram.org/bot${token}/getWebhookInfo`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const info = JSON.parse(data);
        console.log('Webhook Info:', info);
        if (info.result && info.result.url) {
            console.log('Webhook is active. Deleting webhook...');
            https.get(`https://api.telegram.org/bot${token}/deleteWebhook`, (delRes) => {
                let delData = '';
                delRes.on('data', c => delData += c);
                delRes.on('end', () => {
                    console.log('Delete webhook response:', delData);
                });
            });
        } else {
            console.log('No webhook active. Long-polling is clean!');
        }
    });
}).on('error', (err) => {
    console.error('Error fetching webhook info:', err.message);
});
