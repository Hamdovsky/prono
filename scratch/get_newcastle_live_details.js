const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

async function getLiveDetails() {
    console.log("🔍 Fetching live events from Sofascore...");
    try {
        const liveData = await SofaAPI.getLiveEvents();
        const liveEvents = liveData?.events || [];
        
        let foundEvent = liveEvents.find(e => {
            const home = (e.homeTeam?.name || '').toLowerCase();
            const away = (e.awayTeam?.name || '').toLowerCase();
            return home.includes('newcastle') || away.includes('newcastle');
        });

        if (!foundEvent) {
            console.log("NO_NEWCASTLE_MATCH_LIVE");
            return;
        }

        const matchId = String(foundEvent.id);
        const homeName = foundEvent.homeTeam?.name || 'Newcastle';
        const awayName = foundEvent.awayTeam?.name || 'West Ham';
        console.log(`FOUND_MATCH:${homeName} vs ${awayName} (ID: ${matchId})`);

        // Get status desc (minute)
        const desc = foundEvent.status?.description || '';
        let minute = 45;
        const minMatch = desc.match(/(\d+)/);
        if (minMatch) minute = parseInt(minMatch[1]);
        console.log(`MINUTE:${minute}`);

        // Fetch live stats
        const statsData = await SofaAPI.getMatchStats(matchId);
        if (!statsData || !statsData.statistics) {
            console.log("NO_STATS_AVAILABLE");
            return;
        }

        // Search for corners in statistics
        let homeCorners = 0;
        let awayCorners = 0;

        // Statistics structure: statistics is usually an array of periods (e.g., ALL, 1ST, 2ND)
        const allPeriod = statsData.statistics.find(p => p.period === 'ALL') || statsData.statistics[0];
        
        if (allPeriod && allPeriod.groups) {
            for (const group of allPeriod.groups) {
                const cornerItem = group.statisticsItems.find(item => item.name === 'Corner kicks');
                if (cornerItem) {
                    homeCorners = parseInt(cornerItem.homeValue) || 0;
                    awayCorners = parseInt(cornerItem.awayValue) || 0;
                }
            }
        }

        console.log(`CORNERS_HOME:${homeCorners}`);
        console.log(`CORNERS_AWAY:${awayCorners}`);
        console.log(`CORNERS_TOTAL:${homeCorners + awayCorners}`);

    } catch (err) {
        console.error("ERROR:" + err.message);
    }
}

getLiveDetails();
