const Database = require('better-sqlite3');
const path = require('path');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');

async function checkNewcastle() {
    console.log("🔍 Searching for Newcastle matches in live/scheduled events...");
    try {
        const liveData = await SofaAPI.getLiveEvents();
        const liveEvents = liveData?.events || [];
        
        let foundEvent = liveEvents.find(e => {
            const home = (e.homeTeam?.name || '').toLowerCase();
            const away = (e.awayTeam?.name || '').toLowerCase();
            return home.includes('newcastle') || away.includes('newcastle');
        });

        if (foundEvent) {
            console.log("MATCH_FOUND_LIVE");
            console.log(`HOME:${foundEvent.homeTeam?.name}`);
            console.log(`AWAY:${foundEvent.awayTeam?.name}`);
            console.log(`LEAGUE:${foundEvent.tournament?.name}`);
            console.log(`DESC:${foundEvent.status?.description}`);
            console.log(`HOME_SCORE:${foundEvent.homeScore?.display ?? 0}`);
            console.log(`AWAY_SCORE:${foundEvent.awayScore?.display ?? 0}`);
            return;
        }

        // Search database
        const db = new Database(dbPath);
        const nowSec = Math.floor(Date.now() / 1000);
        const dbMatches = db.prepare(`
            SELECT * FROM matches 
            WHERE (homeTeam LIKE '%Newcastle%' OR awayTeam LIKE '%Newcastle%')
            AND startTimestamp >= ?
            ORDER BY startTimestamp ASC
            LIMIT 1
        `).get(nowSec - 7200);

        if (dbMatches) {
            console.log("MATCH_FOUND_DB");
            console.log(`HOME:${dbMatches.homeTeam}`);
            console.log(`AWAY:${dbMatches.awayTeam}`);
            console.log(`LEAGUE:${dbMatches.tournament_name}`);
            console.log(`TIME:${new Date(dbMatches.startTimestamp * 1000).toLocaleString()}`);
            console.log(`OU_25:${dbMatches.ou_25_prob}`);
        } else {
            console.log("NO_MATCH_FOUND");
        }
        db.close();
    } catch (err) {
        console.error("ERROR:" + err.message);
    }
}

checkNewcastle();
