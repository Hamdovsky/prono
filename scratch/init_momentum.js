const db = require('../core/database').db;
db.exec(`
    CREATE TABLE IF NOT EXISTS team_momentum (
        team_id TEXT PRIMARY KEY,
        last_scores TEXT, 
        trend_factor REAL DEFAULT 1.0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);
console.log('✅ [MOMENTUM] Database table initialized.');
