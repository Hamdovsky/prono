const database = require('../core/database');
const { spawn } = require('child_process');

async function verifyAll() {
    console.log("🔍 [VERIFICATION] Starting Infrastructure Tests...");

    // 1. Database Check
    try {
        const matchesCountQuery = await database.db.query("SELECT COUNT(*) FROM matches");
        const count = matchesCountQuery.rows[0].count;
        console.log(`✅ [DB] Successfully connected to PostgreSQL! Found ${count} total matches.`);
    } catch (e) {
        console.error(`❌ [DB ERROR] ${e.message}`);
        process.exit(1);
    }

    // 2. Test Live NOTIFY via dummy subscription
    try {
        console.log("⏳ [TEST] Testing Postgres Pub/Sub (LISTEN/NOTIFY)...");
        await database.db.query("LISTEN test_channel");
        
        let notifyReceived = false;
        database.db.on('notification', (msg) => {
            if (msg.channel === 'test_channel') {
                notifyReceived = true;
                console.log(`✅ [PUB/SUB] Received NOTIFY message successfully: ${msg.payload}`);
            }
        });

        await database.db.query("NOTIFY test_channel, 'Integration Test OK'");
        
        // Wait 500ms
        await new Promise(r => setTimeout(r, 500));
        if (!notifyReceived) console.warn("⚠️ [PUB/SUB] Failed to receive NOTIFY message locally.");
    } catch (e) {
        console.error(`❌ [PUB/SUB ERROR] ${e.message}`);
    }

    // 3. Test AI Server via background spawn + HTTP POST
    console.log("⏳ [TEST] Spawning AI Microservice temporarily for health check...");
    const aiProcess = spawn('python', ['ai_server.py'], { cwd: __dirname + '/..' });
    
    // Wait 3 seconds for Uvicorn to boot up
    await new Promise(r => setTimeout(r, 3000));

    try {
        console.log("📡 [HTTP] Firing mock match to AI Engine on Port 8000...");
        const mockMatch = {
            id: "12345", homeTeam: "Team A", awayTeam: "Team B", league: "Test League",
            scoreHome: 1, scoreAway: 1, minute: "45'", status: "FT",
            stats: { 
                possession: { home: 55, away: 45 }, 
                dangerousAttacks: { home: 50, away: 30 }
            }
        };

        const fetchResp = await fetch('http://127.0.0.1:8000/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mockMatch)
        });

        if (fetchResp.ok) {
            const result = await fetchResp.json();
            if (result.success !== false) {
                console.log(`✅ [AI SERVER] Prediction API responded successfully: HTTP 200 OK`);
            } else {
                console.warn(`⚠️ [AI SERVER] Responded with error payload:`, result.error);
            }
        } else {
            console.error(`❌ [AI SERVER HTTP ERROR] ${fetchResp.status} ${fetchResp.statusText}`);
        }
    } catch (e) {
        console.error(`❌ [AI SERVER CRASH or FETCH ERR] ${e.message}`);
    } finally {
        // Kill the python child process
        aiProcess.kill();
        console.log("🧹 [CLEANUP] AI test server shutdown.");
    }

    console.log("🎉 [VERIFICATION] All automated checks completed.");
    process.exit(0);
}

verifyAll();
