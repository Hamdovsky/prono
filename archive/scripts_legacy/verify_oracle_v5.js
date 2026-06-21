// Oracle V5 Unified Bridge Test
const fs = require('fs');
const path = require('path');

// Manually mock the ESM export for a CJS test environment if needed, 
// or just read the logic directly. 
// Since we are in a hybrid environment, let's just test the logic 
// by creating a temporary CJS version of the engine for validation.

const engineCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'SimulationEngine.js'), 'utf8')
    .replace('export default new SimulationEngine();', 'module.exports = new SimulationEngine();');

const tmpDir = path.join(__dirname, '..', 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
const tmpPath = path.join(tmpDir, 'SimulationEngineV5.cjs');

fs.writeFileSync(tmpPath, engineCode);

const SimulationEngine = require(tmpPath);

const mockProbs = {
    homeWin: 45,
    draw: 25,
    awayWin: 30,
    ou25: 75,
    home_target_weight: 1.8, 
    away_target_weight: 0.5,
    weather: { goalMod: -15 }, 
    refData: { severity: 85 },
    teamStats: { cornersAvg: 11.2 }
};

console.log("🧪 Testing TITANIUM ORACLE V5 (Quantum Logic)...");
try {
    const result = SimulationEngine.simulateMatch(mockProbs);
    console.log("Result Structure:", {
        v: result.v,
        expTotal: result.expectedTotal,
        expCorners: result.expCorners,
        expCards: result.expCards
    });
    
    if (result.v === "V5-Elite" && result.expCorners > 0 && result.expCards > 0) {
        console.log("✅ Verification Successful: Quantum Oracle Logic Validated.");
    }
} catch (e) {
    console.log("❌ Error:", e.message);
}
