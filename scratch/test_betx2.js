const { request } = require('undici');

async function test() {
    try {
        const { statusCode, headers, body } = await request('https://betx2.com/fr/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            }
        });
        
        console.log('Status:', statusCode);
        const text = await body.text();
        console.log('Body length:', text.length);
        console.log('Body preview:', text.substring(0, 500));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();
