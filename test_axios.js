const axios = require('axios');

async function test() {
    const url = 'https://www.sofascore.com/api/v1/sport/football/scheduled-events/2026-04-25';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.sofascore.com/',
        'Accept': 'application/json'
    };
    
    console.log(`Testing with Axios: ${url}...`);
    try {
        const response = await axios.get(url, { headers });
        console.log(`Status: ${response.status}`);
        console.log(`Success! Events count: ${response.data.events?.length}`);
    } catch (e) {
        console.error(`Error: ${e.response?.status || e.message}`);
        if (e.response) {
            console.log('Headers:', e.response.headers);
        }
    }
}

test();
