const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

async function checkMatch() {
    console.log("🔍 Fetching live events from Sofascore...");
    try {
        const liveData = await SofaAPI.getLiveEvents();
        const events = liveData?.events || [];
        
        const match = events.find(e => {
            const home = (e.homeTeam?.name || '').toLowerCase();
            const away = (e.awayTeam?.name || '').toLowerCase();
            return home.includes('radnik') || home.includes('surdulica') ||
                   away.includes('radnik') || away.includes('surdulica');
        });

        if (match) {
            console.log("MATCH_FOUND");
            console.log(`HOME_TEAM:${match.homeTeam?.name}`);
            console.log(`AWAY_TEAM:${match.awayTeam?.name}`);
            console.log(`LEAGUE:${match.tournament?.name}`);
            console.log(`DESC:${match.status?.description}`);
            console.log(`TYPE:${match.status?.type}`);
            console.log(`HOME_SCORE:${match.homeScore?.display ?? 0}`);
            console.log(`AWAY_SCORE:${match.awayScore?.display ?? 0}`);
            
            const totalGoals = (match.homeScore?.display ?? 0) + (match.awayScore?.display ?? 0);
            console.log(`GOALS:${totalGoals}`);
        } else {
            console.log("NO_MATCH_FOUND");
        }
    } catch (err) {
        console.error("ERROR:" + err.message);
    }
}

checkMatch();
