(async () => {
    const SimulationEngine = (await import('../src/services/SimulationEngine.js')).default;

    console.log("=== TITANIUM ORACLE V5: Penalty Factor Test ===");

    // Scenario: Man City vs Luton Town (High Dominance)
    const probsNormal = {
        homeWin: 80,
        draw: 15,
        awayWin: 5,
        ou25: 70, // 70% chance of Over 2.5
        refData: { severity: 50, isPenaltyHappy: false }
    };

    const probsPenalty = {
        homeWin: 80,
        draw: 15,
        awayWin: 5,
        ou25: 70, // 70% chance of Over 2.5
        refData: { severity: 85, isPenaltyHappy: true }
    };

    const runNormal = SimulationEngine.simulateMatch(probsNormal);
    const runPenalty = SimulationEngine.simulateMatch(probsPenalty);

    console.log("\n[RUN A] Normal Referee");
    console.log(`Expected Total Goals: ${runNormal.expectedTotal}`);
    console.log(`Home xG (Dominant): ${runNormal.homeExp}`);
    console.log(`Away xG (Underdog): ${runNormal.awayExp}`);
    console.log(`Top Score Prediction: ${runNormal.topScores[0].score} (${runNormal.topScores[0].prob}%)`);

    console.log("\n[RUN B] Penalty-Happy Referee (isPenaltyHappy: true)");
    console.log(`Expected Total Goals: ${runPenalty.expectedTotal}`);
    console.log(`Home xG (Dominant): ${runPenalty.homeExp}`);
    console.log(`Away xG (Underdog): ${runPenalty.awayExp}`);
    console.log(`Top Score Prediction: ${runPenalty.topScores[0].score} (${runPenalty.topScores[0].prob}%)`);

    const diffHome = (parseFloat(runPenalty.homeExp) - parseFloat(runNormal.homeExp)).toFixed(2);
    const diffAway = (parseFloat(runPenalty.awayExp) - parseFloat(runNormal.awayExp)).toFixed(2);
    
    console.log("\n[ANALYSIS IMPACT]");
    console.log(`Home xG Shift: +${diffHome}`);
    console.log(`Away xG Shift: +${diffAway}`);
    console.log(`Total xG Shift: +${(parseFloat(diffHome) + parseFloat(diffAway)).toFixed(2)} (Target: ~0.76)`);
    
    if (parseFloat(diffHome) > parseFloat(diffAway)) {
        console.log("✅ SUCCESS: Penalty lambda correctly favored the dominant attacking team.");
    } else {
        console.log("❌ FAILED: Penalty lambda distribution error.");
    }

})();
