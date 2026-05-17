/**
 * ═══════════════════════════════════════════════════════════════════
 *  AUTO-ARCHIVER V1 — Historical Match Data Collector
 * ═══════════════════════════════════════════════════════════════════
 * 
 *  Fetches FINISHED matches from Sofascore for the past N days
 *  and stores their full stats into historical_archive.sqlite
 *  to feed XGBoost training data.
 * 
 *  Run: node services/autoArchiver.js
 *  Or scheduled via server.js startup (runs at 04:00 AM daily)
 * ═══════════════════════════════════════════════════════════════════
 */

const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../core/logger');

const SOFA_API = 'https://www.sofascore.com/api/v1';
const SOFA_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.sofascore.com/',
    'Origin': 'https://www.sofascore.com'
};

const DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
console.log('📂 [AutoArchiver] Using Database:', DB_PATH);
let db;

// ─── DB SETUP ───────────────────────────────────────────────────────────────

function getDb() {
    if (db) return db;
    db = new Database(DB_PATH);
    
    // Ensure archive_matches table exists
    db.exec(`
        CREATE TABLE IF NOT EXISTS archive_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sofascore_id TEXT UNIQUE,
            startTimestamp INTEGER,
            tournament_name TEXT,
            homeTeam TEXT,
            awayTeam TEXT,
            scoreHome INTEGER,
            scoreAway INTEGER,
            stats_blob TEXT,
            home_xg REAL,
            away_xg REAL,
            home_possession REAL,
            away_possession REAL,
            home_shots INTEGER,
            away_shots INTEGER,
            home_shots_on_target INTEGER,
            away_shots_on_target INTEGER,
            home_corners INTEGER,
            away_corners INTEGER,
            home_fouls INTEGER,
            away_fouls INTEGER,
            result TEXT,
            archived_at INTEGER
        );
    `);

    // --- Schema Migration Support (V50) ---
    const columns = db.prepare("PRAGMA table_info(archive_matches)").all().map(c => c.name);
    const required = [
        { name: 'home_xg', type: 'REAL' },
        { name: 'away_xg', type: 'REAL' },
        { name: 'home_possession', type: 'REAL' },
        { name: 'away_possession', type: 'REAL' },
        { name: 'home_shots', type: 'INTEGER' },
        { name: 'away_shots', type: 'INTEGER' },
        { name: 'home_shots_on_target', type: 'INTEGER' },
        { name: 'away_shots_on_target', type: 'INTEGER' },
        { name: 'home_corners', type: 'INTEGER' },
        { name: 'away_corners', type: 'INTEGER' },
        { name: 'home_fouls', type: 'INTEGER' },
        { name: 'away_fouls', type: 'INTEGER' },
        { name: 'result', type: 'TEXT' },
        { name: 'archived_at', type: 'INTEGER' }
    ];

    required.forEach(col => {
        if (!columns.includes(col.name)) {
            try {
                console.log(`🛠️ [AutoArchiver] Attempting to add column: ${col.name} (${col.type})`);
                db.prepare(`ALTER TABLE archive_matches ADD COLUMN ${col.name} ${col.type}`).run();
                logger.info(`🛠️ [AutoArchiver] Added missing column: ${col.name}`);
            } catch (e) { 
                console.error(`❌ [AutoArchiver] Failed to add column ${col.name}:`, e.message);
            }
        }
    });

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_archive_sofa ON archive_matches(sofascore_id);
        CREATE INDEX IF NOT EXISTS idx_archive_teams ON archive_matches(homeTeam, awayTeam);
        CREATE INDEX IF NOT EXISTS idx_archive_ts ON archive_matches(startTimestamp);
    `);

    return db;
}

// ─── FETCH FINISHED MATCHES FROM SOFASCORE FOR A DATE ───────────────────────

async function fetchFinishedMatchesForDate(dateStr) {
    // dateStr format: YYYY-MM-DD
    try {
        const url = `${SOFA_API}/sport/football/scheduled-events/${dateStr}`;
        const res = await axios.get(url, { headers: SOFA_HEADERS, timeout: 15000 });
        const events = res.data?.events || [];
        
        // Filter only FINISHED matches
        const finished = events.filter(e => 
            e.status?.type === 'finished' && 
            e.homeScore?.current !== undefined && 
            e.awayScore?.current !== undefined
        );
        
        logger.info(`📦 [AutoArchiver] ${dateStr}: ${finished.length} finished matches found out of ${events.length}`);
        return finished;
    } catch (e) {
        logger.warn(`⚠️ [AutoArchiver] Failed to fetch matches for ${dateStr}: ${e.message}`);
        return [];
    }
}

// ─── FETCH MATCH STATISTICS ──────────────────────────────────────────────────

async function fetchMatchStats(eventId) {
    try {
        const url = `${SOFA_API}/event/${eventId}/statistics`;
        const res = await axios.get(url, { headers: SOFA_HEADERS, timeout: 8000 });
        return res.data?.statistics || null;
    } catch (e) {
        return null;
    }
}

// ─── PARSE STATISTICS INTO A STRUCTURED FORMAT ──────────────────────────────

function parseStats(statisticsData) {
    const result = {
        home_xg: 0, away_xg: 0,
        home_possession: 50, away_possession: 50,
        home_shots: 0, away_shots: 0,
        home_shots_on_target: 0, away_shots_on_target: 0,
        home_corners: 0, away_corners: 0,
        home_fouls: 0, away_fouls: 0,
        raw_blob: null
    };
    
    if (!statisticsData || !Array.isArray(statisticsData)) return result;
    
    const allStats = {};
    
    // Flatten all stat groups (All periods is preferred)
    const preferred = statisticsData.find(g => g.period === 'ALL') || statisticsData[0];
    if (!preferred?.groups) return result;
    
    for (const group of preferred.groups) {
        for (const stat of (group.statisticsItems || [])) {
            const key = stat.name?.toLowerCase().replace(/\s+/g, '_');
            if (key) {
                allStats[`${key}_home`] = parseFloat(String(stat.home || '0').replace('%', '')) || 0;
                allStats[`${key}_away`] = parseFloat(String(stat.away || '0').replace('%', '')) || 0;
            }
        }
    }
    
    // Map known fields
    result.home_xg = allStats['expected_goals_home'] || allStats['xg_home'] || 0;
    result.away_xg = allStats['expected_goals_away'] || allStats['xg_away'] || 0;
    result.home_possession = allStats['ball_possession_home'] || 50;
    result.away_possession = allStats['ball_possession_away'] || 50;
    result.home_shots = allStats['total_shots_home'] || allStats['shots_home'] || 0;
    result.away_shots = allStats['total_shots_away'] || allStats['shots_away'] || 0;
    result.home_shots_on_target = allStats['shots_on_target_home'] || allStats['shots_on_goal_home'] || 0;
    result.away_shots_on_target = allStats['shots_on_target_away'] || allStats['shots_on_goal_away'] || 0;
    result.home_corners = allStats['corner_kicks_home'] || allStats['corners_home'] || 0;
    result.away_corners = allStats['corner_kicks_away'] || allStats['corners_away'] || 0;
    result.home_fouls = allStats['fouls_home'] || 0;
    result.away_fouls = allStats['fouls_away'] || 0;
    
    result.raw_blob = JSON.stringify(allStats);
    
    return result;
}

// ─── SAVE MATCH TO DATABASE ──────────────────────────────────────────────────

function saveMatch(event, stats) {
    const db = getDb();
    
    const sofaId = String(event.id);
    const existing = db.prepare('SELECT id FROM archive_matches WHERE sofascore_id = ?').get(sofaId);
    if (existing) return false; // Already archived
    
    const homeScore = event.homeScore?.current ?? 0;
    const awayScore = event.awayScore?.current ?? 0;
    const result = homeScore > awayScore ? 'H' : (awayScore > homeScore ? 'A' : 'D');
    
    const tournament = event.tournament?.name || event.season?.tournament?.name || 'Unknown';
    
    db.prepare(`
        INSERT OR IGNORE INTO archive_matches 
        (sofascore_id, startTimestamp, tournament_name, homeTeam, awayTeam, 
         scoreHome, scoreAway, stats_blob, home_xg, away_xg, home_possession, away_possession,
         home_shots, away_shots, home_shots_on_target, away_shots_on_target,
         home_corners, away_corners, home_fouls, away_fouls, result, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        sofaId,
        event.startTimestamp || 0,
        tournament,
        event.homeTeam?.name || 'Unknown',
        event.awayTeam?.name || 'Unknown',
        homeScore,
        awayScore,
        stats?.raw_blob || null,
        stats?.home_xg || 0,
        stats?.away_xg || 0,
        stats?.home_possession || 50,
        stats?.away_possession || 50,
        stats?.home_shots || 0,
        stats?.away_shots || 0,
        stats?.home_shots_on_target || 0,
        stats?.away_shots_on_target || 0,
        stats?.home_corners || 0,
        stats?.away_corners || 0,
        stats?.home_fouls || 0,
        stats?.away_fouls || 0,
        result,
        Date.now()
    );
    
    return true;
}

// ─── MAIN ARCHIVER FUNCTION ──────────────────────────────────────────────────

async function runArchiver(daysBack = 3) {
    logger.info('🗃️ [AutoArchiver] Starting historical data collection...');
    getDb(); // Init DB
    
    let totalArchived = 0;
    let totalSkipped = 0;
    
    for (let d = 1; d <= daysBack; d++) {
        const date = new Date();
        date.setDate(date.getDate() - d);
        const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
        
        const matches = await fetchFinishedMatchesForDate(dateStr);
        
        // Process matches with slight delay to avoid rate limiting
        for (const event of matches) {
            try {
                const statsData = await fetchMatchStats(event.id);
                const stats = parseStats(statsData);
                
                const saved = saveMatch(event, stats);
                if (saved) {
                    totalArchived++;
                    logger.info(`  ✅ Archived: ${event.homeTeam?.name} ${event.homeScore?.current}-${event.awayScore?.current} ${event.awayTeam?.name}`);
                } else {
                    totalSkipped++;
                }
                
                // Small delay to be respectful to the API
                await new Promise(r => setTimeout(r, 120));
            } catch (e) {
                logger.warn(`  ⚠️ Error archiving event ${event.id}: ${e.message}`);
                console.error(e); // Added verbose logging for debugging
            }
        }
    }
    
    const totalNow = getDb().prepare('SELECT COUNT(*) as c FROM archive_matches').get().c;
    logger.info(`\n🎉 [AutoArchiver] DONE! Archived: ${totalArchived} new | Skipped (exists): ${totalSkipped} | Total in DB: ${totalNow}`);
    
    return { archived: totalArchived, skipped: totalSkipped, total: totalNow };
}

// ─── SCHEDULE: Run daily at 04:00 AM ────────────────────────────────────────

function scheduleDailyArchiver() {
    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(4, 0, 0, 0);
    if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
    
    const msUntilNextRun = nextRun.getTime() - now.getTime();
    const hoursUntil = (msUntilNextRun / 3600000).toFixed(1);
    
    logger.info(`🕐 [AutoArchiver] Scheduled to run in ${hoursUntil}h (at 04:00 AM)`);
    
    setTimeout(async () => {
        await runArchiver(2); // Archive last 2 days
        setInterval(() => runArchiver(2), 24 * 60 * 60 * 1000); // Then every 24h
    }, msUntilNextRun);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
    runArchiver,
    scheduleDailyArchiver,
    fetchFinishedMatchesForDate
};

// ─── DIRECT RUN (node services/autoArchiver.js) ──────────────────────────────

if (require.main === module) {
    const days = parseInt(process.argv[2] || '7');
    console.log(`\n🚀 Running AutoArchiver for past ${days} days...\n`);
    runArchiver(days).then(result => {
        console.log(`\n✅ Finished! Archived ${result.archived} new matches. Total in DB: ${result.total}`);
        process.exit(0);
    }).catch(e => {
        console.error('❌ AutoArchiver failed:', e.message);
        process.exit(1);
    });
}
