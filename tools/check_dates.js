const database = require('./database');

async function test() {
    try {
        const matches = await database.getMatchesByStatus('scheduled');
        console.log(`Total Scheduled: ${matches.length}`);
        if (matches.length > 0) {
            const sample = matches.slice(0, 3).map(m => ({
                id: m.id,
                home: m.homeTeam,
                away: m.awayTeam,
                start: m.startTimestamp,
                date: new Date(m.startTimestamp * 1000).toDateString()
            }));
            console.log('Sample Match Dates:', JSON.stringify(sample, null, 2));
            
            const now = new Date();
            const today = now.toDateString();
            now.setDate(now.getDate() + 1);
            const tomorrow = now.toDateString();
            
            const counts = {
                today: matches.filter(m => new Date(m.startTimestamp * 1000).toDateString() === today).length,
                tomorrow: matches.filter(m => new Date(m.startTimestamp * 1000).toDateString() === tomorrow).length,
                other: 0
            };
            counts.other = matches.length - counts.today - counts.tomorrow;
            console.log('Distribution:', counts);
        }
    } catch (e) {
        console.error(e);
    }
}

test();
