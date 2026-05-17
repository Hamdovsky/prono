/**
 * V51: Real H2H Reinjector
 * Iterates through all matches in Postgres and calls HistoricalInjector to fetch Real H2H.
 */
const database = require('../core/database');
const { injectHistoricalData } = require('../src/services/HistoricalInjector');

async function run() {
    console.log("🚀 [H2H] Starting retroactive H2H injection...");
    
    try {
        // Fetch all scheduled match IDs
        const res = await database.db.query("SELECT id FROM matches WHERE status = 'scheduled'");
        const matchIds = res.rows.map(r => r.id);
        
        console.log(`📦 [H2H] Found ${matchIds.length} matches to process.`);
        
        let count = 0;
        for (const id of matchIds) {
            try {
                const success = await injectHistoricalData(id);
                if (success) count++;
                
                // Slow down to be respectful to Sofascore API
                if (count % 10 === 0) {
                    console.log(`✅ Processed ${count}/${matchIds.length}...`);
                    await new Promise(r => setTimeout(r, 2000)); 
                } else {
                    await new Promise(r => setTimeout(r, 200));
                }
            } catch (e) {
                console.error(`❌ Error on match ${id}:`, e.message);
            }
        }
        
        console.log(`\n🎉 DONE! Reinjected H2H for ${count} matches.`);
        process.exit(0);
    } catch (err) {
        console.error("💥 Fatal Error:", err.message);
        process.exit(1);
    }
}

run();
