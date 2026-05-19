const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');

async function pushLocalMatches() {
    console.log('🚀 [SYNC] Initializing Titanium Cloud Synchronizer...');
    
    const dbPath = path.resolve(__dirname, '../data/tactical.db');
    console.log(`🗄️  [SYNC] Opening local SQLite DB: ${dbPath}`);
    const db = new Database(dbPath, { readonly: true });
    
    // Select all matches in local database
    const matches = db.prepare('SELECT * FROM matches').all();
    console.log(`📊 [SYNC] Found ${matches.length} matches in local database.`);
    
    if (matches.length === 0) {
        console.log('⚠️ [SYNC] Local database is empty! Please run "node update_today.js" first to scrape today\'s matches.');
        process.exit(0);
    }
    
    console.log('📡 [SYNC] Uploading matches to Render cloud: https://prono-l5e3.onrender.com...');
    
    try {
        const response = await axios.post('https://prono-l5e3.onrender.com/api/sync-matches', {
            matches
        }, {
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.data?.success) {
            console.log(`✅ [SYNC] Cloud sync complete! Successfully uploaded ${response.data.count} matches to Render!`);
        } else {
            console.log('❌ [SYNC] Sync response indicated failure:', response.data);
        }
    } catch (err) {
        console.error('❌ [SYNC] Network or API error:', err.response?.data || err.message);
    } finally {
        db.close();
    }
}

pushLocalMatches();
