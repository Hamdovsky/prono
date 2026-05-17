const Database = require('better-sqlite3');

try {
    const db = new Database('data/tactical.db');
    
    console.log("--- LATEST LEARNED PATTERNS & ROOT CAUSES ---");
    const memories = db.prepare(`
        SELECT match_id, home_team, away_team, league, error_type, root_cause, context, processed_at 
        FROM learning_memory 
        ORDER BY processed_at DESC 
        LIMIT 10
    `).all();
    
    if (memories.length === 0) {
        console.log("No learning memory found. Let's run the autopsy/learning engine first.");
    } else {
        console.log(JSON.stringify(memories, null, 2));
    }

    console.log("\n--- RECURRING LEAGUE PATTERNS / RULES ---");
    const rules = db.prepare(`
        SELECT league, rule_type, condition, action, hit_count, last_fired
        FROM learning_rules
        ORDER BY last_fired DESC
        LIMIT 10
    `).all();

    if (rules.length === 0) {
         console.log("No specific rules extracted yet.");
    } else {
         console.log(JSON.stringify(rules, null, 2));
    }

    db.close();
} catch (e) {
    console.error("DB Error:", e.message);
}
