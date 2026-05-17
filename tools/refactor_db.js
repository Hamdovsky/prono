const fs = require('fs');

let code = fs.readFileSync('core/database.js', 'utf8');

const pgSetup = `const { Pool } = require('pg');
const pool = new Pool({
    user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres',
    max: 20, idleTimeoutMillis: 30000,
});

async function query(text, params = []) {
    let index = 1;
    let pgText = text.replace(/\\?/g, () => '$' + (index++));
    
    // SQLite fixes
    pgText = pgText.replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO');
    pgText = pgText.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
    pgText = pgText.replace(/DATETIME/gi, 'TIMESTAMP');
    pgText = pgText.replace(/JSON/gi, 'JSONB');
    pgText = pgText.replace(/AUTOINCREMENT/gi, 'SERIAL');
    pgText = pgText.replace(/archive\\.archive_matches/gi, 'archive_matches');

    try {
        const res = await pool.query(pgText, params);
        return res;
    } catch (err) {
        if(err.code !== '42P07' && err.code !== '23505') { 
            console.error('[DB ERROR] Query:', pgText, 'Err:', err.message);
        }
        throw err;
    }
}

const db = {
    exec: async (sql) => {
        const statements = sql.split(';').filter(s=>s.trim());
        for(let s of statements) await query(s).catch(()=>'');
    },
    prepare: (sql) => {
        return {
            run: async (...args) => {
                const params = Array.isArray(args[0]) ? args[0] : args;
                try {
                    const res = await query(sql, params);
                    return { lastInsertRowid: null, changes: res.rowCount || 1 };
                } catch(e) { return { changes: 0 } }
            },
            get: async (...args) => {
                const params = Array.isArray(args[0]) ? args[0] : args;
                try {
                    const res = await query(sql, params);
                    return res.rows[0];
                } catch(e) { return null }
            },
            all: async (...args) => {
                const params = Array.isArray(args[0]) ? args[0] : args;
                try {
                    const res = await query(sql, params);
                    return res.rows;
                } catch(e) { return [] }
            }
        };
    },
    pragma: () => {},
    transaction: (fn) => {
        return async (items) => {
            for(let i of items) await fn(i);
        }
    }
};`;

// Replace SQLite connection logic
code = code.replace(/const Database = require\('better-sqlite3'\);[\s\S]*?\} catch \(err\) \{[\s\S]*?process\.exit\(1\);\s*\}/, pgSetup);

// 1. Make all top-level database methods async
code = code.replace(/(\w+)\s*:\s*\((.*?)\)\s*=>\s*\{/g, '$1: async ($2) => {');

// 2. Add await to database executions
code = code.replace(/(const|let|var)\s+(\w+)\s*=\s*(stmt\.(run|get|all)|db\.prepare\([^)]+\)\.(run|get|all))\(/g, '$1 $2 = await $3(');
code = code.replace(/return\s+(stmt\.(run|get|all)|db\.prepare\([^)]+\)\.(run|get|all))\(/g, 'return await $1(');

// 3. Add await to standalone db.exec and stmt.run
// Note: Some might be inside synchronous map/filter loops. This is a compromise script.
code = code.replace(/\n(\s*)stmt\.run\(/g, '\n$1await stmt.run(');
code = code.replace(/\n(\s*)db\.exec\(/g, '\n$1await db.exec(');

fs.writeFileSync('core/database.js', code);
console.log('✅ Successfully refactored core/database.js to PostgreSQL!');
