const { request } = require('undici');

async function testEndpoint() {
    console.log('Testing /api/scraper/betx2-ticket with ticket 84920394...');
    try {
        const { statusCode, body } = await request('http://localhost:3001/api/scraper/betx2-ticket', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ticketId: '84920394' })
        });
        
        const text = await body.text();
        console.log(`Status: ${statusCode}`);
        console.log(`Response: ${text.substring(0, 500)}`);
    } catch (e) {
        console.error('Error:', e.message);
    }
}

testEndpoint();
