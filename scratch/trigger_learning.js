const evolutionEngine = require('../services/EvolutionEngine');
const logger = require('../core/logger');

async function triggerLearning() {
    console.log("🧬 Triggering Evolution Learning Cycle...");
    try {
        await evolutionEngine.processLatestAutopsies();
        console.log("✅ Learning Cycle Complete. Dashboard should now have data.");
    } catch (e) {
        console.error("❌ Learning failed:", e.message);
    }
    process.exit(0);
}

triggerLearning();
