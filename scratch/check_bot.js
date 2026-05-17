const https = require('https');
const token = '6714234731:AAFH7rF8hUkvG1KYs1Epg-bknX7c5Pmduvs';

const url = `https://api.telegram.org/bot${token}/getMe`;

https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log('Bot Status Response:');
        console.log(data);
    });
}).on('error', (err) => {
    console.error('Error checking bot status:', err.message);
});
