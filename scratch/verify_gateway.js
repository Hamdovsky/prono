const axios = require('axios');

async function testGateway() {
    console.log('🧪 [DIAGNOSTIC] Testing Titanium AI Gateway (Port 3001)...');

    // 1. Test Sentiment
    try {
        console.log('📡 Testing /api/sentiment...');
        const sentRes = await axios.post('http://127.0.0.1:3001/api/sentiment', {
            headlines: ["Al-Hilal wins 3-0 in a crushing victory", "Messi is injured and will miss the match"]
        });
        console.log('✅ Sentiment Result:', JSON.stringify(sentRes.data, null, 2));
    } catch (e) {
        console.error('❌ Sentiment Failed:', e.message);
    }

    // 2. Test Predict
    try {
        console.log('\n📡 Testing /api/predict...');
        const predRes = await axios.post('http://127.0.0.1:3001/api/predict', {
            homeTeam: "Al-Hilal",
            awayTeam: "Al-Nassr",
            league: "Saudi Pro League",
            stats: { possession: { home: 60, away: 40 } }
        });
        console.log('✅ Predict Result:', JSON.stringify(predRes.data, null, 2));
    } catch (e) {
        console.error('❌ Predict Failed:', e.message);
    }
}

testGateway();
