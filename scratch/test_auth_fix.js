const axios = require('axios');

async function test() {
    console.log('🧪 Testing expectation: Authorized with token...');
    const secretKey = 'Matrix22!';
    try {
        const response = await axios.post('http://127.0.0.1:3001/api/predict', { test: true }, {
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${secretKey}`
            },
            timeout: 5000
        });
        console.log('✅ Success: Server accepted the request (Status ' + response.status + ')');
    } catch (e) {
        if (e.response) {
            console.log('❌ Failure: Server returned ' + e.response.status + ' even with token.');
            console.log('Response body:', JSON.stringify(e.response.data));
        } else {
            console.log('❌ Error:', e.message);
        }
    }
}

test();
