const https = require('https');
const token = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';
const chatId = '5637790630';

const url = `https://api.telegram.org/bot${token}/sendMessage`;
const payload = JSON.stringify({
    chat_id: chatId,
    text: '🛡️ *Titanium System Connection Test*\n\nBot is active and connected to the server.',
    parse_mode: 'Markdown'
});

const req = https.request(url, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    }
}, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log('Send Message Response:');
        console.log(data);
    });
});

req.on('error', (err) => {
    console.error('Error sending message:', err.message);
});

req.write(payload);
req.end();
