const fs = require('fs');

const files = [
    'server.js', 
    'services/auditService.js', 
    'services/backtestService.js', 
    'services/learningService.js', 
    'services/teamRegistry.js',
    'src/services/HistoricalInjector.js'
];

for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let code = fs.readFileSync(file, 'utf8');

    // 1. Convert `database.db.prepare(...).get().count` to `(await database.prepare(...).get()).count`
    code = code.replace(/(const|let|var)\s+(\w+)\s*=\s*database\.db\.prepare\((.*?)\)\.get\((.*?)\)\.count;/g, '$1 $2 = (await database.prepare($3).get($4))?.count || 0;');

    // 2. Convert standard `database.db.prepare(...).xxx(...)` to `await database.prepare(...).xxx(...)`
    code = code.replace(/(const|let|var)\s+(\w+)\s*=\s*database\.db\.prepare\((.*?)\)\.(all|get|run)\((.*?)\);/g, '$1 $2 = await database.prepare($3).$4($5);');
    
    // 3. Convert standalone `database.db.prepare(...).run(...)`
    code = code.replace(/database\.db\.prepare\((.*?)\)\.run\((.*?)\);/g, 'await database.prepare($1).run($2);');
    
    // 4. Same for `database.prepare` without `.db`
    code = code.replace(/(const|let|var)\s+(\w+)\s*=\s*database\.prepare\((.*?)\)\.get\((.*?)\)\.count;/g, '$1 $2 = (await database.prepare($3).get($4))?.count || 0;');
    code = code.replace(/(const|let|var)\s+(\w+)\s*=\s*database\.prepare\((.*?)\)\.(all|get|run)\((.*?)\);/g, '$1 $2 = await database.prepare($3).$4($5);');
    code = code.replace(/return\s+database\.prepare\((.*?)\)\.(all|get|run)\((.*?)\);/g, 'return await database.prepare($1).$2($3);');
    code = code.replace(/database\.prepare\((.*?)\)\.run\((.*?)\);/g, 'await database.prepare($1).run($2);');

    // 5. Ensure Express routes are async
    code = code.replace(/(app\.(get|post|put|delete)\(['"][^'"]+['"],\s*)(req,\s*res)/g, '$1async (req, res)');
    code = code.replace(/(app\.(get|post|put|delete)\(['"][^'"]+['"],\s*)\((req,\s*res)\)/g, '$1async (req, res)');

    fs.writeFileSync(file, code);
}
console.log('✅ Synchronous database calls globally patched!');
