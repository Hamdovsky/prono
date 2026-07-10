/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   TITANIUM FULL SYSTEM HEALTH CHECK — Diagnostic Suite v1.0 ║
 * ╚══════════════════════════════════════════════════════════════╝
 * Usage: node titanium_health_check.js
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');

// ── Colour helpers ─────────────────────────────────────────────
const G  = (s) => `\x1b[32m${s}\x1b[0m`;
const R  = (s) => `\x1b[31m${s}\x1b[0m`;
const Y  = (s) => `\x1b[33m${s}\x1b[0m`;
const C  = (s) => `\x1b[36m${s}\x1b[0m`;
const B  = (s) => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0, warnings = 0;
const errors = [];

function ok(label)  { passed++;  console.log(`  ${G('✔')}  ${label}`); }
function err(label, detail) { failed++;  errors.push({ label, detail }); console.log(`  ${R('✘')}  ${label}${detail ? ` — ${R(detail)}` : ''}`); }
function warn(label) { warnings++; console.log(`  ${Y('⚠')}  ${label}`); }
function section(title) { console.log(`\n${B(C('══ ' + title + ' ══'))}`); }

// ══════════════════════════════════════════════════════════════
// 1. FILE SYSTEM — Critical files exist
// ══════════════════════════════════════════════════════════════
section('1 · FILE SYSTEM');

const criticalFiles = [
    'server.js',
    'package.json',
    'vite.config.js',
    'start.bat',
    'core/database.js',
    'core/enriched_predictions.js',
    'core/prediction_engine.py',
    'core/python_worker.py',
    'core/redisClient.js',
    'services/cronManager.js',
    'services/mlPredictionService.js',
    'services/FPISEngine.js',
    'services/tactical_service.js',
    'services/MarketCorrelationEngine.js',
    'routes/matches.js',
    'routes/system.js',
    'SofascoreScraping/index.js',
    'SofascoreScraping/src/Workflow.js',
    'leagues_ids.json',
];

const optionalFiles = [
    'models/stitch_v24_hybrid.json',
    '.env',
    'core/logger.js',
    'core/speedCache.js',
    'core/shieldEngine.js',
    'services/redisCache.js',
];

for (const f of criticalFiles) {
    const full = path.join(__dirname, f);
    if (fs.existsSync(full)) {
        ok(f);
    } else {
        err(f, 'FILE MISSING');
    }
}
for (const f of optionalFiles) {
    const full = path.join(__dirname, f);
    if (fs.existsSync(full)) {
        ok(`[OPT] ${f}`);
    } else {
        warn(`[OPT] ${f} — not found (optional)`);
    }
}

// ══════════════════════════════════════════════════════════════
// 2. NODE MODULES — Key dependencies resolvable
// ══════════════════════════════════════════════════════════════
section('2 · NODE MODULES');

const requiredModules = [
    'express', 'better-sqlite3', 'node-cron',
    'axios', 'socket.io', 'cors', 'compression',
    'react', 'react-dom', 'react-window',
    'vite', 'concurrently', 'ioredis', 'helmet'
];

for (const mod of requiredModules) {
    try {
        require.resolve(mod);
        ok(mod);
    } catch (e) {
        err(mod, 'NOT INSTALLED — run: npm install');
    }
}

// ══════════════════════════════════════════════════════════════
// 3. CORE SERVICES — Load without crashing
// ══════════════════════════════════════════════════════════════
section('3 · CORE SERVICES (require check)');

const coreServices = [
    ['Database',            './core/database'],
    ['Logger',              './core/logger'],
    ['SpeedCache',          './core/speedCache'],
    ['LeagueRegistry',      './config/leagueRegistry'],
    ['EliteClubs',          './config/eliteClubs'],
    ['EnvironmentalIntel',  './services/EnvironmentalIntelligence'],
    ['DeepFormService',     './services/DeepFormService'],
    ['PatternService',      './services/patternService'],
    ['MotivationEnrich',    './services/MotivationEnrichService'],
    ['BankrollService',     './services/bankrollService'],
    ['AdaptiveLearning',    './services/adaptiveLearningEngine'],
    ['MarketCorrelation',   './services/MarketCorrelationEngine'],
    ['SharpIntelligence',   './services/SharpIntelligenceService'],
    ['IntegrityService',    './services/integrity_service'],
    ['ValueBetEngine',      './src/services/ValueBetEngine'],
    ['PlayerPropsService',  './services/playerPropsService'],
];

for (const [label, modPath] of coreServices) {
    try {
        require(modPath);
        ok(label);
    } catch (e) {
        err(label, e.message.split('\n')[0].substring(0, 120));
    }
}

// ══════════════════════════════════════════════════════════════
// 4. DATABASE — Connectivity & schema integrity
// ══════════════════════════════════════════════════════════════
section('4 · DATABASE');

try {
    const db = require('../stitch/core/database');
    const row = db.db.prepare("SELECT COUNT(*) as cnt FROM matches").get();
    ok(`matches table exists — ${row.cnt} rows`);

    const row2 = db.db.prepare("SELECT COUNT(*) as cnt FROM historical_matches").get();
    ok(`historical_matches — ${row2.cnt} rows`);

    const row3 = db.db.prepare("SELECT COUNT(*) as cnt FROM matches WHERE home_win_probability > 0").get();
    const perc = row.cnt > 0 ? Math.round((row3.cnt / row.cnt) * 100) : 0;
    if (perc >= 70) ok(`Enrichment coverage — ${perc}% of matches have predictions`);
    else if (perc >= 30) warn(`Enrichment coverage low — only ${perc}% have predictions`);
    else err('Enrichment coverage', `Only ${perc}% — most matches lack predictions`);

    // Check for stale/null prediction entries
    const nullPred = db.db.prepare("SELECT COUNT(*) as cnt FROM matches WHERE prediction IS NULL OR prediction = 'UNDER ANALYSIS'").get();
    if (nullPred.cnt === 0) ok('No UNDER ANALYSIS entries in DB');
    else if (nullPred.cnt < 20) warn(`${nullPred.cnt} matches still marked UNDER ANALYSIS`);
    else err('Stale predictions', `${nullPred.cnt} matches lack a real prediction`);

    // Check for '? - ?' or '1 - 1' default scores
    const defaultScore = db.db.prepare("SELECT COUNT(*) as cnt FROM matches WHERE expected_score = '1 - 1'").get();
    if (defaultScore.cnt === 0) ok('No default 1-1 scores in DB');
    else warn(`${defaultScore.cnt} matches have default expected_score '1 - 1'`);

} catch (e) {
    err('Database', e.message);
}

// ══════════════════════════════════════════════════════════════
// 5. AI SERVER — HTTP health check on port 8000
// ══════════════════════════════════════════════════════════════
section('5 · AI SERVER (port 8000)');

function httpGet(port, path, label) {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode === 200) { ok(`${label} → HTTP ${res.statusCode}`); resolve(true); }
                else { warn(`${label} → HTTP ${res.statusCode}`); resolve(false); }
            });
        });
        req.on('error', (e) => {
            err(label, `Cannot connect — ${e.message}`);
            resolve(false);
        });
        req.on('timeout', () => {
            req.destroy();
            err(label, 'Timeout (3s) — server may be down');
            resolve(false);
        });
    });
}

// ══════════════════════════════════════════════════════════════
// 6. NODE SERVER — HTTP health check on port 3000/3001/5000
// ══════════════════════════════════════════════════════════════
section('6 · NODE API SERVER');

async function runNetworkChecks() {
    await httpGet(8000, '/health', 'AI Predictor /health');
    await httpGet(3000, '/api/health', 'Node API /api/health port 3000');
    await httpGet(3001, '/api/health', 'Node API /api/health port 3001');
    await httpGet(5001, '/api/health', 'Node API /api/health port 5001');
}

// ══════════════════════════════════════════════════════════════
// 7. ENRICHED PREDICTIONS — fastEnrichMatch smoke test
// ══════════════════════════════════════════════════════════════
section('7 · FAST ENRICH SMOKE TEST');

async function runEnrichTest() {
    try {
        const ep = require('../stitch/core/enriched_predictions');
        const mockMatch = {
            id: 'TEST-001',
            homeTeam: 'Manchester City',
            awayTeam: 'Arsenal',
            league: 'premier league',
            status: 'scheduled',
            home_xg: 1.8,
            away_xg: 1.2,
            teamStats: {
                home: { avgGoalsScored: 2.1, avgGoalsConceded: 0.9, matchesPlayed: 20 },
                away: { avgGoalsScored: 1.7, avgGoalsConceded: 1.1, matchesPlayed: 20 }
            }
        };
        const result = await ep.fastEnrichMatch(mockMatch);
        if (result && result.home_win_probability > 0) {
            ok(`fastEnrichMatch → Home:${result.home_win_probability}% Draw:${result.draw_probability}% Away:${result.away_win_probability}%`);
            ok(`Expected score: ${result.expected_score || 'N/A'}`);
            ok(`Verdict: ${result.verdict || 'N/A'}`);
        } else {
            err('fastEnrichMatch', 'Returned zero probabilities');
        }
    } catch (e) {
        err('fastEnrichMatch', e.message.split('\n')[0]);
    }
}

// ══════════════════════════════════════════════════════════════
// 8. PYTHON ENGINE — Check python + xgboost importable
// ══════════════════════════════════════════════════════════════
section('8 · PYTHON ENGINE');

const { spawn } = require('child_process');

function runPythonCheck() {
    return new Promise((resolve) => {
        const py = spawn('python', ['-c', `
import sys
sys.path.insert(0, 'core')
try:
    import xgboost as xgb
    print("XGBoost OK:", xgb.__version__)
except ImportError as e:
    print("XGBoost MISSING:", str(e))
try:
    import fastapi
    print("FastAPI OK:", fastapi.__version__)
except:
    print("FastAPI MISSING")
try:
    import numpy
    print("NumPy OK:", numpy.__version__)
except:
    print("NumPy MISSING")
try:
    import pandas
    print("Pandas OK:", pandas.__version__)
except:
    print("Pandas MISSING")
`], { cwd: __dirname, windowsHide: true });
        let out = '', errOut = '';
        py.stdout.on('data', d => out += d);
        py.stderr.on('data', d => errOut += d);
        py.on('close', () => {
            const lines = out.trim().split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                if (line.includes('OK')) ok(`Python: ${line.trim()}`);
                else if (line.includes('MISSING')) err(`Python: ${line.trim()}`);
                else warn(`Python: ${line.trim()}`);
            }
            if (errOut && !errOut.includes('Traceback')) warn(`Python stderr: ${errOut.substring(0, 200)}`);
            resolve();
        });
        py.on('error', () => {
            err('Python', 'python command not found — is Python in PATH?');
            resolve();
        });
    });
}

// ══════════════════════════════════════════════════════════════
// 9. XGBOOST MODEL FILE
// ══════════════════════════════════════════════════════════════
section('9 · XGBOOST MODEL FILE');

const modelPath = path.join(__dirname, 'models', 'stitch_v24_hybrid.json');
if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath);
    if (stat.size > 1000) ok(`stitch_v24_hybrid.json (${Math.round(stat.size / 1024)} KB)`);
    else err('stitch_v24_hybrid.json', 'File too small — may be corrupted');
} else {
    err('stitch_v24_hybrid.json', 'Model file not found in models/');
}

// ══════════════════════════════════════════════════════════════
// FINAL REPORT
// ══════════════════════════════════════════════════════════════
async function main() {
    await runNetworkChecks();
    await runEnrichTest();
    await runPythonCheck();

    console.log('\n' + '═'.repeat(60));
    console.log(B('TITANIUM DIAGNOSTIC REPORT'));
    console.log('═'.repeat(60));
    console.log(G(`  ✔ PASSED   : ${passed}`));
    console.log(Y(`  ⚠ WARNINGS : ${warnings}`));
    console.log(R(`  ✘ FAILED   : ${failed}`));
    console.log('═'.repeat(60));

    if (errors.length > 0) {
        console.log(B(R('\nCRITICAL ERRORS TO FIX:')));
        errors.forEach((e, i) => {
            console.log(R(`  ${i + 1}. [${e.label}] → ${e.detail || 'see above'}`));
        });
    } else {
        console.log(G('\n  ✅ ALL SYSTEMS OPERATIONAL!'));
    }

    const overall = failed === 0 ? 'HEALTHY' : failed <= 3 ? 'DEGRADED' : 'CRITICAL';
    const statusColor = overall === 'HEALTHY' ? G : overall === 'DEGRADED' ? Y : R;
    console.log('\n' + statusColor(`  SYSTEM STATUS: ${overall}`) + '\n');
}

main().catch(e => {
    console.error(R('Fatal diagnostic error:'), e.message);
});
