const LiveLabService = require('../services/liveLabService');

async function testEliteIntegration() {
    const service = new LiveLabService();
    
    // Mock Match with Phase 7 Precision Data
    const mockMatch = {
        id: 'test_elite_1',
        homeTeam: 'Al-Hilal',
        awayTeam: 'Al-Nassr',
        league: 'Saudi Pro League',
        home_win_probability: 65,
        draw_probability: 20,
        away_win_probability: 15,
        xgboost_confidence: 0.88,
        // Phase 7: Referee & Weather
        referee_yellow_avg: 5.2, // Strict Ref
        referee_red_avg: 0.3,
        referee_penalties_avg: 0.45,
        weather_temp: 35.0,
        weather_desc: 'Clear Sky',
        // In-Play Data
        minute: 82,
        scoreHome: 1,
        scoreAway: 0,
        momentum: {
            homePercent: 20,
            awayPercent: 80,
            sotH: 2,
            sotA: 7,
            daH: 30,
            daA: 85,
            xgH: 1.1,
            xgA: 2.3
        }
    };

    console.log("🚀 [TEST] Running V27 Elite Integration Test...");
    
    const result = await service.enrichLiveMatch(mockMatch);
    
    console.log("📊 [RESULTS] Pronostics Generated:", result.pronostics.bets.length);
    result.pronostics.bets.forEach(b => {
        console.log(`- [${b.status}] ${b.market} (Prob: ${b.probability}%) - ${b.icon}`);
    });

    console.log("\n🛡️ [ORIENTATION] Strategic Output:");
    console.log(JSON.stringify(result.pronostics.strategicOrientation, null, 2));

    // Verification
    const hasElite = result.pronostics.bets.some(b => b.status.includes('نخبة'));
    const isStrictRef = result.pronostics.strategicOrientation.orientationText.includes('Strict Ref');

    if (hasElite && isStrictRef) {
        console.log("\n✅ [SUCCESS] Elite Goals and Referee Precision are FUNCTIONAL.");
    } else {
        console.log("\n❌ [FAILURE] Integration mismatch.");
    }
}

testEliteIntegration();
