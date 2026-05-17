const axios = require('axios');

async function test() {
    console.log('🧪 Testing expectation: Unauthorized without token...');
    try {
        await axios.post('http://127.0.0.1:3001/api/predict', {}, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('❌ Error: Request succeeded without token (it should have failed)');
    } catch (e) {
        if (e.response && e.response.status === 401) {
            console.log('✅ Success: Server correctly returned 401 Unauthorized.');
        } else {
            console.log('❓ Unexpected status:', e.response ? e.response.status : e.message);
        }
    }
}

test();
