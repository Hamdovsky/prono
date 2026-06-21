const axios = require('axios');
const { db } = require('../core/database');
const redis = require('../core/redisClient');
const logger = require('../core/logger');

async function runDiagnostics() {
    console.log("==========================================");
    console.log("🔍 TITANIUM V50 ULTRA - SYSTEM DIAGNOSTICS");
    console.log("==========================================\n");

    const results = {
        database: false,
        redis: false,
        ml_core: false,
        api_core: false,
        scraper_data: false,
        learning_memory: false
    };

    // 1. Database Check
    try {
        const matchCount = db.prepare('SELECT count(*) as count FROM matches').get();
        console.log(`✅ [DATABASE] Connected. Found ${matchCount.count} matches.`);
        results.database = true;
    } catch (e) {
        console.error(`❌ [DATABASE] Failed: ${e.message}`);
    }

    // 2. Redis Check
    try {
        await redis.setCache('diag_test', 'ok', 10);
        const val = await redis.getCache('diag_test');
        if (val === 'ok') {
            console.log("✅ [REDIS] Connected and operational.");
            results.redis = true;
        } else {
            console.log("❌ [REDIS] Connected but read failed.");
        }
    } catch (e) {
        console.error(`❌ [REDIS] Failed: ${e.message}`);
    }

    // 3. ML Core (FastAPI) Check
    try {
        const response = await axios.get('http://127.0.0.1:8000/health', { timeout: 3000 });
        if (response.data.status === 'ok' || response.status === 200) {
            console.log("✅ [ML_CORE] FastAPI is UP and healthy.");
            results.ml_core = true;
        }
    } catch (e) {
        console.error(`❌ [ML_CORE] Failed to reach http://127.0.0.1:8000/health: ${e.message}`);
        console.log("   (Note: Ensure 'uvicorn core.fastapi_server:app' is running)");
    }

    // 4. API Core Check
    try {
        const response = await axios.get('http://127.0.0.1:3001/health', { timeout: 3000 });
        if (response.data.status === 'ok') {
            console.log("✅ [API_CORE] Node.js server is UP and healthy.");
            results.api_core = true;
        }
    } catch (e) {
        console.error(`❌ [API_CORE] Failed to reach http://127.0.0.1:3001/health: ${e.message}`);
    }

    // 5. Data Integrity Check (Scraper Output)
    try {
        const fullDataCount = db.prepare("SELECT count(*) as count FROM matches WHERE fullData IS NOT NULL AND fullData != ''").get();
        console.log(`✅ [INTEGRITY] Found ${fullDataCount.count} matches with deep data (fullData).`);
        results.scraper_data = fullDataCount.count > 0;
    } catch (e) {
        console.error(`❌ [INTEGRITY] Failed: ${e.message}`);
    }

    // 6. Learning Engine Check
    try {
        const learningCount = db.prepare("SELECT count(*) as count FROM failure_intelligence").get();
        console.log(`✅ [LEARNING] Intelligence Database has ${learningCount.count} patterns.`);
        results.learning_memory = learningCount.count > 0;
    } catch (e) {
        console.error(`❌ [LEARNING] Failed: ${e.message}`);
    }

    console.log("\n==========================================");
    const total = Object.values(results).filter(v => v).length;
    const score = (total / Object.keys(results).length) * 100;
    console.log(`📊 SYSTEM READINESS: ${score.toFixed(0)}%`);
    
    if (score === 100) {
        console.log("🚀 ALL SYSTEMS GO! TITANIUM IS 100% OPERATIONAL.");
    } else {
        console.log("⚠️ SOME SYSTEMS ARE DOWN. CHECK ERRORS ABOVE.");
    }
    console.log("==========================================");
    
    process.exit(0);
}

runDiagnostics();
