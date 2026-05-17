const fs = require('fs');
const path = require('path');
const Workflow = require('./SofascoreScraping/src/Workflow');

async function runUpdate() {
    console.log('🚀 Starting manual update for today\'s matches...');
    
    const leaguesJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'leagues_ids.json'), 'utf8'));
    const leagues = leaguesJson.map(l => ({
        country: l.category_name.toLowerCase().replace(/\s+/g, '-'),
        league: l.tournament_name.toLowerCase().replace(/\s+/g, '-')
    }));

    const workflow = new Workflow(leagues);
    
    try {
        await workflow.start();
        console.log('✅ Manual update complete.');
    } catch (err) {
        console.error('❌ Update error:', err.message);
    } finally {
        process.exit(0);
    }
}

runUpdate();
