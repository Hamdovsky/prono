const SimulationEngine = require('./src/services/SimulationEngine').default;

const mockProbs = {
    homeWin: 45,
    draw: 25,
    awayWin: 30,
    ou25: 75,
    home_target_weight: 1.8, // "Must Win"
    away_target_weight: 0.5,
    weather: { goalMod: -10 }, // Extreme Heat
    refData: { severity: 85 },   // Strict Referee
    teamStats: { cornersAvg: 11.2 }
};

console.log("🧪 Testing TITANIUM ORACLE V5 (Quantum)...");
try {
    const result = SimulationEngine.simulateMatch(mockProbs);
    console.log("Result Structure:", {
        version: result.v,
        expTotal: result.expectedTotal,
        expCorners: result.expCorners,
        expCards: result.expCards,
        homeExp: result.homeExp,
        awayExp: result.awayExp
    });
    console.log("Top 3 Scores:", result.topScores.slice(0, 3));
    console.log("Pressure Wave Sample (Min 80):", result.pressureWave.find(w => w.minute === 80));
    
    if (result.v === "V5-Elite" && result.expCorners && result.expCards) {
        console.log("✅ Verification Successful: Oracle V5 is Operational.");
    } else {
        console.log("❌ Verification Failed: Missing V5 attributes.");
    }
} catch (e) {
    console.log("❌ Execution Error:", e.message);
}
