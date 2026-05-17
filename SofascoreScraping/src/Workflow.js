const Extractor = require('./Extractor');
const persistence = require('./Persistence');
const { injectHistoricalData } = require('../../src/services/HistoricalInjector');
const fs = require('fs');
const path = require('path');
const PlayerImpactService = require('./PlayerImpactService');
const PlayerPropsScraper = require('./PlayerPropsScraper');
const TacticalService = require('../../services/tactical_service');
const newsService = require('../../src/services/newsService');
const IntegrityService = require('../../services/integrity_service');
const AdvancedAnalyticsEngine = require('../../src/services/AdvancedAnalyticsEngine');
const { LEAGUE_MAP } = require('../../config/leagueRegistry');
const configEngine = require('../../core/configEngine');
const pythonService = require('../../core/pythonService');
const NeuralMetaRefiner = require('../../services/NeuralMetaRefiner');
const ConfidenceCalibrationEngine = require('../../services/ConfidenceCalibrationEngine');

// Use robust API wrapper for retries, User-Agent rotation, and bypassing bans
const { fetchWithRetry, SofaAPI } = require('./apiClient');

// ── Shared progress file (IPC between scraper process and server) ────────────
const PROGRESS_FILE = path.join(__dirname, '../../data/scraper_progress.json');
const STATE_FILE = path.join(__dirname, '../../data/scraper_state.json');

function writeProgress(data) {
    try {
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ ...data, lastUpdated: new Date().toISOString() }, null, 2));
    } catch (_) { /* non-fatal */ }
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (_) { }
    return { lastFullScan: 0 };
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (_) { }
}

// Redis Cache Service
const { getCache, setCache, printCacheMetrics } = require('../../core/redisClient');
const { performance } = require('perf_hooks');

const REDIS_TTL_STATS = 43200; // 12 hours
const REDIS_TTL_H2H = 86400; // 24 hours
const REDIS_TTL_FORM = 43200; // 12 hours
const REDIS_TTL_STANDINGS = 43200; // 12 hours

/**
 * Fetch season statistics for one team — returns per-match averages.
 */
async function fetchTeamStats(teamId, uniqueTournamentId, seasonId) {
    const cacheKey = `stats_${teamId}_${uniqueTournamentId}_${seasonId}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return cachedData;

    try {
        const data = await SofaAPI.getTeamStats(teamId, uniqueTournamentId, seasonId);
        if (!data || !data.statistics) return null;
        const s = data.statistics;

        const mp = s.matches || s.matchesPlayed || 0;
        if (!mp || mp === 0) return null;

        const statsObj = {
            // --- GENERAL & POSSESSION ---
            matchesPlayed: mp,
            avgRating: +(s.averageRating || 6.5).toFixed(2),
            avgPossession: +(s.averageBallPossession || 50).toFixed(1),
            expectedGoals: +(s.expectedGoals || s.goalsScored || 1.0).toFixed(2),

            // --- ATTACKING & SHOOTING ---
            avgGoalsScored: +((s.goalsScored || 0) / mp).toFixed(2),
            avgShots: +((s.shots || 0) / mp).toFixed(2),
            avgShotsOnTarget: +((s.shotsOnTarget || 0) / mp).toFixed(2),
            avgShotsOffTarget: +((s.shotsOffTarget || 0) / mp).toFixed(2),
            avgShotsInsideBox: +((s.shotsFromInsideTheBox || 0) / mp).toFixed(2),
            avgShotsOutsideBox: +((s.shotsFromOutsideTheBox || 0) / mp).toFixed(2),
            avgBigChances: +((s.bigChances || 0) / mp).toFixed(2),
            avgBigChancesCreated: +((s.bigChancesCreated || 0) / mp).toFixed(2),
            avgBigChancesMissed: +((s.bigChancesMissed || 0) / mp).toFixed(2),
            avgSuccessfulDribbles: +((s.successfulDribbles || 0) / mp).toFixed(2),
            hitWoodwork: s.hitWoodwork || 0,
            fastBreaks: s.fastBreaks || 0,
            fastBreakGoals: s.fastBreakGoals || 0,

            // --- PASSING & BUILD-UP ---
            avgPasses: +((s.totalPasses || 0) / mp).toFixed(2),
            avgAccuratePasses: +((s.accuratePasses || 0) / mp).toFixed(2),
            passAccuracyPct: +(s.accuratePassesPercentage || 0).toFixed(1),
            avgOwnHalfPasses: +((s.totalOwnHalfPasses || 0) / mp).toFixed(2),
            avgOppositionHalfPasses: +((s.totalOppositionHalfPasses || 0) / mp).toFixed(2),
            avgAccurateLongBalls: +((s.accurateLongBalls || 0) / mp).toFixed(2),
            avgAccurateCrosses: +((s.accurateCrosses || 0) / mp).toFixed(2),

            // --- DEFENDING & PRESSURE ---
            avgGoalsConceded: +((s.goalsConceded || 0) / mp).toFixed(2),
            cleanSheets: s.cleanSheets || 0,
            avgTackles: +((s.tackles || 0) / mp).toFixed(2),
            avgInterceptions: +((s.interceptions || 0) / mp).toFixed(2),
            avgClearances: +((s.clearances || 0) / mp).toFixed(2),
            avgSaves: +((s.saves || 0) / mp).toFixed(2),
            errorsLeadingToGoal: s.errorsLeadingToGoal || 0,
            errorsLeadingToShot: s.errorsLeadingToShot || 0,
            avgDuelsWon: +((s.duelsWon || 0) / mp).toFixed(2),
            duelsWonPct: +(s.duelsWonPercentage || 0).toFixed(1),
            avgAerialDuelsWon: +((s.aerialDuelsWon || 0) / mp).toFixed(2),
            avgPossessionLost: +((s.possessionLost || 0) / mp).toFixed(2),

            // --- DISCIPLINE & SET PIECES ---
            avgFouls: +((s.fouls || 0) / mp).toFixed(2),
            avgCorners: +((s.corners || s.cornerKicks || 0) / mp).toFixed(2),
            avgOffsides: +((s.offsides || 0) / mp).toFixed(2),
            yellowCards: s.yellowCards || 0,
            redCards: s.redCards || 0,
            penaltiesConceded: s.penaltiesCommited || 0,
            penaltyGoalsConceded: s.penaltyGoalsConceded || 0
        };

        await setCache(cacheKey, statsObj, REDIS_TTL_STATS);
        return statsObj;
    } catch (err) {
        console.warn(`⚠️ [V90 FALLBACK] Sofascore API failed for Team ${teamId}. Marking as insufficient data.`);
        return {
            insufficient_data: true,
            matchesPlayed: 0,
            avgRating: 6.5,
            avgGoalsScored: 1.0,
            avgGoalsConceded: 1.0
        };
    }
}

/**
 * Fetch Head-to-Head history for a match.
 */
async function fetchH2H(matchId, homeId, awayId) {
    const cacheKey = `h2h_${Math.min(homeId, awayId)}_${Math.max(homeId, awayId)}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return cachedData;

    try {
        const data = await SofaAPI.getH2H(matchId);
        const events = data?.events?.slice(0, 5) || [];
        if (events.length > 0) await setCache(cacheKey, events, REDIS_TTL_H2H);
        return events;
    } catch (_) { return null; }
}

/**
 * Fetch last 5 matches (Form) for a team in a specific tournament.
 */
async function fetchTeamForm(teamId, tournamentId, seasonId) {
    const cacheKey = `form_${teamId}_${tournamentId}_${seasonId}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return cachedData;

    try {
        const data = await SofaAPI.getTeamForm(teamId, tournamentId, seasonId);
        const events = data?.events || [];
        if (events.length > 0) await setCache(cacheKey, events, REDIS_TTL_FORM);
        return events;
    } catch (_) { return null; }
}

/**
 * Fetch current league standings.
 */
async function fetchStandings(tournamentId, seasonId) {
    const cacheKey = `standing_${tournamentId}_${seasonId}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return cachedData;

    try {
        const data = await SofaAPI.getStandings(tournamentId, seasonId);
        const rows = data?.standings?.[0]?.rows || []; 
        if (rows.length > 0) await setCache(cacheKey, rows, REDIS_TTL_STANDINGS);
        return rows;
    } catch (_) { return null; }
}

/**
 * Convert raw Sofascore form events into per-match averages.
 * Produces the fields that prediction_engine.py reads:
 *   tw_xG_scored, tw_xG_conceded, avgGoals, avgGoalsConceded, winRate
 *
 * @param {Array} events  – last N events from fetchTeamForm()
 * @param {string|number} teamId – used to distinguish home/away perspective
 * @returns {object|null}
 */
function computeFormAverages(events, teamId) {
    if (!Array.isArray(events) || events.length === 0) {
        return {
            tw_xG_scored: 1.0,
            tw_xG_conceded: 1.0,
            avgGoals: 1.0,
            avgGoalsConceded: 1.0,
            winRate: 0.33,
            matchesAnalyzed: 0
        };
    }

    const tid = String(teamId);
    let goalsScored = 0, goalsConceded = 0, xgScored = 0, xgConceded = 0, wins = 0;
    let count = 0;

    for (const ev of events) {
        const isHome = String(ev.homeTeam?.id) === tid;
        const gs = isHome
            ? (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0)
            : (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0);
        const gc = isHome
            ? (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0)
            : (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0);

        // Sofascore sometimes exposes xG at match level
        const xgS = isHome
            ? (ev.homeXg ?? ev.homeScore?.expectedGoals ?? gs)
            : (ev.awayXg ?? ev.awayScore?.expectedGoals ?? gs);
        const xgC = isHome
            ? (ev.awayXg ?? ev.awayScore?.expectedGoals ?? gc)
            : (ev.homeXg ?? ev.homeScore?.expectedGoals ?? gc);

        goalsScored   += gs;
        goalsConceded += gc;
        xgScored      += xgS;
        xgConceded    += xgC;
        if (gs > gc) wins++;
        count++;
    }

    if (count === 0) {
        return {
            tw_xG_scored: 1.0,
            tw_xG_conceded: 1.0,
            avgGoals: 1.0,
            avgGoalsConceded: 1.0,
            winRate: 0.33,
            matchesAnalyzed: 0
        };
    }

    return {
        tw_xG_scored:    +(xgScored   / count).toFixed(2),
        tw_xG_conceded:  +(xgConceded / count).toFixed(2),
        avgGoals:        +(goalsScored   / count).toFixed(2),
        avgGoalsConceded:+(goalsConceded / count).toFixed(2),
        winRate:         +(wins / count).toFixed(2),
        points:          wins * 3 + (count - wins - (events.filter(ev => {
            const isHome = String(ev.homeTeam?.id) === tid;
            const gs = isHome ? (ev.homeScore?.current || 0) : (ev.awayScore?.current || 0);
            const gc = isHome ? (ev.awayScore?.current || 0) : (ev.homeScore?.current || 0);
            return gs < gc;
        }).length)) * 1, // count - wins - losses = draws
        matchesAnalyzed: count
    };
}

const { ELITE_CLUBS_SEARCH } = require('../../config/eliteClubs');

const AliasResolver = require('./AliasResolver');

class Workflow {
    constructor(leagues) {
        this.leagues = leagues || [];
        // Delay resolver instantiation until after database.init() in start()
        this.resolver = null;
        this.impactService = new PlayerImpactService();
    }

    async getLocalDateString(offset = 0) {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    async start() {
        await persistence.init();
        
        // Finalize initialization after DB is ready
        this.resolver = new AliasResolver(persistence.db);
        this.resolver.seedMasterNames();

        try {
            const state = loadState();
            const now = Date.now();
            const sixHours = 6 * 60 * 60 * 1000;
            const needsFullScan = (now - state.lastFullScan) > sixHours;

            // 🧠 [INCREMENTAL SCAN] 
            // If we did a full scan recently, only fetch Yesterday, Today, and Tomorrow.
            // This avoids "Starting from zero" and saves massive bandwidth.
            const range = needsFullScan ? { start: -1, end: 4 } : { start: -1, end: 2 };
            
            if (!needsFullScan) {
                console.log(`📡 [INCREMENTAL] Recent full scan found (${Math.round((now - state.lastFullScan) / 1000 / 60)}m ago). Scanning only Yesterday/Today/Tomorrow.`);
            } else {
                console.log('📡 [FULL SCAN] Performing complete 4-day event sweep...');
            }

            const datesToFetch = [];
            for (let i = range.start; i <= range.end; i++) {
                datesToFetch.push(await this.getLocalDateString(i));
            }

            const allEvents = [];
            for (const d of datesToFetch) {
                console.log(`📡 [API] Fetching scheduled events for: ${d}`);
                try {
                    const data = await SofaAPI.getEvents(d);
                    const events = data.events || [];
                    console.log(`📊 [API] Found ${events.length} events for ${d}`);
                    allEvents.push(...events);
                } catch (e) {
                    console.error(`❌ [API] Error fetching for ${d}:`, e.message);
                }
            }

            if (needsFullScan) {
                saveState({ ...state, lastFullScan: now });
            }

            console.log(`📊 [API] Total merged events: ${allEvents.length}`);

            // 🎯 [V54] PRIORITY TOURNAMENT SWEEP (Missing but Wanted Leagues)
            if (needsFullScan) {
                console.log('🎯 [V54] Checking for priority tournaments requiring forced sync...');
                const forceLeagues = Object.values(LEAGUE_MAP).filter(l => l.forceSync && l.sofascoreId);
                
                for (const fl of forceLeagues) {
                    try {
                        console.log(`📡 [FORCE] Syncing ${fl.displayName} (ID: ${fl.sofascoreId})...`);
                        const seasonsRes = await SofaAPI.getTournamentSeasons(fl.sofascoreId);
                        if (seasonsRes && seasonsRes.seasons && seasonsRes.seasons.length > 0) {
                            const currentSeasonId = seasonsRes.seasons[0].id;
                            
                            // Fetch NEXT and LAST (to catch today's live/finished matches)
                            const nextRes = await SofaAPI.getTournamentEvents(fl.sofascoreId, currentSeasonId, 'next');
                            const lastRes = await SofaAPI.getTournamentEvents(fl.sofascoreId, currentSeasonId, 'last');
                            
                            const merged = [...(nextRes.events || []), ...(lastRes.events || [])];
                            let added = 0;
                            merged.forEach(ev => {
                                if (!allEvents.find(existing => existing.id === ev.id)) {
                                    allEvents.push(ev);
                                    added++;
                                }
                            });
                            console.log(`✅ [FORCE] Added ${added} unique events for ${fl.displayName}`);
                        }
                    } catch (e) {
                        console.error(`❌ [FORCE] Failed ${fl.displayName}:`, e.message);
                    }
                }
            } else {
                console.log('🎯 [V54] Skipping forced priority sync (Incremental Mode) to save time/bandwidth...');
            }

            const targetMatches = [];
            const skippedLeagues = new Set();
            const seenMatchIds = new Set();

            for (const event of allEvents) {
                // 🛡️ [PREMATCH ONLY] Skip matches that are already in progress
                const status = (event.status?.type || 'scheduled').toLowerCase();
                if (['live', 'inprogress', '1h', '2h', 'ht', 'ongoing'].includes(status)) continue;

                const match = Extractor.extractMatch(event);
                if (!match) continue;

                // ⚡ [ID RESOLVER] Final Professional Normalization
                match.homeTeam = this.resolver.resolve(match.home_team_id, match.homeTeam);
                match.awayTeam = this.resolver.resolve(match.away_team_id, match.awayTeam);
                match.home = match.homeTeam; // Sync old fields
                match.away = match.awayTeam;
                
                // 🏆 [LEAGUE RESOLVER] Standardize League Name
                match.league = this.resolver.resolveTournament(match.league, match.category_name);

                // 🎯 [STRICT TARGET LEAGUES] Only process matches from our configured target leagues
                const mCountry = (match.category_name || '').toLowerCase().replace(/\s+/g, '-');
                const mLeague = (match.tournament_name || match.league || '').toLowerCase().replace(/\s+/g, '-');
                
                const isTargetLeague = this.leagues.some(l => 
                    (l.country === mCountry || mCountry.includes(l.country)) && 
                    (mLeague.includes(l.league) || l.league.includes(mLeague))
                );
                
                if (!isTargetLeague) {
                    skippedLeagues.add(match.category_name + ' - ' + match.tournament_name);
                    continue;
                }
                
                // Attach raw event metadata for team stats fetching
                match._homeTeamId = event.homeTeam?.id;
                match._awayTeamId = event.awayTeam?.id;
                match._uniqueTournament = event.tournament?.uniqueTournament?.id;
                match._seasonId = event.season?.id;
                match._slug = event.slug || '';
                match._sofaMatchId = event.id;

                // 🏆 [V25] Resolve League Tier for Reliability/Liquidity synthesis
                const lgConfig = Object.values(LEAGUE_MAP).find(l => 
                    l.sofascoreSlug === event.tournament?.uniqueTournament?.slug ||
                    match.league.toLowerCase().includes(l.name.toLowerCase())
                );
                match.league_tier = lgConfig?.tier || 'TIER2';

                // ⚡ [O(N) DEDUPLICATION] Faster than .find() for 500+ matches
                if (!seenMatchIds.has(match.id)) {
                    targetMatches.push(match);
                    seenMatchIds.add(match.id);
                }
            }

            if (targetMatches.length < 10 && skippedLeagues.size > 0) {
                console.log("⚠️ [DEBUG] Very few matches found in target leagues. Sample of skipped leagues:");
                console.log(Array.from(skippedLeagues).slice(0, 10).join(', '));
            }

            // [DEBUG] Log skipped Moroccan/Saudi matches
            allEvents.forEach(event => {
                const cName = (event.tournament?.category?.name || "").toLowerCase();
                if (cName.includes('morocco') || cName.includes('saudi')) {
                    console.log(`🔍 [DEBUG] RAW DETECT: ${event.homeTeam?.name} vs ${event.awayTeam?.name} | Category: ${event.tournament?.category?.name} | Tournament: ${event.tournament?.name}`);
                }
            });

            // 🧠 [TITANIUM FRESHNESS ENGINE — PREMATCH ONLY]
            const shouldSkip = (match, existing) => {
                if (!existing) return false;

                // PREMATCH-ONLY POLICY:
                // 1. Never re-process live matches — scraper is prematch-only.
                //    Live events are already filtered out above, but if the DB
                //    has a lingering 'live' status entry we skip it too.
                if (match.status === 'live' || existing.status === 'live') return true;

                // 2. Scheduled matches starting in < 3h re-process if data is stale (> 30 min old)
                const now = Date.now() / 1000;
                const start = match.startTimestamp || existing.startTimestamp;
                const timeToStart = start - now;
                const isSoon = timeToStart > -7200 && timeToStart < 21600; // -2h to +6h window (V55 Expansion)
                const isStale = (Date.now() - (existing.last_updated || 0)) > 30 * 60 * 1000;

                if (isSoon && isStale) return false;

                // 3. If match has no odds but now we found them, re-process to capture odds
                if (existing && !existing.odds_home && match.odds_home) return false;

                return true;
            };

            console.log(`🎯 [FILTER] Starting pre-scan of ${targetMatches.length} raw events...`);
            const remainingMatches = [];
            let skippedCount = 0;
            
            for (const m of targetMatches) {
                const existing = persistence.getMatch(m.id);
                if (shouldSkip(m, existing)) {
                    skippedCount++;
                    persistence.heartbeat(m.id).catch(()=>{});
                } else {
                    remainingMatches.push(m);
                }
            }

            // Replace the array contents so the loop only processes missing matches
            targetMatches.length = 0;
            targetMatches.push(...remainingMatches);

            const total = targetMatches.length;
            console.log(`🎯 [RESUME] Fast-forwarded ${skippedCount} already-analyzed matches.`);
            console.log(`🎯 [WORKFLOW] Starting analysis on the remaining ${total} matches.`);

            // ── Progress bar helper ──────────────────────────────────────────
            function printProgress(done, total, failed = 0) {
                const pct = total === 0 ? 100 : Math.round((done / total) * 100);
                const remaining = Math.max(0, total - done);
                const barLen = 20;
                const filled = Math.max(0, Math.min(barLen, Math.round((pct / 100) * barLen)));
                const empty = Math.max(0, barLen - filled);
                const bar = '█'.repeat(filled) + '░'.repeat(empty);
                process.stdout.write(
                    `\r  ⚙️  [${bar}] ${done}/${total} (${pct}%) ─ Erreurs: ${failed} ─ Reste: ${remaining} `
                );
                if (done >= total && total > 0) process.stdout.write('\n');
                // Write to shared progress file for the server to read
                writeProgress({ isRunning: done < total, total, done, failed, percent: pct, remaining });
            }

            let done = 0;
            let failed = 0;
            const initialPct = total === 0 ? 100 : Math.round((done / total) * 100);
            
            // First status update of the cycle happens HERE
            writeProgress({ 
                isRunning: true, 
                total, 
                done, 
                failed: 0,
                percent: initialPct, 
                remaining: Math.max(0, total - done), 
                startedAt: new Date().toISOString(),
                currentTask: 'Initializing Batch Processing...',
                currentLeague: 'N/A'
            });

            if (total > 0) printProgress(done, total);

            const processMatch = async (match) => {
                const stepStart = performance.now();
                try {
                    const matchId = match.id;
                    const existing = persistence.getMatch(matchId);

                    if (shouldSkip(match, existing)) {
                        await persistence.heartbeat(matchId);
                        return; // SKIP
                    }

                    if (existing) {
                        console.log(`🔄 [REFRESH] ${match.homeTeam} vs ${match.awayTeam} (${match.status}) - Refreshing data...`);
                    } else {
                        console.log(`🆕 [NEW] ${match.homeTeam} vs ${match.awayTeam} - Initial analysis...`);
                    }

                    // 📡 [REPORT] Update progress with current match details
                    writeProgress({ 
                        isRunning: true, total, done, failed, 
                        percent: Math.round((done / total) * 100), 
                        remaining: total - done,
                        currentTask: `${match.homeTeam} vs ${match.awayTeam}`,
                        currentLeague: match.league
                    });



                    // 💨 [ULTRA-LIGHT MODE] Skip heavy fetches for non-live T3 leagues to save 60% bandwidth
                    const isT3NotLive = match.league_tier === 'TIER3' && match.status !== 'live';
                    
                    // ── Parallel Extraction of Season Stats & Deep Details (PREMATCH ONLY) ───
                    // matchGraph is never fetched — scraper is prematch only.
                    const [homeStats, awayStats, eventDetails, h2h, homeForm, awayForm, standings, matchLineups, matchStats] = await Promise.all([
                        fetchTeamStats(match._homeTeamId, match._uniqueTournament, match._seasonId),
                        fetchTeamStats(match._awayTeamId, match._uniqueTournament, match._seasonId),
                        SofaAPI.getMatchDetails(matchId),
                        fetchH2H(matchId, match._homeTeamId, match._awayTeamId),
                        fetchTeamForm(match._homeTeamId, match._uniqueTournament, match._seasonId),
                        fetchTeamForm(match._awayTeamId, match._uniqueTournament, match._seasonId),
                        fetchStandings(match._uniqueTournament, match._seasonId),
                        (isT3NotLive ? Promise.resolve(null) : SofaAPI.getLineups(matchId)),
                        (isT3NotLive ? Promise.resolve(null) : SofaAPI.getMatchStats(matchId))
                    ]);

                    const rootEvent = eventDetails?.event || null;
                    // [PREMATCH ONLY] No live score updates — scraper processes only pre-game data.
                    
                    // ── Phase 2: Metadata & Intelligence (PARALLEL) ───
                    const newsEnabled = configEngine.get('DEEP_NEWS_ENABLED', false);
                    const [refStats, oddsData, newsIntel] = await Promise.all([
                        (rootEvent?.referee?.id ? SofaAPI.getRefereeStats(rootEvent.referee.id) : Promise.resolve(null)),
                        SofaAPI.getOddsFeatured(matchId).catch(() => null),
                        newsEnabled
                            ? newsService.getMatchIntelligence(match._sofaMatchId, match.homeTeam, match.awayTeam, match.timestamp, { 
                                countryHint: match.category || '',
                                homeTeamId: match._homeTeamId,
                                awayTeamId: match._awayTeamId
                            }).catch(() => null)
                            : Promise.resolve(null)  // 🛡️ [FAST MODE] Skip news when disabled
                    ]);

                    // 🏛️ [REFEREE PRO]
                    if (refStats && refStats.statistics) {
                        const s = refStats.statistics;
                        match.referee_id = rootEvent.referee.id;
                        match.referee_yellow_avg = +(s.yellowCards || 0).toFixed(2);
                        match.referee_red_avg = +(s.redCards || 0).toFixed(2);
                        match.referee_penalties_avg = +(s.penalties || 0).toFixed(2);
                        
                        // Default home win rate (can be improved in Phase 3 if needed)
                        match.referee_home_win_rate = 0.45;
                    }

                    // 🌦️ [ENVIRONMENT] Map Weather to Top-Level
                    if (rootEvent?.venue?.weather) {
                        const w = rootEvent.venue.weather;
                        match.weather_temp = w.temperature ? parseFloat(w.temperature) : null;
                        match.weather_desc = w.description || null;
                        match.weather_humidity = w.humidity ? parseFloat(w.humidity) : null;
                    }
                    
                    // 💰 [ODDS]
                    if (oddsData?.featured) {
                        const featured = oddsData.featured;
                        const market = featured.default || featured.fullTime || Object.values(featured)[0];
                        if (market?.choices) {
                            const parseSofaOdds = (choice) => {
                                if (choice.decimalValue) return parseFloat(choice.decimalValue);
                                const raw = choice.fractionalValue;
                                if (typeof raw === 'string' && raw.includes('/')) {
                                    const [num, den] = raw.split('/');
                                    return (parseFloat(num) / parseFloat(den)) + 1;
                                }
                                return parseFloat(raw);
                            };
                            market.choices.forEach(choice => {
                                const name = choice.name?.toLowerCase();
                                const val = parseSofaOdds(choice);
                                if (val && val > 1) {
                                    if (name === '1' || name === 'home') match.odds_home = val;
                                    else if (name === 'x' || name === 'draw') match.odds_draw = val;
                                    else if (name === '2' || name === 'away') match.odds_away = val;
                                }
                            });
                        }
                    }

                    if (newsIntel) {
                        match.news_data = newsIntel;
                    }
                    
                    // 📊 [V22] Capture Granular Tactical Stats
                    if (matchStats && matchStats.statistics) {
                        match.stats = matchStats.statistics; 
                        console.log(`📊 [STATS] Deep Tactical data captured for ${match.home} vs ${match.away}`);
                    }

                    // Extract deep metadata (referee, venue, cards) and Coaches/Managers
                    match.details = {
                        referee: rootEvent?.referee?.name || 'V.A.R.',
                        stadium: rootEvent?.venue?.stadium?.name || 'Unknown Stadium',
                        stadiumCapacity: rootEvent?.venue?.stadium?.capacity || null,
                        attendance: rootEvent?.attendance || null,
                        weather: rootEvent?.venue?.weather || null,
                        homeRedCards: rootEvent?.homeRedCards || 0,
                        awayRedCards: rootEvent?.awayRedCards || 0,
                        homeManager: rootEvent?.homeTeam?.manager?.name || null,
                        awayManager: rootEvent?.awayTeam?.manager?.name || null,
                    };

                    // 🎯 [PHASE 2] Extract and Process Player Props from Lineups
                    if (matchLineups) {
                        match.lineups_confirmed = matchLineups.confirmed || false;
                        if (match.lineups_confirmed) {
                            console.log(`✅ [LINEUPS] Official confirmed squads detected for ${match.home} vs ${match.away}`);
                        }
                        try {
                            if (matchLineups.home && matchLineups.home.players) {
                                // ⚡ [SYNC FIX] Await props scraping to prevent hidden socket pileup
                                await PlayerPropsScraper.processTeamLineupForProps(matchLineups.home.players, match.homeTeam?.name, match._uniqueTournament, match._seasonId);
                            }
                            if (matchLineups.away && matchLineups.away.players) {
                                await PlayerPropsScraper.processTeamLineupForProps(matchLineups.away.players, match.awayTeam?.name, match._uniqueTournament, match._seasonId);
                            }
                        } catch (e) { /* ignore json parse errors */ }
                    }

                    match.teamStats = { home: homeStats, away: awayStats };
                    
                    // 🛡️ [DATA INTEGRITY] Flag insufficient data if either team failed to load
                    if ((homeStats && homeStats.insufficient_data) || (awayStats && awayStats.insufficient_data)) {
                        match.insufficient_data = 1;
                        console.log(`⚠️ [INTEGRITY] Marking ${match.home} vs ${match.away} as INSUFFICIENT DATA.`);
                    } else {
                        match.insufficient_data = 0;
                    }

                    match.match_graph = null; // Prematch-only — no live graph needed
                    
                    // Attach Deep AI metrics directly to match for persistence
                    match.referee = match.details.referee;
                    match.home_xg = homeStats ? (homeStats.expectedGoals / (homeStats.matchesPlayed||1)) : null;
                    match.away_xg = awayStats ? (awayStats.expectedGoals / (awayStats.matchesPlayed||1)) : null;
                    match.player_ratings_home = homeStats ? { avgRating: homeStats.avgRating } : null;
                    match.player_ratings_away = awayStats ? { avgRating: awayStats.avgRating } : null;

                    // 🧬 [PHASE 8] Deep Context Payload
                    match.historical_context = {
                        h2h: h2h,
                        standing: standings?.find(r => r.team?.id == match._homeTeamId) || null,
                        standing_away: standings?.find(r => r.team?.id == match._awayTeamId) || null
                    };

                    // prediction_engine.py reads: tw_xG_scored, tw_xG_conceded, avgGoals
                    const homeFormAvg = computeFormAverages(homeForm, match._homeTeamId);
                    const awayFormAvg = computeFormAverages(awayForm, match._awayTeamId);

                    match.form_context = {
                        home: homeFormAvg,   // structured averages for Python engine
                        away: awayFormAvg
                    };
                    
                    match.home_form_pts = homeFormAvg?.points || 0;
                    match.away_form_pts = awayFormAvg?.points || 0;

                    if (homeFormAvg) {
                        console.log(`📈 [FORM] ${match.homeTeam}: xG=${homeFormAvg.tw_xG_scored} goals=${homeFormAvg.avgGoals} w%=${homeFormAvg.winRate}`);
                    }
                    if (awayFormAvg) {
                        console.log(`📈 [FORM] ${match.awayTeam}: xG=${awayFormAvg.tw_xG_scored} goals=${awayFormAvg.avgGoals} w%=${awayFormAvg.winRate}`);
                    }

                    // 🧠 [V70] Advanced Analytics Suite
                    try {
                        const opening = persistence.getOpeningOdds(matchId) || {};
                        const currentOdds = { home: match.odds_home, draw: match.odds_draw, away: match.odds_away };
                        
                        match.v70_analytics = {
                            discipline: AdvancedAnalyticsEngine.calculateDisciplineConflict(homeStats, awayStats, match.referee_yellow_avg, match.referee_red_avg),
                            rest: AdvancedAnalyticsEngine.calculateRestMismatch(homeForm, awayForm, (match.startTimestamp || Date.now() / 1000)),
                            xg_regression: {
                                home: AdvancedAnalyticsEngine.calculateXGRegression(homeFormAvg),
                                away: AdvancedAnalyticsEngine.calculateXGRegression(awayFormAvg)
                            },
                            odds_velocity: AdvancedAnalyticsEngine.calculateOddsVelocity(opening, currentOdds)
                        };
                        console.log(`🧠 [V70] Analytics generated for ${match.home} vs ${match.away}`);
                    } catch (e) {
                        console.error(`⚠️ [V70] Analytics Error:`, e.message);
                    }
                    
                    // 💰 [NEW] Real-time odds already fetched in Phase 2
                    if (oddsData?.featured) {
                        const featured = oddsData.featured;
                        const market = featured.default || featured.fullTime || Object.values(featured)[0];
                        
                        if (market?.choices) {
                            const parseSofaOdds = (choice) => {
                                if (!choice) return null;
                                if (choice.decimalValue) return parseFloat(choice.decimalValue);
                                const raw = choice.fractionalValue;
                                if (typeof raw === 'string' && raw.includes('/')) {
                                    const [num, den] = raw.split('/');
                                    return (parseFloat(num) / parseFloat(den)) + 1;
                                }
                                return parseFloat(raw);
                            };

                            market.choices.forEach(choice => {
                                const name = choice.name?.toLowerCase();
                                const val = parseSofaOdds(choice);
                                if (val && val > 1) {
                                    if (name === '1' || name === 'home') match.odds_home = val;
                                    else if (name === 'x' || name === 'draw') match.odds_draw = val;
                                    else if (name === '2' || name === 'away') match.odds_away = val;
                                }
                            });
                            
                            // ♨️ [STEAM DETECTION] Compare Opening vs Current
                            const opening = persistence.getOpeningOdds(matchId);
                            if (opening && opening.odds_home_open) {
                                const diff = ((match.odds_home - opening.odds_home_open) / opening.odds_home_open) * 100;
                                if (Math.abs(diff) >= 10) {
                                    const direction = diff < 0 ? '⬇️ DROPPING' : '⬆️ RISING';
                                    console.log(`♨️  [STEAM] ${match.home} Odds: ${opening.odds_home_open.toFixed(2)} -> ${match.odds_home.toFixed(2)} (${direction} ${Math.abs(diff).toFixed(1)}%)`);
                                    match.odds_steam_detected = true;
                                    match.odds_steam_pct = +diff.toFixed(1);
                                }
                            }

                            if (match.odds_home) {
                                console.log(`💰 [ODDS] ${match.home} vs ${match.away}: H=${match.odds_home} D=${match.odds_draw} A=${match.odds_away}`);
                            }
                        }
                    }

                    match.stats = [];
                    match.lineups = { home: [], away: [] };

                    // 🧬 [IMPACT ENGINE] Calculate Player Absence Impact
                    try {
                        const impact = await this.impactService.calculateImpact(matchId);
                        match.home_attack_impact = impact.home_attack_mod;
                        match.home_defense_impact = impact.home_defense_mod;
                        match.away_attack_impact = impact.away_attack_mod;
                        match.away_defense_impact = impact.away_defense_mod;
                    } catch (e) {
                        console.error(`⚠️ [IMPACT] Error:`, e.message);
                    }


                    // 🧠 [TITANIUM PREDICT] Local Python prediction — fast, no gateway dependency
                    try {
                        const predPayload = {
                            id: matchId,
                            homeTeam: match.homeTeam,
                            awayTeam: match.awayTeam,
                            league: match.league,
                            teamStats: match.teamStats,
                            form_context: match.form_context,
                            historical_context: match.historical_context,
                            odds: { home: match.odds_home, draw: match.odds_draw, away: match.odds_away },
                            home_xg: match.home_xg,
                            away_xg: match.away_xg,
                            news_data: match.news_data,
                            v70_analytics: match.v70_analytics,
                            referee_home_win_rate: match.referee_home_win_rate,
                            weather_temp: match.weather_temp,
                            weather_humidity: match.weather_humidity
                        };

                        // Try local Python worker (30s timeout to allow full analysis)
                        let audit = null;
                        try {
                            audit = await pythonService.predict(predPayload, 60000);
                        } catch (_) { /* timeout — use Poisson fallback below */ }

                        if (audit && audit.home_win_probability > 0) {
                            match.expected_score = audit.expected_score || '1-1';
                            match.xgboost_confidence = audit.power_score / 100 || 0.5;
                            match.home_win_probability = (audit.home_win_probability * 100) || 33;
                            match.draw_probability = (audit.draw_probability * 100) || 33;
                            match.away_win_probability = (audit.away_win_probability * 100) || 33;
                            match.ou_25_prob = (audit.ou_25_prob * 100) || 50;
                            match.btts_prob = (audit.btts_prob * 100) || 50;
                            match.prediction = audit.verdict || audit.direct_prediction || 'ANALYSED';
                            match.power_score = audit.power_score || 50;
                            
                            // 🚀 [TITANIUM ACC%] Capture accurate confidence metrics
                            match.v22_success_rate = audit.v22_success_rate || audit.surgical_confidence || Math.max(match.home_win_probability, match.away_win_probability);
                            match.confidence = match.v22_success_rate;
                            
                            console.log(`🧠 [PREDICT] ${match.homeTeam}: H=${match.home_win_probability?.toFixed(1)}% D=${match.draw_probability?.toFixed(1)}% A=${match.away_win_probability?.toFixed(1)}%`);
                        } else {
                            // 📊 [POISSON FALLBACK] Statistical prediction from xG — always succeeds
                            const hXG = match.home_xg || match.form_context?.home?.tw_xG_scored || 1.3;
                            const aXG = match.away_xg || match.form_context?.away?.tw_xG_scored || 1.0;
                            const homeAdv = 1.12; // historical home advantage
                            const adjH = hXG * homeAdv;
                            const adjA = aXG;
                            // Poisson probabilities
                            const poissonProb = (lambda, k) => (Math.pow(lambda, k) * Math.exp(-lambda)) / [1,1,2,6,24,120][k];
                            let pH = 0, pD = 0, pA = 0;
                            for (let h = 0; h <= 5; h++) {
                                for (let a = 0; a <= 5; a++) {
                                    const p = poissonProb(adjH, h) * poissonProb(adjA, a);
                                    if (h > a) pH += p;
                                    else if (h === a) pD += p;
                                    else pA += p;
                                }
                            }
                            const total = pH + pD + pA;
                            match.home_win_probability = Math.round((pH / total) * 100);
                            match.draw_probability = Math.round((pD / total) * 100);
                            match.away_win_probability = Math.round((pA / total) * 100);
                            match.ou_25_prob = Math.round(Math.min(95, (adjH + adjA) / 3 * 100));
                            match.btts_prob = Math.round(Math.min(90, adjH * adjA * 30));
                            match.prediction = match.home_win_probability > match.away_win_probability ? `${match.homeTeam} Win` : (match.away_win_probability > match.draw_probability ? `${match.awayTeam} Win` : 'Draw');
                            match.power_score = Math.round(Math.max(match.home_win_probability, match.away_win_probability) * 0.8);
                            match.xgboost_confidence = Math.max(match.home_win_probability, match.away_win_probability) / 100;
                            
                            // 🚀 [TITANIUM ACC%] Fallback confidence
                            match.v22_success_rate = Math.round(Math.max(match.home_win_probability, match.away_win_probability));
                            match.confidence = match.v22_success_rate;
                            
                            console.log(`📊 [POISSON] ${match.homeTeam}: H=${match.home_win_probability}% D=${match.draw_probability}% A=${match.away_win_probability}%`);
                        }
                    } catch (auditErr) {
                        console.warn(`⚠️ [PREDICT] Error for ${match.homeTeam}: ${auditErr.message}`);
                    }




                    // 📰 [SENTIMENT ANALYSIS] Already handled in Phase 2

                    // 🚀 [V47 STRATEGIC ENRICHMENT] - Market Value & Psychological Factors
                    try {
                        const isCup = /cup|coupe|pokal|copa|trophy|final|play-off|relegation/i.test(match.tournament_name || match.league);
                        const isHighPressure = isCup ? 1 : 0;
                        
                        // Default Market Values based on league tiers (Stitch Elite estimation)
                        let hMkt = 50, aMkt = 50; 
                        const lgStr = (match.league || '').toLowerCase();
                        const trnStr = (match.tournament_name || '').toLowerCase();
                        const catStr = (match.category_name || '').toLowerCase();
                        
                        if (lgStr.includes('premier league')) { hMkt = 500; aMkt = 450; }
                        else if (lgStr.includes('championship')) { hMkt = 120; aMkt = 100; }
                        else if (/league\s+one|league\s+1|\bL1\b/i.test(lgStr) || /league\s+one|league\s+1|\bL1\b/i.test(trnStr)) { 
                            hMkt = 30; aMkt = 28; 
                            console.log(`💎 [V47] League One Detected: ${match.home} vs ${match.away} | LG: ${match.league} | SETTING 30M€`);
                        }
                        else if (/(national|vanarama|eng.5)/gi.test(lgStr) || /(national|vanarama|eng.5)/gi.test(trnStr)) {
                            hMkt = 15; aMkt = 14;
                            console.log(`🛡️ [V47] National League Detected: ${match.home} vs ${match.away} | LG: ${match.league} | SETTING 15M€`);
                        }
                        else if (lgStr.includes('saudi')) { hMkt = 250; aMkt = 200; }
                        else if (lgStr.includes('egyptian')) { hMkt = 80; aMkt = 60; }
                        
                        match.v47_strategic = {
                            home_market_value: hMkt,
                            away_market_value: aMkt,
                            referee_home_win_rate: match.referee_home_win_rate || 0.45, // Use real calculated rate
                            is_high_pressure: isHighPressure
                        };
                    } catch (e) {
                        console.error(`⚠️ [V47] Strategic Enrichment Error:`, e.message);
                    }

                    // 🕵️‍♂️ [INTEGRITY OFFICER] Run Anomaly Detection
                    try {
                        const prob = {
                            home: match.home_win_probability || 0,
                            draw: match.draw_probability || 0,
                            away: match.away_win_probability || 0
                        };
                        const audit = await IntegrityService.analyzeMatch(match, prob, match.news_data || {});
                        match.integrity_audit = audit;
                        if (audit.isSuspicious) {
                            console.log(`🕵️‍♂️ [INTEGRITY ALERT] ${match.homeTeam} vs ${match.awayTeam}: ${audit.recommendation} (Score: ${audit.score})`);
                        }
                    } catch (integrityErr) {
                        console.error(`⚠️ [Integrity Engine Error]: ${integrityErr.message}`);
                    }

                    // 🧠 [TITANIUM EVOLUTION] Neural Meta-Refining & Calibration
                    try {
                        const refined = await NeuralMetaRefiner.refine(match);
                        match.home_win_probability = refined.home_win_probability;
                        match.away_win_probability = refined.away_win_probability;
                        match.meta_correction_h = refined.meta_correction_h;
                        match.meta_correction_a = refined.meta_correction_a;

                        // Calibrate Confidence based on Failure Intelligence
                        match.confidence = await ConfidenceCalibrationEngine.calibrate(match, match.confidence || 0);
                        match.v22_success_rate = match.confidence;
                        
                        console.log(`🧬 [EVOLUTION] Meta-Refined: H=${match.home_win_probability.toFixed(1)}% | Calibrated Conf: ${match.confidence.toFixed(1)}%`);
                    } catch (evolutionErr) {
                        console.warn(`⚠️ [EVOLUTION] Calibration failed: ${evolutionErr.message}`);
                    }

                    persistence.insertMatch(match);
                    
                    // 🚀 [WARP SPEED] Skip heavy historical injection for T2/T3 to avoid DB bottlenecks
                    if (match.league_tier === 'ELITE' || match.league_tier === 'TIER1') {
                        injectHistoricalData(matchId).catch(() => { });
                    }

                } catch (e) {
                    failed++;
                    console.error(`\n❌ [ERROR] ${match.id} (${match.home}):`, e.message);
                } finally {
                    done++;
                    const duration = performance.now() - stepStart;
                    console.log(`⏱️ [PERF] Traitement ${match.homeTeam || match.home} terminé en ${duration.toFixed(2)}ms`);
                    printProgress(done, total, failed);
                }
            };

            // 🛡️ [TITANIUM STEALTH] Concurrent Batch Processing
            const CONCURRENCY = 1; // 🛡️ Minimal concurrency to avoid detection
            
            // Dynamic Queue Management with staggered start
            let currentIndex = 0;
            const workers = Array(CONCURRENCY).fill(null).map(async (_, workerIdx) => {
                while (currentIndex < targetMatches.length) {
                    const matchIdx = currentIndex++;
                    await processMatch(targetMatches[matchIdx]);
                    // 🛡️ [TITANIUM STEALTH] Long humanized rest between matches
                    const rest = 2000 + Math.floor(Math.random() * 3000);
                    await new Promise(r => setTimeout(r, rest)); 
                }
            });

            await Promise.all(workers);

            writeProgress({ isRunning: false, total, done: total, percent: 100, remaining: 0 });
            console.log('🏁 [CYCLE] Completed.');
            printCacheMetrics();

        } catch (err) {
            console.error('⚠️ [FATAL] Workflow crash:', err.message);
        }
    }
}

module.exports = Workflow;
