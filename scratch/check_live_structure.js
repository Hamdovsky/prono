const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

async function checkLive() {
    console.log('📡 Fetching live events from Sofascore...');
    try {
        const data = await SofaAPI.getLiveEvents();
        console.log('✅ Success!');
        console.log('Total live events:', data?.events?.length || 0);
        
        if (data?.events && data.events.length > 0) {
            const first = data.events[0];
            console.log('Sample Live Event Structure:');
            console.log(JSON.stringify({
                id: first.id,
                homeTeam: first.homeTeam?.name,
                awayTeam: first.awayTeam?.name,
                tournament: first.tournament?.name,
                status: first.status,
                homeScore: first.homeScore,
                awayScore: first.awayScore,
                time: first.statusTime
            }, null, 2));
        } else {
            console.log('No live matches currently.');
        }
    } catch(e) {
        console.error('❌ Error:', e.message);
    }
}

checkLive();
