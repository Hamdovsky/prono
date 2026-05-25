/**
 * cloudSeed.js — Titanium Cloud Bootstrap v4.0
 *
 * Runs at server startup on Render (or any cloud without Puppeteer).
 * 
 * STRATEGY:
 *  1. PRIMARY:  RapidAPI SportAPI (Sofascore proxy) — respects 20-match quota
 *  2. FALLBACK: FootballData.io — unlimited for basic seeding (1000/month)
 *
 * Covers today + tomorrow to keep the dashboard populated at all times.
 * NO direct Sofascore calls — those are blocked by Cloudflare on Render.
 */

const axios = require('axios');
const database = require('./database');
const { createQuotaManager } = require('../services/sourceQuotaManager');
const rapidApiQuotaManager = require('../services/rapidApiQuotaManager');

const fdQuotaManager = createQuotaManager('footballdata');

// ── TIER CONFIG ───────────────────────────────────────────────────────────────
// Tier 1 leagues to prioritize for RapidAPI quota (max 20/day)
const TIER1_TOURNAMENT_IDS = new Set([
    17,    // Premier League
    8,     // Ligue 1
    23,    // Serie A
    35,    // Bundesliga
    7,     // La Liga
    37,    // Champions League
    679,   // Europa League
    329,   // Conference League
    34,    // Eredivisie
    44,    // Championship
    238,   // Primeira Liga
    45,    // Süper Lig
    203,   // Scottish Premiership
    574,   // Jupiler Pro League
]);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getDateStr(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════════════════════
// BLOCK 1: RAPIDAPI (PRIMARY)
// Uses SportAPI7 on RapidAPI to fetch scheduled events per date
// Respects the 20-match daily quota managed by rapidApiQuotaManager
// ══════════════════════════════════════════════════════════════════════════════

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'sportapi7.p.rapidapi.com';
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || '';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}/api/v1`;

async function fetchRapidApiEvents(date) {
    if (!RAPIDAPI_KEY || process.env.RAPIDAPI_ENABLED !== 'true') return [];

    try {
        console.log(`📡 [CLOUD-SEED/RAPID] Fetching ${date}...`);
        const { data } = await axios.get(`${RAPIDAPI_BASE}/sport/football/scheduled-events/${date}`, {
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY,
                'Accept': 'application/json'
            },
            timeout: 20000
        });
        return data.events || [];
    } catch (e) {
        const status = e.response?.status;
        if (status === 403 || status === 429) {
            console.warn(`🛑 [CLOUD-SEED/RAPID] Quota exhausted or blocked (HTTP ${status}). Switching to fallback.`);
        } else {
            console.warn(`⚠️ [CLOUD-SEED/RAPID] Failed to fetch ${date}: ${e.message}`);
        }
        return [];
    }
}

function isTier1(event) {
    const tid = event.tournament?.uniqueTournament?.id;
    return tid && TIER1_TOURNAMENT_IDS.has(Number(tid));
}

function mapRapidEventToMatch(event) {
    const ts = event.startTimestamp || Math.floor(Date.now() / 1000);
    const rawStatus = (event.status?.type || '').toLowerCase();
    const status = ['finished', 'canceled', 'postponed', 'inprogress'].includes(rawStatus)
        ? rawStatus : 'scheduled';

    return {
        id: String(event.id),
        homeTeam: event.homeTeam?.name || 'Home',
        awayTeam: event.awayTeam?.name || 'Away',
        league: event.tournament?.name || 'Unknown',
        category_name: event.tournament?.category?.name || '',
        tournament_name: event.tournament?.name || '',
        tournament_id: event.tournament?.uniqueTournament?.id || null,
        home_team_id: event.homeTeam?.id || null,
        away_team_id: event.awayTeam?.id || null,
        startTimestamp: ts,
        timestamp: new Date(ts * 1000).toISOString(),
        status,
        confidence: 50,
        prediction: null,
        verdict: 'PENDING',
        odds_home: null,
        odds_draw: null,
        odds_away: null,
        last_updated: Date.now(),
        insufficient_data: 1,
        source: 'rapidapi',
        fullData: JSON.stringify({
            id: event.id,
            homeTeam: event.homeTeam?.name,
            awayTeam: event.awayTeam?.name,
            league: event.tournament?.name,
            startTimestamp: ts,
            status,
        })
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// BLOCK 2: FOOTBALLDATA.IO (FALLBACK)
// Uses /fixtures/today and /fixtures/upcoming to fill in gaps
// ══════════════════════════════════════════════════════════════════════════════

const FD_KEY  = process.env.FOOTBALLDATA_KEY || '';
const FD_HOST = process.env.FOOTBALLDATA_HOST || 'footballdata.io';
const FD_BASE = `https://${FD_HOST}/api/v1`;

async function fetchFDFixtures(endpoint) {
    if (!FD_KEY || process.env.FOOTBALLDATA_ENABLED !== 'true') return [];

    try {
        console.log(`📡 [CLOUD-SEED/FD] Fetching ${endpoint}...`);
        const { data } = await axios.get(`${FD_BASE}${endpoint}`, {
            headers: {
                'Authorization': `Bearer ${FD_KEY}`,
                'Accept': 'application/json'
            },
            timeout: 20000
        });

        // Response can be: { success, data: { fixtures: [] } } or { fixtures: [] }
        const root = data?.data || data;
        return root?.fixtures || [];
    } catch (e) {
        console.warn(`⚠️ [CLOUD-SEED/FD] Failed on ${endpoint}: ${e.message}`);
        return [];
    }
}

function mapFDFixtureToMatch(f) {
    const matchId = f.match_id || f.id || `fd_${Date.now()}_${Math.random()}`;
    const ts = f.date_unix || f.timestamp || Math.floor(Date.now() / 1000);
    const rawStatus = (f.status || '').toLowerCase();
    let status = 'scheduled';
    if (rawStatus === 'complete' || rawStatus === 'ft') status = 'finished';
    else if (rawStatus === 'live' || rawStatus === 'inprogress') status = 'inprogress';

    const home = f.home_team?.team_name || f.home_team?.name || f.homeTeam || 'Home';
    const away = f.away_team?.team_name || f.away_team?.name || f.awayTeam || 'Away';
    const league = f.league?.competition_name || f.league?.name || f.competition || 'Unknown';

    return {
        id: `fd_${matchId}`,
        homeTeam: home,
        awayTeam: away,
        league,
        category_name: f.league?.country || '',
        tournament_name: league,
        tournament_id: f.league?.competition_id || null,
        home_team_id: f.home_team?.team_id || null,
        away_team_id: f.away_team?.team_id || null,
        startTimestamp: ts,
        timestamp: new Date(ts * 1000).toISOString(),
        status,
        confidence: 50,
        prediction: null,
        verdict: 'PENDING',
        odds_home: f.odds?.home_win || null,
        odds_draw: f.odds?.draw || null,
        odds_away: f.odds?.away_win || null,
        last_updated: Date.now(),
        insufficient_data: 1,
        source: 'footballdata',
        fullData: JSON.stringify({ home, away, league, startTimestamp: ts, status })
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// BLOCK 3: DATABASE UPSERT
// ══════════════════════════════════════════════════════════════════════════════

function upsertMatch(match) {
    try {
        const db = database.db;
        if (!db) return false;

        // Skip already-finished matches
        if (['finished', 'canceled', 'postponed'].includes(match.status)) return false;

        // Skip if already exists
        const existing = db.prepare('SELECT id FROM matches WHERE id = ?').get(match.id);
        if (existing) return false;

        db.prepare(`
            INSERT OR IGNORE INTO matches (
                id, homeTeam, awayTeam, league, category_name, tournament_name,
                tournament_id, home_team_id, away_team_id,
                startTimestamp, timestamp, status,
                confidence, prediction,
                odds_home, odds_draw, odds_away,
                last_updated, insufficient_data, source, fullData
            ) VALUES (
                @id, @homeTeam, @awayTeam, @league, @category_name, @tournament_name,
                @tournament_id, @home_team_id, @away_team_id,
                @startTimestamp, @timestamp, @status,
                @confidence, @prediction,
                @odds_home, @odds_draw, @odds_away,
                @last_updated, @insufficient_data, @source, @fullData
            )
        `).run(match);
        return true;
    } catch (e) {
        console.warn(`[CLOUD-SEED] upsertMatch error (${match.id}):`, e.message);
        return false;
    }
}

function countMatchesForPeriod(dayOffsetStart, dayOffsetEnd) {
    try {
        const db = database.db;
        const startDate = getDateStr(dayOffsetStart);
        const endDate   = getDateStr(dayOffsetEnd);
        const startTs = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
        const endTs   = Math.floor(new Date(endDate   + 'T23:59:59Z').getTime() / 1000);
        const row = db.prepare(
            `SELECT COUNT(*) as cnt FROM matches WHERE startTimestamp >= ? AND startTimestamp <= ? AND status = 'scheduled'`
        ).get(startTs, endTs);
        return row?.cnt || 0;
    } catch (e) {
        return 0;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN: runCloudSeed
// ══════════════════════════════════════════════════════════════════════════════

async function runCloudSeed() {
    console.log('🌱 [CLOUD-SEED v4] Starting dual-source seeding (RapidAPI → FootballData fallback)...');

    const today    = getDateStr(0);
    const tomorrow = getDateStr(1);
    
    // Check if we already have enough data
    const existingToday    = countMatchesForPeriod(0, 0);
    const existingTomorrow = countMatchesForPeriod(1, 1);
    console.log(`📊 [CLOUD-SEED] Existing: ${existingToday} today / ${existingTomorrow} tomorrow`);

    let rapidApiInserted = 0;
    let fdInserted = 0;

    // ── STEP 1: RapidAPI (Primary) ──────────────────────────────────────────
    // Use quota manager to check remaining budget
    let quotaManager = null;
    try {
        quotaManager = require('../services/rapidApiQuotaManager');
    } catch (_) {}

    const quotaStatus = quotaManager?.getQuotaStatus?.() || { remaining: 20, isActive: true };
    const canUseRapid = quotaStatus.isActive && quotaStatus.remaining > 0;

    if (canUseRapid) {
        console.log(`🎯 [CLOUD-SEED/RAPID] Quota remaining: ${quotaStatus.remaining}/${quotaStatus.limit || 20}`);
        const rapidQuota = quotaStatus.remaining;
        let rapidUsed = 0;
        
        for (const date of [today, tomorrow]) {
            if (rapidUsed >= rapidQuota) break;
            
            const events = await fetchRapidApiEvents(date);
            if (events.length === 0) continue;
            
            // Sort: Tier1 first, then others
            const tier1 = events.filter(isTier1);
            const others = events.filter(e => !isTier1(e));
            const sorted = [...tier1, ...others];
            
            console.log(`  📅 ${date}: ${events.length} events (${tier1.length} Tier1 + ${others.length} others)`);
            
            for (const event of sorted) {
                if (rapidUsed >= rapidQuota) break;
                if (!event.id || !event.homeTeam || !event.awayTeam) continue;
                
                const match = mapRapidEventToMatch(event);
                if (match.status !== 'scheduled') continue;
                
                const inserted = upsertMatch(match);
                if (inserted) {
                    quotaManager?.registerMatch?.(event.id);
                    rapidUsed++;
                    rapidApiInserted++;
                }
                
                await sleep(200); // Polite delay
            }
        }
        console.log(`✅ [CLOUD-SEED/RAPID] Inserted ${rapidApiInserted} matches via RapidAPI.`);
    } else {
        console.log(`🛑 [CLOUD-SEED/RAPID] Quota exhausted or disabled. Skipping RapidAPI.`);
    }

    // ── STEP 2: FootballData.io Fallback ────────────────────────────────────
    // Fill remaining gaps (especially if RapidAPI was exhausted or returned 0)
    const needsMoreToday    = countMatchesForPeriod(0, 0) < 5;  // Less than 5 today
    const needsMoreTomorrow = countMatchesForPeriod(1, 1) < 5;  // Less than 5 tomorrow

    if (needsMoreToday || needsMoreTomorrow) {
        console.log(`🔄 [CLOUD-SEED/FD] Filling gaps with FootballData.io fallback...`);
        
        // Fetch today's fixtures
        if (needsMoreToday) {
            const todayFixtures = await fetchFDFixtures('/fixtures/today');
            for (const f of todayFixtures) {
                const match = mapFDFixtureToMatch(f);
                if (upsertMatch(match)) fdInserted++;
            }
            console.log(`  📅 Today (FD): ${todayFixtures.length} fixtures processed`);
            await sleep(500);
        }

        // Fetch upcoming (tomorrow + next days)
        if (needsMoreTomorrow) {
            const upcomingFixtures = await fetchFDFixtures('/fixtures/upcoming');
            
            // Filter to only tomorrow's fixtures
            const tomorrowStart = Math.floor(new Date(tomorrow + 'T00:00:00Z').getTime() / 1000);
            const tomorrowEnd   = tomorrowStart + 86400;
            
            for (const f of upcomingFixtures) {
                const ts = f.date_unix || f.timestamp || 0;
                if (ts < tomorrowStart || ts > tomorrowEnd) continue;
                const match = mapFDFixtureToMatch(f);
                if (upsertMatch(match)) fdInserted++;
            }
            console.log(`  📅 Tomorrow (FD): ${upcomingFixtures.length} upcoming fixtures checked`);
        }

        console.log(`✅ [CLOUD-SEED/FD] Inserted ${fdInserted} fallback matches.`);
    } else {
        console.log(`✅ [CLOUD-SEED/FD] Enough matches already present. Skipping FootballData fallback.`);
    }

    // ── STEP 3: Summary ──────────────────────────────────────────────────────
    const finalToday    = countMatchesForPeriod(0, 0);
    const finalTomorrow = countMatchesForPeriod(1, 1);
    
    console.log(`\n🏁 [CLOUD-SEED v4] Complete!`);
    console.log(`   ➕ RapidAPI inserted:    ${rapidApiInserted} matches`);
    console.log(`   ➕ FootballData inserted: ${fdInserted} matches`);
    console.log(`   📊 DB now has: ${finalToday} today / ${finalTomorrow} tomorrow (scheduled)`);
    
    if (finalToday + finalTomorrow === 0) {
        console.warn(`⚠️ [CLOUD-SEED] WARNING: No scheduled matches found! Check API keys and quotas.`);
    }
}

async function runCloudSeedModerated() {
    console.log('[CLOUD-SEED v5] Starting moderated seeding (FootballData -> RapidAPI fallback)...');

    const today = getDateStr(0);
    const existingToday = countMatchesForPeriod(0, 0);
    const existingTomorrow = countMatchesForPeriod(1, 1);
    console.log(`[CLOUD-SEED] Existing: ${existingToday} today / ${existingTomorrow} tomorrow`);

    let fdInserted = 0;
    let rapidApiInserted = 0;

    let fdQuotaStatus = fdQuotaManager.getQuotaStatus();
    if (existingToday < 20 && fdQuotaStatus.isActive && fdQuotaStatus.remaining > 0) {
        console.log(`[CLOUD-SEED/FD] Quota remaining: ${fdQuotaStatus.remaining}/${fdQuotaStatus.limit}`);
        const fixtures = await fetchFDFixtures('/fixtures/today');
        console.log(`[CLOUD-SEED/FD] Today: ${fixtures.length} fixtures found`);

        for (const f of fixtures) {
            fdQuotaStatus = fdQuotaManager.getQuotaStatus();
            if (fdQuotaStatus.remaining <= 0) break;

            const fdId = f.match_id || f.id;
            if (!fdId || !fdQuotaManager.canProcessMatch(fdId)) continue;

            const match = mapFDFixtureToMatch(f);
            if (match.status !== 'scheduled') continue;

            if (upsertMatch(match)) {
                fdQuotaManager.registerMatch(fdId);
                fdInserted++;
            }
        }

        console.log(`[CLOUD-SEED/FD] Inserted ${fdInserted} primary matches.`);
    } else {
        console.log('[CLOUD-SEED/FD] Skipped: enough matches, disabled, or daily quota exhausted.');
    }

    const finalAfterFD = countMatchesForPeriod(0, 0);
    const fdFinished = fdQuotaManager.getQuotaStatus().remaining <= 0 || fdInserted === 0;
    const rapidQuotaStatus = rapidApiQuotaManager.getQuotaStatus();
    const canUseRapid = finalAfterFD < 20 && fdFinished && rapidQuotaStatus.isActive && rapidQuotaStatus.remaining > 0;

    if (canUseRapid) {
        console.log(`[CLOUD-SEED/RAPID] Fallback active. Quota remaining: ${rapidQuotaStatus.remaining}/${rapidQuotaStatus.limit}`);
        const events = await fetchRapidApiEvents(today);
        const tier1 = events.filter(isTier1);
        const others = events.filter(e => !isTier1(e));
        const sorted = [...tier1, ...others];
        let rapidUsed = 0;

        console.log(`[CLOUD-SEED/RAPID] ${today}: ${events.length} events (${tier1.length} Tier1 + ${others.length} others)`);

        for (const event of sorted) {
            if (rapidUsed >= rapidQuotaStatus.remaining) break;
            if (!event.id || !event.homeTeam || !event.awayTeam) continue;
            if (!rapidApiQuotaManager.canProcessMatch(event.id)) continue;

            const match = mapRapidEventToMatch(event);
            if (match.status !== 'scheduled') continue;

            if (upsertMatch(match)) {
                rapidApiQuotaManager.registerMatch(event.id);
                rapidUsed++;
                rapidApiInserted++;
            }

            await sleep(200);
        }

        console.log(`[CLOUD-SEED/RAPID] Inserted ${rapidApiInserted} fallback matches.`);
    } else {
        console.log('[CLOUD-SEED/RAPID] Fallback skipped.');
    }

    const finalToday = countMatchesForPeriod(0, 0);
    const finalTomorrow = countMatchesForPeriod(1, 1);
    console.log(`[CLOUD-SEED v5] Complete. FootballData: ${fdInserted}, RapidAPI: ${rapidApiInserted}, DB: ${finalToday} today / ${finalTomorrow} tomorrow.`);

    if (finalToday + finalTomorrow === 0) {
        console.warn('[CLOUD-SEED] WARNING: No scheduled matches found. Check API keys and quotas.');
    }
}

module.exports = { runCloudSeed: runCloudSeedModerated };
