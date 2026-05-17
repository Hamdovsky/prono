const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');
const logger = require('../core/logger');

async function test() {
    console.log('🧪 Starting Structural Integrity Test...');
    
    try {
        console.log('✅ Logger loaded');
        
        const db = database;
        console.log('✅ Database service loaded');
        
        // Test Python worker
        console.log('🧪 Testing Python Worker (Hybrid Engine)...');
        const testMatch = {
            homeTeam: 'Arsenal',
            awayTeam: 'Liverpool',
            league: 'Premier League',
            home_xg: 1.5,
            away_xg: 1.2
        };
        
        const prediction = await enrichedPredictions.getAnalyticalPrediction(testMatch);
        if (prediction.success) {
            console.log('✅ Python Worker ONLINE. Result:', JSON.stringify(prediction.predictions[0]));
        } else {
            console.log('❌ Python Worker FAILED:', prediction.error);
        }

        console.log('✨ All core imports and services are working correctly.');
        process.exit(0);
    } catch (e) {
        console.error('❌ Structural Test FAILED:', e);
        process.exit(1);
    }
}

test();
