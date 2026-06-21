const enrichedService = require('../enriched_predictions');

async function testEnrichment() {
    const mockMatch = {
        id: "13981699",
        homeTeam: "Lazio",
        awayTeam: "Sassuolo",
        league: "Serie A",
        startTimestamp: Math.floor(Date.now() / 1000) + 3600,
        _homeTeamId: 2699,
        _awayTeamId: 2716,
        _uniqueTournament: 33,
        _seasonId: 52760
    };

    console.log('🧪 Testing enrichment for:', mockMatch.homeTeam, 'vs', mockMatch.awayTeam);
    try {
        const result = await enrichedService.enrichMatch(mockMatch);
        console.log('✅ Enrichment successful!');
        // console.log('Result sample:', JSON.stringify(result, null, 2).substring(0, 500));
    } catch (e) {
        console.error('❌ Enrichment failed:', e.message);
        process.exit(1);
    }
}

testEnrichment();
