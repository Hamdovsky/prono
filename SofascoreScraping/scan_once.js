const Workflow = require('./src/Workflow');
const { LEAGUES } = require('../config/leagueRegistry');

// Map registry format → Workflow format
const leagues = LEAGUES.map(l => ({ country: l.country, league: l.sofascoreSlug }));

const titaniumWorkflow = new Workflow(leagues);

async function runOnce() {
    process.title = "Titanium Smart Scan";
    console.log('--- TITANIUM SMART SCAN: ONE-OFF EXECUTION ---');
    console.log(`🌐 Scanning ${leagues.length} leagues at HIGH SYNC PRIORITY`);
    try {
        await titaniumWorkflow.start();
        console.log('✅ [SMART SCAN] Successfully completed.');
        process.exit(0);
    } catch (err) {
        console.error('❌ [SMART SCAN] Fatal error:', err.message);
        process.exit(1);
    }
}

runOnce();
