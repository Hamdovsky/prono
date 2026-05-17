const { SofaAPI } = require('./SofascoreScraping/src/apiClient');

async function testForceSync() {
    console.log('Testing Force Sync for Saudi Pro League (955)...');
    try {
        const data = await SofaAPI.getTournamentSeasons(955);
        if (data && data.seasons) {
            console.log(`✅ SUCCESS! Found ${data.seasons.length} seasons.`);
        } else {
            console.log('❌ FAILED: Response does not contain seasons property.');
            console.log('Data received:', JSON.stringify(data));
        }
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

testForceSync();
