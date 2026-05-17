/**
 * Diagnostic script - loads server routes and tests them directly
 */
const database = require('./core/database');

async function main() {
    console.log('== DIAGNOSTIC START ==');

    // Test 1: Basic DB
    try {
        const r = await database.db.query('SELECT COUNT(*) as cnt FROM matches');
        console.log('[OK] DB connected. Matches in DB:', r.rows[0]?.cnt);
    } catch (e) {
        console.error('[FAIL] DB connection:', e.message);
        process.exit(1);
    }

    // Test 2: getMatchesByStatuses (used by /api/upcoming)
    try {
        const matches = await database.getMatchesByStatuses(['scheduled', 'finished']);
        console.log('[OK] getMatchesByStatuses returned:', matches.length);
    } catch (e) {
        console.error('[FAIL] getMatchesByStatuses:', e.message, '\n', e.stack?.split('\n').slice(0,4).join('\n'));
    }

    // Test 3: liveLabService.getLiveMatches (used by /api/live-lab)
    try {
        const liveLabService = require('./services/liveLabService');
        const r = await liveLabService.getLiveMatches();
        console.log('[OK] liveLabService.getLiveMatches returned:', r.length);
    } catch (e) {
        console.error('[FAIL] getLiveMatches:', e.message, '\n', e.stack?.split('\n').slice(0,4).join('\n'));
    }
    
    // Test 4: combosService (used by /api/combos)
    try {
        // find what service is used
        const server = require('fs').readFileSync('./server.js','utf8');
        const m = server.match(/require\(['"]([^'"]*combo[^'"]*)['"]\)/i);
        if (m) {
            const comboSvc = require('./' + m[1].replace(/^\.\//, '') + (m[1].endsWith('.js') ? '' : ''));
            console.log('[INFO] Combos service found:', m[1]);
        }
    } catch (e) { console.log('[INFO] combos test skipped:', e.message); }

    // Test 5: Grep the server.js /api/combos handler for clues
    const serverCode = require('fs').readFileSync('./server.js', 'utf8');
    const combosIdx = serverCode.indexOf("'/api/combos'");
    if (combosIdx > -1) {
        console.log('[INFO] /api/combos handler snippet:');
        console.log(serverCode.substring(combosIdx, combosIdx + 600));
    }

    console.log('== DIAGNOSTIC END ==');
    process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
