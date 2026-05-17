const { fetch, Agent } = require('undici');

async function testGeneral() {
    console.log('Testing general connectivity with undici...');
    try {
        const agent = new Agent({
            keepAliveTimeout: 10000,
            connections: 1
        });
        const res = await fetch('https://www.google.com', { dispatcher: agent });
        console.log('Google Status:', res.status);
    } catch (e) {
        console.error('Google Fetch Fail:', e.message);
        console.error(e.cause);
    }
}

async function testSofascore() {
    console.log('Testing Sofascore connectivity with undici...');
    try {
        const agent = new Agent({
            keepAliveTimeout: 10000,
            connections: 1
        });
        const res = await fetch('https://www.sofascore.com/api/v1/sport/football/scheduled-events/2026-04-14', {
            dispatcher: agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });
        console.log('Sofascore Status:', res.status);
    } catch (e) {
        console.error('Sofascore Fetch Fail:', e.message);
        console.error(e.cause);
    }
}

async function run() {
    await testGeneral();
    await testSofascore();
}

run();
