/**
 * Historical Batch Scraper (2023-2026)
 * Fetches completed match results from SofaScore API for top leagues
 * and stores them into historical_archive.sqlite for Time Machine analysis.
 *
 * Leagues covered:
 *   - Premier League (17)
 *   - La Liga (8)
 *   - Bundesliga (35)
 *   - Serie A (23)
 *   - Ligue 1 (34)
 *   - Champions League (7)
 *   - Saudi Pro League (955)
 */

const { fetchWithRetry } = require('../SofascoreScraping/src/apiClient');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
const PROGRESS_PATH = path.join(__dirname, '..', 'data', 'historical_progress.json');
const DELAY_MS = 800; // Increased speed for backfill
const PAGES_PER_LEAGUE = 22; // Fetch full seasons (~550 matches) per league

// Elite leagues with their SofaScore tournament IDs and season IDs for 2023-2025
const LEAGUE_TARGETS = [
    // ─── ENGLAND ───
    { name: 'Premier League 23/24', tournamentId: 17, seasonId: 52186 },
    { name: 'Premier League 24/25', tournamentId: 17, seasonId: 61627 },
    { name: 'Championship 23/24',   tournamentId: 18, seasonId: 52366 },
    { name: 'Championship 24/25',   tournamentId: 18, seasonId: 63516 },
    // ─── SPAIN ───
    { name: 'La Liga 23/24',        tournamentId: 8,  seasonId: 52376 },
    { name: 'La Liga 24/25',        tournamentId: 8,  seasonId: 61643 },
    { name: 'La Liga 2 23/24',      tournamentId: 54, seasonId: 52381 },
    // ─── GERMANY ───
    { name: 'Bundesliga 23/24',     tournamentId: 35, seasonId: 52608 },
    { name: 'Bundesliga 24/25',     tournamentId: 35, seasonId: 63516 },
    { name: '2. Bundesliga 23/24',  tournamentId: 44, seasonId: 52613 },
    // ─── ITALY ───
    { name: 'Serie A 23/24',        tournamentId: 23, seasonId: 52760 },
    { name: 'Serie A 24/25',        tournamentId: 23, seasonId: 63515 },
    { name: 'Serie B 23/24',        tournamentId: 53, seasonId: 52765 },
    // ─── FRANCE ───
    { name: 'Ligue 1 23/24',        tournamentId: 34, seasonId: 52571 },
    { name: 'Ligue 1 24/25',        tournamentId: 34, seasonId: 63514 },
    { name: 'Ligue 2 23/24',        tournamentId: 182,seasonId: 52576 },
    // ─── EUROPE CUPS ───
    { name: 'UCL 23/24',            tournamentId: 7,  seasonId: 52162 },
    { name: 'UCL 24/25',            tournamentId: 7,  seasonId: 61644 },
    { name: 'Europa League 23/24',  tournamentId: 679,seasonId: 53654 },
    { name: 'Europa League 24/25',  tournamentId: 679,seasonId: 63655 },
    { name: 'Conference League 23/24', tournamentId: 17015, seasonId: 53649 },
    // ─── NETHERLANDS ───
    { name: 'Eredivisie 23/24',     tournamentId: 37, seasonId: 52554 },
    { name: 'Eredivisie 24/25',     tournamentId: 37, seasonId: 63517 },
    // ─── PORTUGAL ───
    { name: 'Primeira Liga 23/24',  tournamentId: 238,seasonId: 52769 },
    { name: 'Primeira Liga 24/25',  tournamentId: 238,seasonId: 63520 },
    // ─── TURKEY ───
    { name: 'Super Lig 23/24',      tournamentId: 52, seasonId: 52594 },
    { name: 'Super Lig 24/25',      tournamentId: 52, seasonId: 63513 },
    // ─── RUSSIA ───
    { name: 'Russian PL 23/24',     tournamentId: 203,seasonId: 52557 },
    // ─── MIDDLE EAST ───
    { name: 'Saudi Pro 23/24',      tournamentId: 955,seasonId: 53042 },
    { name: 'Saudi Pro 24/25',      tournamentId: 955,seasonId: 63525 },
    { name: 'UAE League 23/24',     tournamentId: 364,seasonId: 52870 },
    // ─── SOUTH AMERICA ───
    { name: 'Brasileiro 2023',      tournamentId: 325,seasonId: 42268 },
    { name: 'Brasileiro 2024',      tournamentId: 325,seasonId: 56448 },
    { name: 'Copa Libertadores 24', tournamentId: 384,seasonId: 57478 },
    { name: 'Argentine Primera 24', tournamentId: 155,seasonId: 57501 },
    // ─── USA ───
    { name: 'MLS 2024',             tournamentId: 242,seasonId: 57317 },
    // ─── AFRICA ───
    { name: 'Egyptian Premier 23/24',tournamentId: 703,seasonId: 52907 },
    // ─── BELGIUM ───
    { name: 'Jupiler Pro 23/24',    tournamentId: 38, seasonId: 52497 },
    { name: 'Jupiler Pro 24/25',    tournamentId: 38, seasonId: 63518 },
    // ─── SCOTLAND ───
    { name: 'Scottish Prem 23/24',  tournamentId: 36, seasonId: 52561 },
];

function initDb() {
    const db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS archive_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sofascore_id INTEGER UNIQUE,
            homeTeam TEXT,
            awayTeam TEXT,
            scoreHome INTEGER,
            scoreAway INTEGER,
            league TEXT,
            season TEXT,
            match_date TEXT,
            startTimestamp INTEGER,
            status TEXT,
            tournament TEXT
        );
    `);
    return db;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchLeagueRound(tournamentId, seasonId, page = 0) {
    const url = `https://www.sofascore.com/api/v1/unique-tournament/${tournamentId}/season/${seasonId}/events/last/${page}`;
    try {
        const res = await fetchWithRetry(url, {}, 3, 2000);
        if (!res || !res.ok) return [];
        const data = await res.json();
        return data.events || [];
    } catch (e) {
        console.warn(`  [WARN] Failed page ${page}: ${e.message}`);
        return [];
    }
}

async function processLeague(db, league, startPage = 0) {
    console.log(`\n[Scraping] ${league.name} (tournament:${league.tournamentId}, season:${league.seasonId}) starting from page ${startPage}`);
    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO archive_matches
        (sofascore_id, homeTeam, awayTeam, scoreHome, scoreAway, league, season, match_date, startTimestamp, status, tournament)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalSaved = 0;
    for (let page = startPage; page < PAGES_PER_LEAGUE; page++) {
        const events = await fetchLeagueRound(league.tournamentId, league.seasonId, page);
        if (!events || events.length === 0) {
            console.log(`  [Done] No more events at page ${page}`);
            break;
        }

        let pageSaved = 0;
        for (const ev of events) {
            // Only include finished matches with valid scores
            const status = ev.status?.type || '';
            if (!['finished'].includes(status)) continue;
            const sh = ev.homeScore?.current;
            const sa = ev.awayScore?.current;
            if (sh === undefined || sa === undefined) continue;

            const matchDate = ev.startTimestamp
                ? new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10)
                : null;

            const blob = JSON.stringify({
                homeTeam: ev.homeTeam?.name,
                awayTeam: ev.awayTeam?.name,
                homeScore: sh,
                awayScore: sa,
                startTimestamp: ev.startTimestamp,
                tournament: ev.tournament?.name,
                roundInfo: ev.roundInfo
            });

            try {
                const result = insertStmt.run(
                    ev.id,
                    ev.homeTeam?.name || '',
                    ev.awayTeam?.name || '',
                    sh, sa,
                    league.name, // Use target league name for consistency
                    league.name,
                    matchDate,
                    ev.startTimestamp || null,
                    status,
                    ev.tournament?.name || league.name
                );
                if (result.changes > 0) pageSaved++;
            } catch (e) {}
        }

        console.log(`  [Page ${page}] ${events.length} fetched, ${pageSaved} new saved.`);
        totalSaved += pageSaved;
        
        // Save page-level progress
        saveProgress(league.name, page + 1);
        
        await sleep(DELAY_MS);
    }

    console.log(`  [Total] ${totalSaved} new matches saved for ${league.name}`);
    return totalSaved;
}

function loadProgress() {
    try {
        if (require('fs').existsSync(PROGRESS_PATH)) {
            return JSON.parse(require('fs').readFileSync(PROGRESS_PATH, 'utf8'));
        }
    } catch (e) {}
    return { leagueName: null, page: 0 };
}

function saveProgress(leagueName, page) {
    try {
        require('fs').writeFileSync(PROGRESS_PATH, JSON.stringify({ leagueName, page }), 'utf8');
    } catch (e) {}
}

async function main() {
    console.log('================================================');
    console.log(' Historical Batch Scraper - SofaScore 2023-2026');
    console.log('================================================');
    const db = initDb();

    const before = db.prepare('SELECT COUNT(*) as cnt FROM archive_matches').get().cnt;
    console.log(`Database before: ${before} matches`);

    const progress = loadProgress();
    if (progress.leagueName) {
        console.log(`Resuming from ${progress.leagueName} at page ${progress.page}`);
    }

    let grandTotal = 0;
    let resumeFound = !progress.leagueName; // If no progress, start immediately
    
    for (const league of LEAGUE_TARGETS) {
        if (!resumeFound) {
            if (league.name === progress.leagueName) {
                resumeFound = true;
                const saved = await processLeague(db, league, progress.page);
                grandTotal += saved;
            } else {
                console.log(`Skipping ${league.name} (already processed)`);
                continue;
            }
        } else {
            const saved = await processLeague(db, league, 0);
            grandTotal += saved;
        }
        await sleep(DELAY_MS * 2); // be polite between leagues
    }

    // Clear progress when done
    saveProgress(null, 0);

    const after = db.prepare('SELECT COUNT(*) as cnt FROM archive_matches').get().cnt;
    console.log('\n================================================');
    console.log(` DONE! Added ${grandTotal} new matches. Total DB: ${after}`);
    console.log('================================================');
    db.close();
}

main().catch(console.error);
