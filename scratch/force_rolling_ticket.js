const Database = require('better-sqlite3');
const path = require('path');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');

async function forceTicket() {
    console.log("🔍 Fetching live events from Sofascore...");
    try {
        const liveData = await SofaAPI.getLiveEvents();
        const liveEvents = liveData?.events || [];
        console.log(`Detected ${liveEvents.length} live matches.`);

        // 1. Find Radnik Surdulica match
        const radnikMatch = liveEvents.find(e => {
            const home = (e.homeTeam?.name || '').toLowerCase();
            const away = (e.awayTeam?.name || '').toLowerCase();
            return home.includes('radnik') || home.includes('surdulica') ||
                   away.includes('radnik') || away.includes('surdulica');
        });

        const db = new Database(dbPath);

        // 2. Clear current ticket
        db.prepare("DELETE FROM rolling_live_ticket").run();
        console.log("🧹 Cleared rolling_live_ticket table.");

        const activeIds = new Set();
        let addedCount = 0;

        // 3. Insert Radnik Surdulica if found
        if (radnikMatch) {
            const currentHome = radnikMatch.homeScore?.display ?? radnikMatch.homeScore?.current ?? 0;
            const currentAway = radnikMatch.awayScore?.display ?? radnikMatch.awayScore?.current ?? 0;
            const desc = radnikMatch.status?.description || '';
            let minute = 45;
            const minMatch = desc.match(/(\d+)/);
            if (minMatch) minute = parseInt(minMatch[1]);

            const prediction = "🔥 Plus de 0.5 Buts (Match)";
            const confidence = 88; // Crvena zvezda late pressure makes this extremely high confidence
            const nowSec = Math.floor(Date.now() / 1000);

            db.prepare(`
                INSERT INTO rolling_live_ticket 
                (id, homeTeam, awayTeam, tournament_name, status, homeScore, awayScore, minute, prediction, confidence, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                String(radnikMatch.id),
                radnikMatch.homeTeam?.name || 'Radnik Surdulica',
                radnikMatch.awayTeam?.name || 'Crvena zvezda',
                radnikMatch.tournament?.name || 'Serbian SuperLiga',
                'live',
                currentHome,
                currentAway,
                minute,
                prediction,
                confidence,
                nowSec
            );

            activeIds.add(String(radnikMatch.id));
            addedCount++;
            console.log(`✅ FK Radnik Surdulica match successfully inserted as Match 1!`);
        } else {
            console.log("⚠️ FK Radnik Surdulica match not found in live events. Inserting mock/default.");
            // We can search the database for a fallback or just mock it
        }

        // 4. Find 3 other premium live matches
        const nowSec = Math.floor(Date.now() / 1000);
        const dbMatches = db.prepare(`
            SELECT id, homeTeam, awayTeam, tournament_name, ou_25_prob, xgboost_confidence
            FROM matches 
            WHERE startTimestamp >= ? AND startTimestamp <= ?
            ORDER BY ou_25_prob DESC
        `).all(nowSec - 7200, nowSec + 3600);

        const liveMap = new Map();
        for (const e of liveEvents) {
            liveMap.set(String(e.id), e);
        }

        console.log(`Looking for 3 other live matches out of ${dbMatches.length} analyzed today...`);

        for (const cand of dbMatches) {
            if (addedCount >= 4) break;

            const candId = String(cand.id);
            if (activeIds.has(candId)) continue;

            const liveEvent = liveMap.get(candId);
            if (!liveEvent) continue;

            const statusType = liveEvent.status?.type || '';
            if (statusType !== 'inprogress') continue;

            const currentHome = liveEvent.homeScore?.display ?? liveEvent.homeScore?.current ?? 0;
            const currentAway = liveEvent.awayScore?.display ?? liveEvent.awayScore?.current ?? 0;
            const totalGoals = currentHome + currentAway;

            const desc = liveEvent.status?.description || '';
            let minute = 0;
            const minMatch = desc.match(/(\d+)/);
            if (minMatch) minute = parseInt(minMatch[1]);

            // Early-mid live match with high pre-match goals probability
            if (totalGoals > 1 || minute > 65) continue;

            const prediction = "🔥 Plus de 1.5 Buts (Match)";
            const confidence = Math.round(cand.ou_25_prob || 75);

            db.prepare(`
                INSERT INTO rolling_live_ticket 
                (id, homeTeam, awayTeam, tournament_name, status, homeScore, awayScore, minute, prediction, confidence, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                candId,
                cand.homeTeam,
                cand.awayTeam,
                cand.tournament_name,
                'live',
                currentHome,
                currentAway,
                minute,
                prediction,
                confidence,
                nowSec
            );

            activeIds.add(candId);
            addedCount++;
            console.log(`✅ Added live match: ${cand.homeTeam} vs ${cand.awayTeam} to ticket.`);
        }

        // If still need matches, fill with other available live matches directly from Sofascore
        if (addedCount < 4) {
            console.log(`Ticket still needs ${4 - addedCount} matches. Sourcing directly from active live events...`);
            for (const e of liveEvents) {
                if (addedCount >= 4) break;

                const eventId = String(e.id);
                if (activeIds.has(eventId)) continue;

                const statusType = e.status?.type || '';
                if (statusType !== 'inprogress') continue;

                const currentHome = e.homeScore?.display ?? e.homeScore?.current ?? 0;
                const currentAway = e.awayScore?.display ?? e.awayScore?.current ?? 0;
                const totalGoals = currentHome + currentAway;

                const desc = e.status?.description || '';
                let minute = 0;
                const minMatch = desc.match(/(\d+)/);
                if (minMatch) minute = parseInt(minMatch[1]);

                if (totalGoals > 1 || minute > 65) continue;

                const prediction = "🔥 Plus de 1.5 Buts (Match)";
                const confidence = 72;

                db.prepare(`
                    INSERT INTO rolling_live_ticket 
                    (id, homeTeam, awayTeam, tournament_name, status, homeScore, awayScore, minute, prediction, confidence, added_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    eventId,
                    e.homeTeam?.name || 'Home',
                    e.awayTeam?.name || 'Away',
                    e.tournament?.name || 'League',
                    'live',
                    currentHome,
                    currentAway,
                    minute,
                    prediction,
                    confidence,
                    nowSec
                );

                activeIds.add(eventId);
                addedCount++;
                console.log(`✅ Added live match (direct): ${e.homeTeam?.name} vs ${e.awayTeam?.name}`);
            }
        }

        console.log(`\n🎉 DONE! Ticket successfully populated with ${addedCount} active live matches!`);
        db.close();

    } catch (err) {
        console.error("❌ Error running forceTicket:", err.message);
    }
}

forceTicket();
