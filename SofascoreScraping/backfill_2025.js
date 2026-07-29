const Extractor = require('./src/Extractor');
const persistence = require('./src/Persistence');
const { injectHistoricalData } = require('../src/services/HistoricalInjector');
const TacticalService = require('../services/tactical_service');
const { LEAGUE_MAP } = require('../config/leagueRegistry');
const AliasResolver = require('./src/AliasResolver');
const learningEngine = require('../services/adaptiveLearningEngine');
const fs = require('fs');
const path = require('path');

const { SofaAPI } = require('./src/apiClient');

const PROGRESS_FILE = path.join(__dirname, '../data/backfill_2025_progress.json');
const START_DATE = '2025-01-01';
const END_DATE = '2025-12-31';

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
            avgShotsOnTarget: +((s.shotsOnTarget || 0) / mp).toFixed(2),
            redCards: s.redCards || 0
        };
        statsCache.set(cacheKey, statsObj);
        return statsObj;
    } catch (_) { return null; }
}

function getActualResult(scoreHome, scoreAway) {
    const h = parseInt(scoreHome || 0); const a = parseInt(scoreAway || 0);
    if (h > a) return 'H'; if (a > h) return 'A'; return 'D';
}

function detectPrediction(match) {
    const h = parseFloat(match.home_win_probability || 0);
    const a = parseFloat(match.away_win_probability || 0);
    const d = parseFloat(match.draw_probability || 0);
    if (h >= a && h >= d) return 'HOME WIN';
    if (a > h && a >= d) return 'AWAY WIN';
    return 'DRAW';
}

async function runBackfill() {
    console.log(`\n\n======================================================`);
    console.log(`🚀 TITANIUM 2025 MASSIVE BACKFILL ENGINE (FAST MODE)`);
    console.log(`======================================================`);
    
    await persistence.init();
    const resolver = new AliasResolver(persistence.db);
    resolver.seedMasterNames();

    let currentDate = START_DATE;
    if (fs.existsSync(PROGRESS_FILE)) {
        try { const saved = JSON.parse(fs.readFileSync(PROGRESS_FILE)); if (saved.lastDate) currentDate = saved.lastDate; } catch (e) {}
    }

    while (currentDate <= END_DATE) {
        console.log(`\n📆 DATE: ${currentDate} | Status: Processing...`);
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastDate: currentDate }));
        
        let allEvents = [];
        try { const data = await SofaAPI.getEvents(currentDate); allEvents = data.events || []; } catch (e) {
            console.error(`❌ API fail for ${currentDate}. Retrying...`); await new Promise(r => setTimeout(r, 5000)); continue;
        }

        const targetMatches = allEvents.filter(ev => ev.status.type === 'finished').map(ev => {
            const m = Extractor.extractMatch(ev);
            if (!m) return null;
            m.home = resolver.resolve(ev.homeTeam.id, m.homeTeam);
            m.away = resolver.resolve(ev.awayTeam.id, m.awayTeam);
            m.league = resolver.resolveTournament(m.league, m.category_name);
            m._homeId = ev.homeTeam.id; m._awayId = ev.awayTeam.id; m._utid = ev.tournament?.uniqueTournament?.id; m._sid = ev.season?.id;
            return m;
        }).filter(m => m !== null);

        console.log(`🎯 Found ${targetMatches.length} finished matches.`);

        let done = 0;
        const processMatch = async (match) => {
            try {
                if (await persistence.checkMatchExists(match.id)) return;
                
                // Fast-paced fetching
                const [det, mStats, hS, aS] = await Promise.all([
                    SofaAPI.getMatchDetails(match.id),
                    SofaAPI.getMatchStats(match.id),
                    fetchTeamStats(match._homeId, match._utid, match._sid),
                    fetchTeamStats(match._awayId, match._utid, match._sid)
                ]);

                const ev = det?.event || {};
                match.score.home = ev.homeScore?.current || 0;
                match.score.away = ev.awayScore?.current || 0;
                match.referee_name = ev.referee?.name || 'V.A.R.';
                match.stadium_name = ev.venue?.stadium?.name || 'Unknown';
                match.home_manager = ev.homeTeam?.manager?.name || null;
                match.away_manager = ev.awayTeam?.manager?.name || null;
                match.teamStats = { home: hS, away: aS };
                
                // Deep enrichment for V2.0.0 columns
                match.xg_home = hS?.expectedGoals || 0;
                match.xg_away = aS?.expectedGoals || 0;
                match.possession_home = hS?.avgPossession || 50;
                match.possession_away = aS?.avgPossession || 50;
                match.shots_on_target_home = hS?.avgShotsOnTarget || 0;
                match.shots_on_target_away = aS?.avgShotsOnTarget || 0;

                persistence.insertMatch(match);
                
                // NEW: Direct Adaptive Learning Training
                await learningEngine.learn({
                    matchId: match.id, league: match.league, homeTeam: match.home, awayTeam: match.away,
                    prediction: detectPrediction(match), confidence: Math.round(match.home_win_probability || 50),
                    actualResult: getActualResult(match.score.home, match.score.away),
                    matchStats: { xg_home: match.xg_home, xg_away: match.xg_away, possession_home: match.possession_home, possession_away: match.possession_away, 
                                  shots_on_target_home: match.shots_on_target_home, shots_on_target_away: match.shots_on_target_away,
                                  red_cards_home: hS?.redCards || 0, red_cards_away: aS?.redCards || 0 },
                    scoreHome: match.score.home, scoreAway: match.score.away, matchDate: match.timestamp
                });

            } catch (e) {} finally { done++; if (done % 20 === 0) process.stdout.write(`\r  🚀 Progress: ${done}/${targetMatches.length} `); }
        };

        const CONCURRENCY = 40; // AGGRESSIVE MODE
        let idx = 0;
        const workers = Array(CONCURRENCY).fill(null).map(async () => {
            while (idx < targetMatches.length) { 
                const match = targetMatches[idx++];
                if (match) await processMatch(match); 
            }
        });
        await Promise.all(workers);

        currentDate = new Date(new Date(currentDate).getTime() + 86400000).toISOString().split('T')[0];
    }
    console.log(`\n🎉 2025 BACKFILL COMPLETE!`); process.exit(0);
}

runBackfill();
