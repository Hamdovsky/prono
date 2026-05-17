const { SofaAPI } = require('./apiClient');

async function test() {
    const id = '15832055'; // Olimpia vs Barracas Central
    console.log(`Fetching featured odds for ${id}...`);
    try {
        const oddsData = await SofaAPI.getOddsFeatured(id);
        console.log('Odds Data:', JSON.stringify(oddsData, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();
