const { scrapePromosport } = require('../core/promosport_scraper');
const { generatePromosportGrids } = require('../core/promosport_engine');
const logger = require('../core/logger');


async function testFullFlow() {
    try {
        console.log('--- STARTING FULL FLOW TEST ---');
        const matches = await scrapePromosport();
        console.log(`Scraped ${matches.length} matches.`);
        
        if (matches.length > 0) {
            const gridData = await generatePromosportGrids(matches);
            console.log('Grid Data Generated Successfully.');
            console.log('First Match Cols:', JSON.stringify(gridData.matches[0].cols, null, 2));
            console.log('Summary:');
            gridData.matches.forEach(m => {
                const doubles = m.cols.filter(c => c.isDouble).length;
                console.log(`${m.idx}. ${m.home} vs ${m.away} | Surprise: ${m.isSurprise} | Draw: ${m.isDraw} | Doubles in columns: ${m.cols.map((c, i) => c.isDouble ? i+1 : null).filter(x => x !== null)}`);
            });
        }
    } catch (e) {
        console.error('Test failed:', e);
    }
}

testFullFlow();
