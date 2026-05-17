/**
 * V42 HISTORICAL BACKFILL SCRIPT
 * Imports historical matches and deep stats from SofaScore starting Jan 1st 2026.
 */
const fs = require('fs');
const path = require('path');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const Extractor = require('../SofascoreScraping/src/Extractor');
const persistence = require('../SofascoreScraping/src/Persistence');
const AliasResolver = require('../SofascoreScraping/src/AliasResolver');

const PROGRESS_PATH = path.join(__dirname, '..', 'data', 'backfill_progress.json');

function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_PATH)) {
            return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
        }
    } catch (e) {}
    return { lastDate: null };
}

function saveProgress(dateStr) {
    try {
        fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ lastDate: dateStr }), 'utf8');
    } catch (e) {}
}

async function runBackfill(startDateStr, endDateStr) {
    console.log(`🚀 [BACKFILL] Starting import from ${startDateStr} to ${endDateStr}...`);
    
    await persistence.init();
    const resolver = new AliasResolver(persistence.db);
    resolver.seedMasterNames();

    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    
    const dates = [];
    let current = new Date(start);
    while (current <= end) {
        const d = current.toISOString().split('T')[0];
        dates.push(d);
        current.setDate(current.getDate() + 1);
    }

    console.log(`📅 Target Days: ${dates.length}`);

    const progress = loadProgress();
    if (progress.lastDate) {
        console.log(`🔄 Resuming from the day after: ${progress.lastDate}`);
    }

    let resumeFound = !progress.lastDate;

    for (const d of dates) {
        if (!resumeFound) {
            if (d === progress.lastDate) {
                resumeFound = true; // Start processing from the next date
            }
            console.log(`⏭️ Skipping ${d} (already processed)`);
            continue;
        }
        console.log(`\n📡 [API] Fetching events for: ${d}`);
        try {
            const data = await SofaAPI.getEvents(d);
            const events = (data.events || []).filter(ev => ev.status.type === 'finished');
            
            console.log(`📊 Found ${events.length} finished events.`);
            
            let done = 0;
            for (const event of events) {
                const match = Extractor.extractMatch(event);
                if (!match) continue;

                // Normalize names
                match.homeTeam = resolver.resolve(match.home_team_id, match.homeTeam);
                match.awayTeam = resolver.resolve(match.away_team_id, match.awayTeam);
                match.league = resolver.resolveTournament(match.league, match.category_name);

                // Check if already in DB
                if (await persistence.checkMatchExists(match.id)) {
                    done++;
                    continue;
                }

                // Fetch Deep Stats (Critical for Backtest)
                try {
                    const statsData = await SofaAPI.getMatchStats(match.id);
                    if (statsData && statsData.statistics) {
                        match.stats = statsData.statistics;
                    }
                    
                    // Fetch Match Details (Referee, Venue)
                    const detailsData = await SofaAPI.getMatchDetails(match.id);
                    if (detailsData && detailsData.event) {
                        const ev = detailsData.event;
                        match.scoreHome = ev.homeScore?.current || ev.homeScore?.normaltime || 0;
                        match.scoreAway = ev.awayScore?.current || ev.awayScore?.normaltime || 0;
                        match.details = {
                            referee: ev.referee?.name || 'Unknown',
                            venue: ev.venue?.stadium?.name || 'Unknown'
                        };
                    }

                    // Save to DB
                    persistence.insertMatch(match);
                } catch (err) {
                    console.error(`❌ [BACKFILL] Error on match ${match.id}:`, err.message);
                }

                done++;
                if (done % 10 === 0 || done === events.length) {
                    process.stdout.write(`\r   ⚙️  Processing: ${done}/${events.length}`);
                }
            }
            console.log(`\n✅ Day ${d} completed.`);
            saveProgress(d); // Save progress after successfully completing a day
        } catch (err) {
            console.error(`❌ [API] Fatal error on ${d}:`, err.message);
        }
    }

    console.log('\n🏁 [BACKFILL] All done! Historical data is now ready for Backtesting.');
    saveProgress(null); // Clear progress when completely finished
    process.exit(0);
}

// Default Range: Jan 1st to Feb 14th
const args = process.argv.slice(2);
const sDate = args[0] || '2026-01-01';
const eDate = args[1] || '2026-02-14';

runBackfill(sDate, eDate).catch(console.error);
