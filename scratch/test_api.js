const { request } = require('undici');

async function testEndpoints() {
    const urls = [
        'https://api.betx2.com/api/ticket/check/84920394',
        'https://api.betx2.com/ticket/84920394',
        'https://betx2.com/api/ticket/84920394',
        'https://betx2.com/api/sports/ticket/84920394',
        'https://betx2.com/api/v1/ticket/84920394',
        'https://betx2.com/api/v1/tickets/84920394'
    ];
    
    for (const url of urls) {
        console.log('Testing', url);
        try {
            const { statusCode, headers, body } = await request(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                }
            });
            console.log('Status:', statusCode);
            if (statusCode !== 403 && statusCode !== 404) {
                const text = await body.text();
                console.log('Response:', text.substring(0, 100));
            }
        } catch (e) {
            console.log('Error:', e.message);
        }
    }
}
testEndpoints();
