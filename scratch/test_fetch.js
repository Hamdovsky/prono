const { fetch } = require('undici');

async function test() {
    try {
        console.log('Fetching...');
        const res = await fetch('https://www.sofascore.com/api/v1/sport/football/scheduled-events/2026-04-14', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });
        console.log('Status:', res.status);
        if (res.ok) {
            const data = await res.json();
            console.log('Success! Events found:', data.events?.length || 0);
        } else {
            console.log('Failed with status:', res.status);
            const text = await res.text();
            console.log('Response body snippet:', text.substring(0, 200));
        }
    } catch (err) {
        console.error('Error:', err.message);
        console.error('Stack:', err.stack);
    }
}

test();
