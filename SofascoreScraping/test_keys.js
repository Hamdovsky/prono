const { fetchWithRetry } = require('./src/apiClient');

async function test() {
    try {
        console.log('Fetching events for Man City (2817)...');
        // Get last events to find the current season ID for Premier League (17)
        const url1 = 'https://www.sofascore.com/api/v1/team/2817/events/last/0';
        const res1 = await fetchWithRetry(url1, {}, 3, 1000);
        
        if (!res1 || !res1.ok) {
            console.error('Failed to fetch events');
            return;
        }

        const data1 = await res1.json();
        const event = data1.events[0];
        if (!event) {
            console.error('No event found');
            return;
        }

        const seasonId = event.season.id;
        const tournamentId = event.tournament.uniqueTournament.id;
        console.log(`Man City Season ID: ${seasonId}, Tournament: ${tournamentId}`);
        
        const url2 = `https://www.sofascore.com/api/v1/team/2817/unique-tournament/${tournamentId}/season/${seasonId}/statistics/overall`;
        console.log(`Fetching stats from: ${url2}`);
        const res2 = await fetchWithRetry(url2, {}, 3, 1000);
        
        if (!res2 || !res2.ok) {
            console.error('Failed to fetch stats');
            return;
        }

        const data2 = await res2.json();
        const keys = Object.keys(data2.statistics);
        require('fs').writeFileSync('clean_keys.json', JSON.stringify({keys: keys, sample: data2.statistics}, null, 2), 'utf-8');
        console.log('Saved to clean_keys.json');

    } catch (e) {
        console.error('Error:', e);
    }
}

test();
