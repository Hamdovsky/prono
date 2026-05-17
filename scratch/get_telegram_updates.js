const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;

const url = `https://api.telegram.org/bot${token}/getUpdates`;

https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log('--- TELEGRAM UPDATES ---');
            if (json.ok && json.result.length > 0) {
                json.result.forEach(u => {
                    const msg = u.message || u.callback_query?.message;
                    if (msg) {
                        console.log(`User: ${msg.from.username} (${msg.from.id}), Text: ${u.message?.text || 'N/A'}`);
                    }
                });
            } else {
                console.log('No recent updates or error:', data);
            }
        } catch (e) {
            console.error('JSON Parse Error:', e);
            console.log('Raw Data:', data);
        }
    });
}).on('error', e => console.error(e));
