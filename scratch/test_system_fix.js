const path = require('path');
const dotenv = require('dotenv');

// Load .env
dotenv.config();

const logger = require('../core/logger');
const pythonService = require('../core/pythonService');

async function verify() {
    console.log('🧪 Starting System Verification...');
    console.log('Configured PYTHON_PATH:', process.env.PYTHON_PATH);
    
    // The pythonService starts workers automatically on import if it's a singleton,
    // but in our implementation, the pool is initialized in the constructor.
    
    // Let's wait for at least one worker to become ready.
    let ready = false;
    let attempts = 0;
    const maxAttempts = 12; // 12 * 5s = 60s
    
    while (!ready && attempts < maxAttempts) {
        attempts++;
        const status = pythonService.getPoolStatus();
        const readyCount = status.workers.filter(w => w.ready).length;
        
        console.log(`[Attempt ${attempts}] Workers Ready: ${readyCount}/${status.workers.length}`);
        
        if (readyCount > 0) {
            ready = true;
            console.log('✅ SUCCESS: At least one Python worker is ONLINE.');
            break;
        }
        
        await new Promise(r => setTimeout(r, 5000));
    }
    
    if (!ready) {
        console.error('❌ FAILURE: Workers failed to reach READY state within 60s.');
        process.exit(1);
    }
    
    // Test a simple prediction
    console.log('🧠 Testing prediction latency...');
    const start = Date.now();
    try {
        const result = await pythonService.predict({ test: true, task: 'PREDICTION' });
        console.log('📊 Prediction Result:', JSON.stringify(result).substring(0, 100) + '...');
        console.log(`⏱️ Latency: ${Date.now() - start}ms`);
        console.log('✅ ALL SYSTEMS OPERATIONAL');
        process.exit(0);
    } catch (err) {
        console.error('❌ Prediction failed:', err.message);
        process.exit(1);
    }
}

verify();
