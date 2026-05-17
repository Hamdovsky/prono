const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const fs = require('fs');

async function run() {
    const date = '2026-03-23';
    console.log(`📡 Fetching raw events for ${date}...`);
    try {
        const data = await SofaAPI.getEvents(date);
        const events = data.events || [];
        console.log(`Found ${events.length} total events.`);
        
        const pl2 = events.filter(e => 
            (e.tournament?.name || '').toLowerCase().includes('premier league 2') ||
            (e.tournament?.category?.name || '').toLowerCase().includes('amateur')
        );
        
        console.log(`Found ${pl2.length} matches potentially related to PL2 or amateur.`);
        pl2.forEach(e => {
            console.log(`- [${e.id}] ${e.homeTeam.name} vs ${e.awayTeam.name} | Tournament: ${e.tournament.name} | Category: ${e.tournament.category.name}`);
        });
        
        fs.writeFileSync('raw_events_sample.json', JSON.stringify(events.slice(0, 50), null, 2));
    } catch (err) {
        console.error(err.message);
    }
}
run();
