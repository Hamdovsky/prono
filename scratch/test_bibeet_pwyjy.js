const axios = require('axios');

async function test() {
    try {
        console.log('Testing Bibeet scraper with code: PWYJY');
        const response = await axios.post('http://localhost:3000/api/scraper/bibeet-ticket', {
            ticketId: 'PWYJY'
        }, {
            timeout: 120000 // 2 minutes
        });
        
        console.log('Result:');
        console.log(JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.error('Network/Execution Error:');
        console.error(e.message);
        if (e.response) {
            console.error('Response Status:', e.response.status);
            console.error('Response Data:', e.response.data);
        }
    }
}

test();
