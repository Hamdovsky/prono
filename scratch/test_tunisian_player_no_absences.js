const pythonService = require('../core/pythonService');

async function testTunisianPlayer() {
    console.log("🚀 Testing Quantum Quant Engine with Montassar Talbi...");
    
    // Create a mock task mimicking what playerPropsService sends
    const task = {
        task: 'PLAYER_PROPS',
        absences: { opponent: [] }, // NO absences
        opponent_goals_conceded_avg: 1.5,
        opponent_shots_conceded_avg: 5.0,
        players: [
            {
                player_id: 879618,
                name: 'Montassar Talbi',
                position: 'D',
                // Normal stats
                goals: 1, 
                shots_on_target_avg: 0.2,
                yellow_cards_avg: 0.15,
                rating_avg: 7.1,
                // 🔥 NEW INSTITUTIONAL METRICS (Simulated for the test to show the engine in action)
                xg_avg: 0.12, // High expected goals for a defender (e.g. dangerous on corners)
                xgot_avg: 0.18, // Very accurate when he shoots
                heatmap_danger: 0.35 // 35% touches in danger zone
            }
        ]
    };

    try {
        const result = await pythonService.predict(task);
        console.log("\n✅ [PYTHON OUTPUT]");
        console.dir(result, { depth: null, colors: true });
    } catch (e) {
        console.error("❌ Error:", e);
    }
}

testTunisianPlayer().then(() => process.exit(0));
