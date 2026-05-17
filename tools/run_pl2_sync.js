const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const { LEAGUE_MAP } = require('../config/leagueRegistry');
const persistence = require('../SofascoreScraping/src/Persistence');
const Extractor = require('../SofascoreScraping/src/Extractor');
const AliasResolver = require('../SofascoreScraping/src/AliasResolver');

async function run() {
    await persistence.init();
    const resolver = new AliasResolver(persistence.db);
    
    const fl = LEAGUE_MAP['ENG_PL2'];
    console.log(`📡 [FORCE] Syncing ${fl.displayName}...`);
    
    try {
        const seasonsRes = await SofaAPI.getTournamentSeasons(fl.sofascoreId);
        const currentSeasonId = seasonsRes.seasons[0].id;
        
        const nextRes = await SofaAPI.getTournamentEvents(fl.sofascoreId, currentSeasonId, 'next');
        const lastRes = await SofaAPI.getTournamentEvents(fl.sofascoreId, currentSeasonId, 'last');
        const events = [...(nextRes.events || []), ...(lastRes.events || [])];
        
        console.log(`✅ Found ${events.length} events. Persisting...`);
        
        for (const event of events) {
            const match = Extractor.extractMatch(event);
            if (!match) continue;
            
            // Resolve names
            match.homeTeam = resolver.resolve(match.home_team_id, match.homeTeam);
            match.awayTeam = resolver.resolve(match.away_team_id, match.awayTeam);
            match.league = resolver.resolveTournament(match.league, match.category_name);
            
            persistence.insertMatch(match);
        }
        console.log("🚀 Done. Check database now.");
    } catch (e) {
        console.error(e.message);
    }
}
run();
