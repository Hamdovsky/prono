/**
 * cloudSeed.js — Titanium Cloud Bootstrap
 *
 * Runs at server startup to seed matches from multiple sources.
 * 
 * STRATEGY:
 *  0. PRIMARY:  Sofascore (free, no API key) — direct HTTP
 *  1. PRIMARY:  FootballData.io — upcoming fixtures
 *  2. FREE:     BSD Bzzoiro — unlimited matches + odds
 *  3. FALLBACK: TheRundown → OddsPapi → Sportmonks → APIFootball
 *  4. RESERVE:  RapidAPI SportAPI — only if still needed
 */

const axios = require('axios');
const database = require('./database');
const { createQuotaManager } = require('../services/sourceQuotaManager');
const rapidApiQuotaManager = require('../services/rapidApiQuotaManager');
const apiFallbackManager = require('../services/apiFallbackManager');
const bsdService = require('../services/bsdService');
const therundownService = require('../services/therundownService');
const oddspapiService = require('../services/oddspapiService');
const sportmonksService = require('../services/sportmonksService');
const apifootballService = require('../services/apifootballService');
const openligadbService = require('../services/openligadbService');

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
// BLOCK 0: SOFASCORE (FREE — NO API KEY NEEDED)
// Uses the public Sofascore API directly to fetch scheduled events per date
// No authentication required, unlimited usage
// ══════════════════════════════════════════════════════════════════════════════

const SOFASCORE_BASE = 'https://www.sofascore.com/api/v1';

async function fetchSofascoreEvents(date) {
    try {
        console.log(`📡 [CLOUD-SEED/SOFASCORE] Fetching ${date}...`);
        const { data } = await axios.get(`${SOFASCORE_BASE}/sport/football/scheduled-events/${date}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Origin': 'https://www.sofascore.com',
                'Referer': 'https://www.sofascore.com/'
            },
            timeout: 15000
        });
        return data?.events || [];
    } catch (e) {
        console.warn(`⚠️ [CLOUD-SEED/SOFASCORE] Failed to fetch ${date}: ${e.message}`);
        return [];
    }
}

function mapSofascoreEventToMatch(event) {
    const ts = event.startTimestamp || Math.floor(Date.now() / 1000);
    const rawStatus = (event.status?.type || '').toLowerCase();
    const status = ['finished', 'canceled', 'postponed', 'inprogress'].includes(rawStatus)
        ? rawStatus : 'scheduled';

    const homeTeam = event.homeTeam?.name || 'Home';
    const awayTeam = event.awayTeam?.name || 'Away';
    const leagueName = event.tournament?.name || 'Unknown';
    const categoryName = event.tournament?.category?.name || '';
    const tournamentName = event.tournament?.uniqueTournament?.name || leagueName;

    return {
        id: `sofascore_${event.id}`,
        homeTeam,
        awayTeam,
        league: tournamentName,
        category_name: categoryName,
        tournament_name: tournamentName,
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
        source: 'sofascore',
        fullData: JSON.stringify({
            id: event.id,
            homeTeam,
            awayTeam,
            league: tournamentName,
            startTimestamp: ts,
            status,
        })
    };
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

        // ✅ Structure correcte: { success, data: { matches: [] } }
        const root = data?.data || data;
        return root?.matches || root?.fixtures || [];
    } catch (e) {
        const status = e.response?.status;
        if (status === 401 || status === 403) {
            console.warn(`⛔ [CLOUD-SEED/FD] Clé invalide (HTTP ${status}). Vérifiez FOOTBALLDATA_KEY.`);
        } else {
            console.warn(`⚠️ [CLOUD-SEED/FD] Failed on ${endpoint}: ${e.message}`);
        }
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

function registerFallbackSources() {
    apiFallbackManager.registerSource({
        name: 'BSD',
        priority: 1,
        isAvailable: () => bsdService.isAvailable(),
        getQuotaStatus: () => ({ available: bsdService.isAvailable() }),
        fetchEvents: (dateStr) => bsdService.fetchEvents(dateStr)
    })
    apiFallbackManager.registerSource({
        name: 'TheRundown',
        priority: 2,
        isAvailable: () => therundownService.isAvailable(),
        getQuotaStatus: () => therundownService.getQuotaStatus(),
        fetchEvents: (dateStr) => therundownService.fetchSoccerEvents(dateStr),
        fetchOdds: (eventId) => therundownService.fetchOddsForMatch(eventId)
    })
    apiFallbackManager.registerSource({
        name: 'OddsPapi',
        priority: 3,
        isAvailable: () => oddspapiService.isAvailable(),
        getQuotaStatus: () => oddspapiService.getQuotaStatus(),
        fetchEvents: (dateStr) => oddspapiService.fetchEvents(dateStr),
        fetchOdds: (fixtureId) => oddspapiService.fetchOddsForFixture(fixtureId)
    })
    apiFallbackManager.registerSource({
        name: 'Sportmonks',
        priority: 4,
        isAvailable: () => sportmonksService.isAvailable(),
        getQuotaStatus: () => sportmonksService.getQuotaStatus(),
        fetchEvents: (dateStr) => sportmonksService.fetchEvents(dateStr),
        fetchOdds: (fixtureId) => sportmonksService.fetchPrematchOdds(fixtureId)
    })
    apiFallbackManager.registerSource({
        name: 'APIFootball',
        priority: 5,
        isAvailable: () => apifootballService.isAvailable(),
        getQuotaStatus: () => apifootballService.getQuotaStatus(),
        fetchEvents: (dateStr) => apifootballService.fetchEvents(dateStr),
        fetchOdds: (fixtureId) => apifootballService.fetchOdds(fixtureId)
    })
    apiFallbackManager.registerSource({
        name: 'OpenLigaDB',
        priority: 6,
        isAvailable: () => openligadbService.isAvailable(),
        getQuotaStatus: () => ({ available: openligadbService.isAvailable() }),
        fetchEvents: (dateStr) => openligadbService.fetchEvents(dateStr),
    })
    apiFallbackManager.registerSource({
        name: 'Sofascore',
        priority: 0,
        isAvailable: () => true,
        getQuotaStatus: () => ({ available: true }),
        fetchEvents: (dateStr) => fetchSofascoreEvents(dateStr).then(events => events.map(mapSofascoreEventToMatch)),
    })
    console.log('[CLOUD-SEED/FALLBACK] Registered API sources (Sofascore[free] → BSD → TheRundown → OddsPapi → Sportmonks → APIFootball → OpenLigaDB)')
}

async function runCloudSeed() {
    registerFallbackSources()
    console.log('[CLOUD-SEED] Starting multi-source seeding (FootballData -> BSD -> RapidAPI)...');

    const today = getDateStr(0);
    const existingToday = countMatchesForPeriod(0, 0);
    const existingTomorrow = countMatchesForPeriod(1, 1);
    console.log(`[CLOUD-SEED] Existing: ${existingToday} today / ${existingTomorrow} tomorrow`);

    let fdInserted = 0;
    let rapidApiInserted = 0;
    let sofascoreInserted = 0;

    // ── STEP 0: Sofascore (FREE — no API key needed) ══ PRIORITY ══
    console.log('[CLOUD-SEED/SOFASCORE] Seeding from free public API...')
    try {
        const datesToFetch = [today, getDateStr(1)]
        for (const dateStr of datesToFetch) {
            const events = await fetchSofascoreEvents(dateStr)
            console.log(`[CLOUD-SEED/SOFASCORE] ${events.length} events found for ${dateStr}`)

            const notstarted = events.filter(e => (e.status?.type || '').toLowerCase() === 'notstarted')
            console.log(`[CLOUD-SEED/SOFASCORE] ${notstarted.length} not-started matches to insert for ${dateStr}`)

            for (const event of notstarted) {
                if (!event.id || !event.homeTeam?.name || !event.awayTeam?.name) continue
                const match = mapSofascoreEventToMatch(event)
                if (upsertMatch(match)) sofascoreInserted++
            }
        }
        console.log(`[CLOUD-SEED/SOFASCORE] Inserted ${sofascoreInserted} free matches total.`)
    } catch (e) {
        console.warn(`⚠️ [CLOUD-SEED/SOFASCORE] Error: ${e.message}`)
    }

    let fdQuotaStatus = fdQuotaManager.getQuotaStatus();
    if (existingToday < 20 && fdQuotaStatus.isActive && fdQuotaStatus.remaining > 0) {
        console.log(`[CLOUD-SEED/FD] Quota remaining: ${fdQuotaStatus.remaining}/${fdQuotaStatus.limit}`);
        // ✅ Bon endpoint: /fixtures/upcoming retourne les prochains matches
        const fixtures = await fetchFDFixtures('/fixtures/upcoming');
        console.log(`[CLOUD-SEED/FD] Upcoming: ${fixtures.length} fixtures found`);

        // Filtrer seulement aujourd'hui et demain
        const today = getDateStr(0);
        const tomorrow = getDateStr(1);
        const filtered = fixtures.filter(f => {
            const d = (f.match_date || f.date || '').substring(0, 10);
            return d === today || d === tomorrow;
        });
        console.log(`[CLOUD-SEED/FD] Filtered today+tomorrow: ${filtered.length} fixtures`);

        for (const f of filtered) {
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

    // ── STEP 2: BSD Bzzoiro Sports Data (free, unlimited) ══ PRIORITY ══
    try {
      if (bsdService.isAvailable()) {
        console.log('[CLOUD-SEED/BSD] Primary seeding with Bzzoiro Sports Data...')
        try {
          const bsdCount = await bsdService.fullSync()
          console.log(`[CLOUD-SEED/BSD] Inserted ${bsdCount} matches`)
          console.log('[CLOUD-SEED/BSD] Enriching odds for all matches...')
          const enriched = await bsdService.enrichAllMatchesOdds()
          console.log(`[CLOUD-SEED/BSD] Odds enriched for ${enriched} matches`)
        } catch (bsdErr) {
          console.warn(`[CLOUD-SEED/BSD] Error during fullSync: ${bsdErr.message}`)
          console.warn(`[CLOUD-SEED/BSD] Stack: ${bsdErr.stack?.substring(0, 500)}`)
        }
      } else {
        console.log('[CLOUD-SEED/BSD] Skipped: not available (no API key or service disabled).')
      }
    } catch (outerErr) {
      console.warn(`[CLOUD-SEED/BSD] Outer error: ${outerErr.message}`)
    }

    // ── STEP 3: API Fallback tier (Sofascore → TheRundown → OddsPapi → Sportmonks → APIFootball → OpenLigaDB)
    const fbFallbackSources = [
      { name: 'Sofascore', fetch: () => fetchSofascoreEvents(today).then(events => events.map(mapSofascoreEventToMatch)), available: () => true },
      { name: 'TheRundown', fetch: () => therundownService.fetchSoccerEvents(today).then(events => events.map(e => therundownService.mapEventToMatch(e))), available: () => therundownService.isAvailable() },
      { name: 'OddsPapi',   fetch: () => oddspapiService.fetchEvents(today),              available: () => oddspapiService.isAvailable() },
      { name: 'Sportmonks', fetch: () => sportmonksService.fetchEvents(today),            available: () => sportmonksService.isAvailable() },
      { name: 'APIFootball',fetch: () => apifootballService.fetchEvents(today),           available: () => apifootballService.isAvailable() },
      { name: 'OpenLigaDB', fetch: () => openligadbService.fetchEvents(today),            available: () => openligadbService.isAvailable() },
    ]

    const currentCount = countMatchesForPeriod(0, 0)
    if (currentCount < 20) {
      for (const src of fbFallbackSources) {
        if (!src.available()) {
          console.log(`[CLOUD-SEED/FALLBACK] ${src.name}: skipped (not available)`)
          continue
        }
        if (countMatchesForPeriod(0, 0) >= 20) break
        try {
          const matches = await src.fetch()
          if (!matches?.length) {
            console.log(`[CLOUD-SEED/FALLBACK] ${src.name}: returned 0 matches`)
            continue
          }
          let inserted = 0
          for (const match of matches) {
            if (match.status !== 'scheduled') continue
            if (upsertMatch(match)) inserted++
          }
          console.log(`[CLOUD-SEED/FALLBACK] ${src.name}: inserted ${inserted}/${matches.length} matches`)
          await sleep(500)
        } catch (e) {
          console.warn(`[CLOUD-SEED/FALLBACK] ${src.name}: error — ${e.message}`)
        }
      }
    } else {
      console.log('[CLOUD-SEED/FALLBACK] Skipped: enough matches already seeded.')
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
    console.log(`[CLOUD-SEED] Complete. Sofascore: ${sofascoreInserted}, FootballData: ${fdInserted}, RapidAPI: ${rapidApiInserted}, DB: ${finalToday} today / ${finalTomorrow} tomorrow.`);

    if (finalToday + finalTomorrow === 0) {
        console.warn('[CLOUD-SEED] WARNING: No scheduled matches found. Check API keys and quotas.');
    }
}

module.exports = { runCloudSeed };
