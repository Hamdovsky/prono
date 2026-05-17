const Extractor = require('./src/Extractor');
const persistence = require('./src/Persistence');
const { injectHistoricalData } = require('../src/services/HistoricalInjector');
const PlayerImpactService = require('./src/PlayerImpactService');
const PlayerPropsScraper = require('./src/PlayerPropsScraper');
const TacticalService = require('../services/tactical_service');
const newsService = require('../src/services/newsService');
const IntegrityService = require('../services/integrity_service');
const AdvancedAnalyticsEngine = require('../src/services/AdvancedAnalyticsEngine');
const { LEAGUE_MAP } = require('../config/leagueRegistry');
const AliasResolver = require('./src/AliasResolver');
const learningEngine = require('../services/adaptiveLearningEngine');
const fs = require('fs');
const path = require('path');

const { SofaAPI } = require('./src/apiClient');

const PROGRESS_FILE = path.join(__dirname, '../data/historical_scan_progress.json');

const START_DATE = '2026-01-01';

// In-Memory Caches
const statsCache = new Map();
const standingsCache = new Map();

async function fetchTeamStats(teamId, uniqueTournamentId, seasonId) {
    const cacheKey = `${teamId}_${uniqueTournamentId}_${seasonId}`;
    if (statsCache.has(cacheKey)) return statsCache.get(cacheKey);
    try {
        const data = await SofaAPI.getTeamStats(teamId, uniqueTournamentId, seasonId);
        if (!data || !data.statistics) return null;
        const s = data.statistics;
        const mp = s.matches || s.matchesPlayed || 1;
        
        const statsObj = {
            matchesPlayed: mp, avgRating: +(s.averageRating || 6.5).toFixed(2),
            avgPossession: +(s.averageBallPossession || 50).toFixed(1),
            expectedGoals: +(s.expectedGoals || s.goalsScored || 1.0).toFixed(2),
            avgGoalsScored: +((s.goalsScored || 0) / mp).toFixed(2),
            avgShots: +((s.shots || 0) / mp).toFixed(2),
            avgShotsOnTarget: +((s.shotsOnTarget || 0) / mp).toFixed(2),
            avgPasses: +((s.totalPasses || 0) / mp).toFixed(2),
            avgGoalsConceded: +((s.goalsConceded || 0) / mp).toFixed(2),
            cleanSheets: s.cleanSheets || 0,
            avgTackles: +((s.tackles || 0) / mp).toFixed(2),
            yellowCards: s.yellowCards || 0,
            redCards: s.redCards || 0
        };
        statsCache.set(cacheKey, statsObj);
        return statsObj;
    } catch (err) { return null; }
}

async function fetchH2H(matchId) {
    try { const data = await SofaAPI.getH2H(matchId); return data?.events?.slice(0, 5) || []; } catch (_) { return null; }
}

async function fetchTeamForm(teamId, tournamentId, seasonId) {
    try { const data = await SofaAPI.getTeamForm(teamId, tournamentId, seasonId); return data?.events || []; } catch (_) { return null; }
}

async function fetchStandings(tournamentId, seasonId) {
    const cacheKey = `${tournamentId}_${seasonId}`;
    if (standingsCache.has(cacheKey)) return standingsCache.get(cacheKey);
    try {
        const data = await SofaAPI.getStandings(tournamentId, seasonId);
        const rows = data?.standings?.[0]?.rows || []; 
        if (rows.length > 0) standingsCache.set(cacheKey, rows);
        return rows;
    } catch (_) { return null; }
}

function computeFormAverages(events, teamId) {
    if (!Array.isArray(events) || events.length === 0) {
        return { tw_xG_scored: 1.0, tw_xG_conceded: 1.0, avgGoals: 1.0, avgGoalsConceded: 1.0, winRate: 0.33, matchesAnalyzed: 0 };
    }
    const tid = String(teamId);
    let goalsScored = 0, goalsConceded = 0, xgScored = 0, xgConceded = 0, wins = 0, count = 0;
    for (const ev of events) {
        const isHome = String(ev.homeTeam?.id) === tid;
        const gs = isHome ? (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0) : (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0);
        const gc = isHome ? (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0) : (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0);
        const xgS = isHome ? (ev.homeXg ?? gs) : (ev.awayXg ?? gs);
        const xgC = isHome ? (ev.awayXg ?? gc) : (ev.homeXg ?? gc);
        goalsScored += gs; goalsConceded += gc; xgScored += xgS; xgConceded += xgC;
        if (gs > gc) wins++;
        count++;
    }
    return {
        tw_xG_scored: +(xgScored / count).toFixed(2), tw_xG_conceded: +(xgConceded / count).toFixed(2),
        avgGoals: +(goalsScored / count).toFixed(2), avgGoalsConceded: +(goalsConceded / count).toFixed(2),
        winRate: +(wins / count).toFixed(2), matchesAnalyzed: count
    };
}

// Ensure the local date doesn't skip days due to timezones
function getNextDateStr(dateStr) {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
}

function getActualResult(scoreHome, scoreAway) {
    const h = parseInt(scoreHome || 0);
    const a = parseInt(scoreAway || 0);
    if (h > a) return 'H';
    if (a > h) return 'A';
    return 'D';
}

function detectPrediction(match) {
    const h = parseFloat(match.home_win_probability || 0);
    const a = parseFloat(match.away_win_probability || 0);
    const d = parseFloat(match.draw_probability || 0);
    if (h >= a && h >= d) return 'HOME WIN';
    if (a > h && a >= d) return 'AWAY WIN';
    return 'DRAW';
}

async function runHistorical() {
    console.log(`\n\n======================================================`);
    console.log(`⏳ TITANIUM HISTORICAL ENGINE SCALPER`);
    console.log(`======================================================`);
    
    await persistence.init();
    const resolver = new AliasResolver(persistence.db);
    resolver.seedMasterNames();
    const impactService = new PlayerImpactService();

    let currentDate = START_DATE;
    
    // Resume logic
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(PROGRESS_FILE));
            if (saved.lastDate) {
                currentDate = saved.lastDate;
                console.log(`\n📁 [RESUME] Found existing progress. Resuming from: ${currentDate}`);
            }
        } catch (e) { }
    }

    const todayStr = new Date().toISOString().split('T')[0];

    while (currentDate <= todayStr) {
        console.log(`\n======================================================`);
        console.log(`📆 PROCESSING DATE: ${currentDate}`);
        console.log(`======================================================`);
        
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastDate: currentDate }));
        
        let allEvents = [];
        try {
            const data = await SofaAPI.getEvents(currentDate);
            allEvents = data.events || [];
            console.log(`📊 [API] Fetched ${allEvents.length} total raw events for ${currentDate}.`);
        } catch (e) {
            console.error(`❌ [API] Failed to fetch events for ${currentDate}. Retrying next loop...`);
            await new Promise(r => setTimeout(r, 10000));
            continue; // Retry same date
        }

        // Filter and map target matches
        const targetMatches = [];
        for (const event of allEvents) {
            const match = Extractor.extractMatch(event);
            if (!match) continue;
            
            // For historical scalper, ONLY process finished matches
            if (match.status !== 'finished') continue;

            match.homeTeam = resolver.resolve(match.home_team_id, match.homeTeam);
            match.awayTeam = resolver.resolve(match.away_team_id, match.awayTeam);
            match.home = match.homeTeam;
            match.away = match.awayTeam;
            match.league = resolver.resolveTournament(match.league, match.category_name);

            match._homeTeamId = event.homeTeam?.id;
            match._awayTeamId = event.awayTeam?.id;
            match._uniqueTournament = event.tournament?.uniqueTournament?.id;
            match._seasonId = event.season?.id;
            match._sofaMatchId = event.id;

            targetMatches.push(match);
        }

        console.log(`🎯 [FILTER] Found ${targetMatches.length} FINISHED matches to process for ${currentDate}.`);

        let done = 0;
        const total = targetMatches.length;

        const processMatch = async (match) => {
            try {
                const matchId = match.id;

                if (await persistence.checkMatchExists(matchId)) {
                    return; // Already processed
                }

                // Sleep slightly between matches to respect API limits aggressively for historical
                await new Promise(r => setTimeout(r, 100));

                const [homeStats, awayStats, eventDetails, h2h, homeForm, awayForm, standings, matchStats] = await Promise.all([
                    fetchTeamStats(match._homeTeamId, match._uniqueTournament, match._seasonId),
                    fetchTeamStats(match._awayTeamId, match._uniqueTournament, match._seasonId),
                    SofaAPI.getMatchDetails(matchId),
                    fetchH2H(matchId),
                    fetchTeamForm(match._homeTeamId, match._uniqueTournament, match._seasonId),
                    fetchTeamForm(match._awayTeamId, match._uniqueTournament, match._seasonId),
                    fetchStandings(match._uniqueTournament, match._seasonId),
                    SofaAPI.getMatchStats(matchId)
                ]);

                const rootEvent = eventDetails?.event || null;
                
                if (rootEvent) {
                    match.score.home = rootEvent.homeScore?.current || rootEvent.homeScore?.normaltime || 0;
                    match.score.away = rootEvent.awayScore?.current || rootEvent.awayScore?.normaltime || 0;
                }
                
                if (matchStats && matchStats.statistics) {
                    match.stats = matchStats.statistics; 
                }

                match.details = {
                    referee: rootEvent?.referee?.name || 'V.A.R.',
                    stadium: rootEvent?.venue?.stadium?.name || 'Unknown Stadium',
                    homeManager: rootEvent?.homeTeam?.manager?.name || null,
                    awayManager: rootEvent?.awayTeam?.manager?.name || null,
                };
                
                match.teamStats = { home: homeStats, away: awayStats };
                match.historical_context = {
                    h2h: h2h,
                    standing: standings?.find(r => r.team?.id == match._homeTeamId) || null,
                    standing_away: standings?.find(r => r.team?.id == match._awayTeamId) || null
                };

                match.form_context = {
                    home: computeFormAverages(homeForm, match._homeTeamId),
                    away: computeFormAverages(awayForm, match._awayTeamId)
                };

                try {
                    const prob = { home: match.home_win_probability || 0, draw: match.draw_probability || 0, away: match.away_win_probability || 0 };
                    const audit = await IntegrityService.analyzeMatch(match, prob, {});
                    match.integrity_audit = audit;
                } catch (e) {}

                // Insert into DB
                persistence.insertMatch(match);

                // Auto-assimilate into Adaptive Engine via HistoricalInjector script link
                try {
                    await injectHistoricalData(matchId);
                    
                    // NEW: Direct Adaptive Learning Trigger (V2.0.0 Engine)
                    const actualResult = getActualResult(match.score.home, match.score.away);
                    const prediction = detectPrediction(match);
                    
                    await learningEngine.learn({
                        matchId:       matchId,
                        league:        match.league,
                        homeTeam:      match.home,
                        awayTeam:      match.away,
                        prediction:    prediction,
                        confidence:    Math.round((match.home_win_probability || 50)),
                        oddsData:      { home: match.odds_home, draw: match.odds_draw, away: match.odds_away },
                        featuresList:  ['form', 'xg', 'odds', 'h2h', 'elo', 'home_advantage'],
                        actualResult:  actualResult,
                        matchStats:    {
                            xg_home: match.teamStats.home?.expectedGoals || 0,
                            xg_away: match.teamStats.away?.expectedGoals || 0,
                            possession_home: match.teamStats.home?.avgPossession || 50,
                            possession_away: match.teamStats.away?.avgPossession || 50,
                            shots_on_target_home: match.teamStats.home?.avgShotsOnTarget || 0,
                            shots_on_target_away: match.teamStats.away?.avgShotsOnTarget || 0,
                            red_cards_home: match.teamStats.home?.redCards || 0,
                            red_cards_away: match.teamStats.away?.redCards || 0
                        },
                        scoreHome:     match.score.home,
                        scoreAway:     match.score.away,
                        matchDate:     match.timestamp || new Date().toISOString()
                    });
                } catch(e) {
                    console.error(` ⚠️  Learning failed for ${matchId}: ${e.message}`);
                }

            } catch (e) {
                console.error(`\n❌ [ERROR] ${match.id} (${match.home}): ${e.message}`);
            } finally {
                done++;
                if (done % 10 === 0) {
                    process.stdout.write(`\r  ⚙️  Progress for ${currentDate}: ${done}/${total} (${Math.round((done/total)*100)}%) `);
                }
            }
        };

        // Aggressive limits: only 2 concurrent processors so we don't destroy Sofascore servers
        const CONCURRENCY = 8; 
        let currentIndex = 0;
        const workers = Array(CONCURRENCY).fill(null).map(async () => {
            while (currentIndex < targetMatches.length) {
                const matchIdx = currentIndex++;
                await processMatch(targetMatches[matchIdx]);
            }
        });

        await Promise.all(workers);
        console.log(`\n✅ [DAY COMPLETE] Fully injected ${currentDate}. Moving to next day...`);

        currentDate = getNextDateStr(currentDate);
        
        // Anti-ban cooldown between days
        console.log(`💤 [COOLDOWN] Waiting 1.5 seconds before fetching next day...`);
        await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`\n🎉 [FINISHED] Historical Backfill from ${START_DATE} completely finished!`);
    process.exit(0);
}

runHistorical();
