const service = require('../core/enriched_predictions');

process.on('unhandledRejection', (reason, promise) => {
    require('fs').writeFileSync('tests/node_crash.txt', String(reason) + '\n' + (reason ? reason.stack : ''));
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    require('fs').writeFileSync('tests/node_crash.txt', String(err) + '\n' + (err ? err.stack : ''));
    process.exit(1);
});async function testRefinedV50() {
    const mockMatch = {
        id: 99999,
        homeTeam: "Manchester City",
        awayTeam: "Arsenal",
        tournamentId: 17, // Premier League
        seasonId: 52186,
        _uniqueTournament: 17,
        _seasonId: 52186,
        _homeTeamId: 65,
        _awayTeamId: 44,
        home_target_weight: 1.5, // Title Contender
        home_distance_target: 2, // 2 points away
        home_matches_remaining: 5,
        away_target_weight: 1.5, // Title Contender
        away_distance_target: 1, // 1 point away
        away_matches_remaining: 5,
        status: "PRE",
        startTimestamp: Math.floor(Date.now() / 1000)
    };

    console.log("🚀 Testing Refined V50+ (Hafiz/xG-Elo)...");
    
    try {
        const enriched = await service.enrichMatch(mockMatch);
        console.log("✅ Match Enrichment Successful!");
        console.log("--- V50+ Refined Metrics ---");
        const conf = enriched.xgboost_confidence || enriched.enriched?.xgboost_confidence || 0;
        console.log("Confidence:", conf);
        console.log("Hafiz DMF (H):", enriched.home_target_weight); // This maps to the raw weight, but prediction takes it further
        console.log("Detailed Analysis 7_Context:", enriched.enriched.detailed_analysis?.["7_Context"]?.reason);
        console.log("Detailed Analysis 1_Form:", enriched.enriched.detailed_analysis?.["1_Form"]?.reason);
        console.log("Detailed Analysis 9_Metrics:", enriched.enriched.detailed_analysis?.["9_Metrics"]?.reason);
        
        if (conf > 0) {
            console.log("🏆 Verification PASSED: System is stable and providing tactical insights.");
        } else {
            console.log("❌ Verification FAILED: Confidence is 0.");
        }
    } catch (e) {
        console.error("❌ Refined Test Failed:", e);
    }
}

testRefinedV50();
