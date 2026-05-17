const https = require('https');
const token = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';

const url = `https://api.telegram.org/bot${token}/getUpdates`;

https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log('Bot Updates Response:');
        console.log(data);
    });
}).on('error', (err) => {
    console.error('Error checking bot updates:', err.message);
});
