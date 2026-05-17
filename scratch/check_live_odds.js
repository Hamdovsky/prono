const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

async function checkOdds() {
    // Newcastle United vs West Ham ID: 14023957
    const matchId = 14023957;
    console.log(`📡 Fetching odds for match ${matchId}...`);
    try {
        const data = await SofaAPI.getOddsFeatured(matchId);
        console.log('✅ Success!');
        console.log('Odds Data:', JSON.stringify(data, null, 2));
    } catch(e) {
        console.error('❌ Error:', e.message);
    }
}

checkOdds();
