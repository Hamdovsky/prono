
const path = require('path');
const fs = require('fs');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const Extractor = require('../SofascoreScraping/src/Extractor');
const persistence = require('../SofascoreScraping/src/Persistence');
const redisCache = require('../core/redisClient');

async function forceScanToday() {
    console.log('🚀 [TITANIUM] STARTING EMERGENCY TODAY SCAN...');
    
    await persistence.init();
    
    const today = new Date().toISOString().split('T')[0];
    console.log(`📅 Target Date: ${today}`);
    
    try {
        console.log('📡 Fetching events from SofaScore...');
        const data = await SofaAPI.getEvents(today);
        const events = data.events || [];
        console.log(`📊 Found ${events.length} events on SofaScore.`);
        
        let inserted = 0;
        let withOdds = 0;
        
        for (const event of events) {
            // Skip finished matches
            const status = (event.status?.type || '').toLowerCase();
            if (['finished', 'ft', 'ended', 'closed'].includes(status)) continue;
            
            const match = Extractor.extractMatch(event);
            if (!match) continue;
            
            // Add some default confidence if missing
            if (!match.confidence) match.confidence = 55;
            
            persistence.insertMatch(match);
            inserted++;
            if (match.odds_home) withOdds++;
            
            if (inserted % 50 === 0) {
                console.log(`✅ Processed ${inserted} matches...`);
            }
        }
        
        console.log(`\n✨ SCAN COMPLETE!`);
        console.log(`📈 Matches Inserted/Updated: ${inserted}`);
        console.log(`💰 Matches with Odds: ${withOdds}`);
        
        // Clear API cache
        console.log('🧹 Clearing Redis cache...');
        await redisCache.setCache('titanium_upcoming_matches', null);
        console.log('✅ Cache cleared!');
        
        process.exit(0);
    } catch (error) {
        console.error('💥 FATAL ERROR:', error.message);
        process.exit(1);
    }
}

forceScanToday();
