const oddsService = require('../src/services/oddsService');

async function test() {
    const id = '15362856';
    console.log(`Fetching odds for ${id}...`);
    const odds = await oddsService.getLiveOdds(id);
    console.log('Odds:', odds);
}

test();
