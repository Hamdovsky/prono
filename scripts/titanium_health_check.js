/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   TITANIUM FULL SYSTEM HEALTH CHECK — Diagnostic Suite v1.0 ║
 * ╚══════════════════════════════════════════════════════════════╝
 * Usage: node titanium_health_check.js
 */

const path = require('path')
const fs = require('fs')
const http = require('http')

// E104 : ce script vit dans scripts/, mais TOUTES ses listes de cibles sont
// écrites relativement à la RACINE du projet ('core/database', 'services/...').
// require() et fs.existsSync() résolvent relativement au FICHIER, pas au CWD :
// les cibles étaient donc cherchées dans scripts/ et jamais trouvées.
// Symptôme : 20 faux négatifs en section 3, et la section 1 ne testait rien —
// le script qualifiait un système parfaitement sain de « cassé ».
// Correctif : résoudre explicitement contre ROOT. Déclaré ici, avant toute
// utilisation (les listes de la section 1 l'utilisent déjà).
const ROOT = path.join(__dirname, '..')

// ── Colour helpers ─────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`
const R = (s) => `\x1b[31m${s}\x1b[0m`
const Y = (s) => `\x1b[33m${s}\x1b[0m`
const C = (s) => `\x1b[36m${s}\x1b[0m`
const B = (s) => `\x1b[1m${s}\x1b[0m`

let passed = 0,
  failed = 0,
  warnings = 0
const errors = []

function ok(label) {
  passed++
  console.log(`  ${G('✔')}  ${label}`)
}
function err(label, detail) {
  failed++
  errors.push({ label, detail })
  console.log(`  ${R('✘')}  ${label}${detail ? ` — ${R(detail)}` : ''}`)
}
function warn(label) {
  warnings++
  console.log(`  ${Y('⚠')}  ${label}`)
}
function section(title) {
  console.log(`\n${B(C('══ ' + title + ' ══'))}`)
}

// ══════════════════════════════════════════════════════════════
// 1. FILE SYSTEM — Critical files exist
// ══════════════════════════════════════════════════════════════
section('1 · FILE SYSTEM')

const criticalFiles = [
  'server.js',
  'package.json',
  'vite.config.mjs',   // E104 : renomme en .mjs
  'start.bat',
  'core/database.js',
  'services/enriched_predictions.js',
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
]

const optionalFiles = [
  'models/stitch_v24_hybrid.json',
  '.env',
  'core/logger.js',
  'core/speedCache.js',
  'core/shieldEngine.js',
  'services/redisCache.js',
]

for (const f of criticalFiles) {
  const full = path.join(ROOT, f)
  if (fs.existsSync(full)) {
    ok(f)
  } else {
    err(f, 'FILE MISSING')
  }
}
for (const f of optionalFiles) {
  const full = path.join(ROOT, f)
  if (fs.existsSync(full)) {
    ok(`[OPT] ${f}`)
  } else {
    warn(`[OPT] ${f} — not found (optional)`)
  }
}

// ══════════════════════════════════════════════════════════════
// 2. NODE MODULES — Key dependencies resolvable
// ══════════════════════════════════════════════════════════════
section('2 · NODE MODULES')

const requiredModules = [
  'express',
  'better-sqlite3',
  'node-cron',
  'axios',
  'socket.io',
  'cors',
  'compression',
  'react',
  'react-dom',
  'react-window',
  'vite',
  'concurrently',
  'ioredis',
  'helmet',
]

for (const mod of requiredModules) {
  try {
    require.resolve(mod)
    ok(mod)
  } catch (e) {
    err(mod, 'NOT INSTALLED — run: npm install')
  }
}

// ══════════════════════════════════════════════════════════════
// 3. CORE SERVICES — Load without crashing
// ══════════════════════════════════════════════════════════════
section('3 · CORE SERVICES (require check)')

const coreServices = [
  ['Database', './core/database'],
  ['Logger', './core/logger'],
  ['SpeedCache', './core/speedCache'],
  ['LeagueRegistry', './config/leagueRegistry'],
  ['EliteClubs', './config/eliteClubs'],
  ['EnvironmentalIntel', './services/EnvironmentalIntelligence'],
  ['DeepFormService', './services/DeepFormService'],
  ['PatternService', './services/patternService'],
  ['MotivationEnrich', './services/MotivationEnrichService'],
  ['BankrollService', './services/bankrollService'],
  ['AdaptiveLearning', './services/adaptiveLearningEngine'],
  ['MarketCorrelation', './services/MarketCorrelationEngine'],
  ['SharpIntelligence', './services/SharpIntelligenceService'],
  ['IntegrityService', './services/integrity_service'],
  ['ValueBetEngine', './services/ValueBetEngine'],
  ['PlayerPropsService', './services/playerPropsService'],
]

for (const [label, modPath] of coreServices) {
  try {
    require(path.join(ROOT, modPath))
    ok(label)
  } catch (e) {
    err(label, e.message.split('\n')[0].substring(0, 120))
  }
}

// ══════════════════════════════════════════════════════════════
// 4. DATABASE — Connectivity & schema integrity
// ══════════════════════════════════════════════════════════════
section('4 · DATABASE')

try {
  // E104 : chemin `../stitch/...` invalide depuis scripts/ — suppose une
      // arborescence imbriquée que le depot n'a plus. Les deux checks
      // echouaient silencieusement dans leur try/catch, donc le script
      // rapportait un faux negatif sur la DB et sur l'enrichissement.
      const db = require('../core/database')
  const row = db.db.prepare('SELECT COUNT(*) as cnt FROM matches').get()
  ok(`matches table exists — ${row.cnt} rows`)

  const row2 = db.db.prepare('SELECT COUNT(*) as cnt FROM historical_matches').get()
  ok(`historical_matches — ${row2.cnt} rows`)

  const row3 = db.db
    .prepare('SELECT COUNT(*) as cnt FROM matches WHERE home_win_probability > 0')
    .get()
  const perc = row.cnt > 0 ? Math.round((row3.cnt / row.cnt) * 100) : 0
  if (perc >= 70) ok(`Enrichment coverage — ${perc}% of matches have predictions`)
  else if (perc >= 30) warn(`Enrichment coverage low — only ${perc}% have predictions`)
  else err('Enrichment coverage', `Only ${perc}% — most matches lack predictions`)

  // E105 : ce controle comptait `prediction IS NULL` mais annonçait
  // « UNDER ANALYSIS » — or cette valeur n'existe pas dans la colonne
  // (les 8 detectes etaient des NULL). Libelle desormais exact.
  const nullPred = db.db
    .prepare(
      "SELECT COUNT(*) as cnt FROM matches WHERE prediction IS NULL OR TRIM(prediction) = '' OR prediction = 'UNDER ANALYSIS'"
    )
    .get()
  if (nullPred.cnt === 0) ok('All matches carry a prediction')
  else if (nullPred.cnt < 20) warn(`${nullPred.cnt} matches without prediction`)
  else err('Stale predictions', `${nullPred.cnt} matches lack a real prediction`)

  // E105 : ce controle comptait TOUS les matchs,Scheduled et annulés compris.
  // Sur 1643 matchs il en comptait 1073 « avec un score par défaut » alors que
  // la répartition est : 984 à venir (placeholder normal), 89 annulés (jamais
  // joués, placeholder normal), 0 réellement joués. Bruit pur : on ne compte
  // plus que les matchs joués, où un score attendu doit exister.
  const PLAYED = "'FT','Finished','finished','FINISHED','AET','PEN'"
  const defaultScore = db.db
    .prepare(
      `SELECT COUNT(*) as cnt FROM matches
       WHERE expected_score = '1 - 1'
         AND status IN (${PLAYED})
         AND (home_xg IS NULL OR away_xg IS NULL)`
    )
    .get()
  if (defaultScore.cnt === 0) ok('No placeholder expected_score among played matches')
  else err(
    'Placeholder scores',
    `${defaultScore.cnt} played matches have no xG, so expected_score fell back to '1 - 1'`
  )
} catch (e) {
  err('Database', e.message)
}

// ══════════════════════════════════════════════════════════════
// 5. AI SERVER — HTTP health check on port 8000
// ══════════════════════════════════════════════════════════════
section('5 · AI SERVER (port 8000)')

// E105 : timeout paramétrable. Le probe par défaut de 3 s était trop serré
// pour l'AI Predictor : ce script vient de charger 20 services, la base et
// Redis juste avant de sonder, donc le processus est sature au moment du
// probe. Résultat : « Timeout (3s) » alors que /health repondait HTTP 200.
function httpGet(port, path, label, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => {
        if (res.statusCode === 200) {
          ok(`${label} → HTTP ${res.statusCode}`)
          resolve(true)
        } else {
          warn(`${label} → HTTP ${res.statusCode}`)
          resolve(false)
        }
      })
    })
    req.on('error', (e) => {
      err(label, `Cannot connect — ${e.message}`)
      resolve(false)
    })
    req.on('timeout', () => {
      req.destroy()
      err(label, `Timeout (${timeoutMs / 1000}s) - server may be down or overloaded`)
      resolve(false)
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 6. NODE SERVER — HTTP health check on port 3000/3001/5000
// ══════════════════════════════════════════════════════════════
section('6 · NODE API SERVER')

async function runNetworkChecks() {
  await httpGet(8000, '/health', 'AI Predictor /health', 15000)
  // E104 : le port 3000 n'ecoute pas (l'API est sur PORT=3001, cf. start.bat).
  // Ces deux controles ne pouvaient produire que des faux negatifs.
  await httpGet(3001, '/api/health', 'Node API /api/health port 3001')
  // port 5001 : inexistant dans ce projet.
}

// ══════════════════════════════════════════════════════════════
// 7. ENRICHED PREDICTIONS — fastEnrichMatch smoke test
// ══════════════════════════════════════════════════════════════
section('7 · FAST ENRICH SMOKE TEST')

async function runEnrichTest() {
  try {
    // E104 : cf. ligne 164 — chemin corrigé.
      const ep = require('../services/enriched_predictions')
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
        away: { avgGoalsScored: 1.7, avgGoalsConceded: 1.1, matchesPlayed: 20 },
      },
    }
    const result = await ep.fastEnrichMatch(mockMatch)
    if (result && result.home_win_probability > 0) {
      ok(
        `fastEnrichMatch → Home:${result.home_win_probability}% Draw:${result.draw_probability}% Away:${result.away_win_probability}%`
      )
      ok(`Expected score: ${result.expected_score || 'N/A'}`)
      ok(`Verdict: ${result.verdict || 'N/A'}`)
    } else {
      err('fastEnrichMatch', 'Returned zero probabilities')
    }
  } catch (e) {
    err('fastEnrichMatch', e.message.split('\n')[0])
  }
}

// ══════════════════════════════════════════════════════════════
// 8. PYTHON ENGINE — Check python + xgboost importable
// ══════════════════════════════════════════════════════════════
section('8 · PYTHON ENGINE')

const { spawn } = require('child_process')

function runPythonCheck() {
  return new Promise((resolve) => {
    // E104 : on testait le Python du PATH (3.11 systeme), qui n'a AUCUN des
    // paquets du projet — d'ou « FastAPI MISSING » alors que le moteur
    // tourne tres bien sur le .venv. On teste desormais l'interpreteur que
    // l'application utilise reellement.
    let pyExe = 'python'
    try {
      const winPy = path.join(ROOT, '.venv', 'Scripts', 'python.exe')
      const nixPy = path.join(ROOT, '.venv', 'bin', 'python3')
      if (fs.existsSync(winPy)) pyExe = winPy
      else if (fs.existsSync(nixPy)) pyExe = nixPy
    } catch (_) {}
    const py = spawn(
      pyExe,
      [
        '-c',
        `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'core'))})
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
`,
      ],
      { cwd: __dirname, windowsHide: true }
    )
    let out = '',
      errOut = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (errOut += d))
    py.on('close', () => {
      const lines = out.trim().split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        if (line.includes('OK')) ok(`Python: ${line.trim()}`)
        else if (line.includes('MISSING')) err(`Python: ${line.trim()}`)
        else warn(`Python: ${line.trim()}`)
      }
      if (errOut && !errOut.includes('Traceback'))
        warn(`Python stderr: ${errOut.substring(0, 200)}`)
      resolve()
    })
    py.on('error', () => {
      err('Python', 'python command not found — is Python in PATH?')
      resolve()
    })
  })
}

// ══════════════════════════════════════════════════════════════
// 9. XGBOOST MODEL FILE
// ══════════════════════════════════════════════════════════════
section('9 · XGBOOST MODEL FILE')

const modelPath = path.join(ROOT, 'models', 'stitch_v24_hybrid.json')
if (fs.existsSync(modelPath)) {
  const stat = fs.statSync(modelPath)
  if (stat.size > 1000) ok(`stitch_v24_hybrid.json (${Math.round(stat.size / 1024)} KB)`)
  else err('stitch_v24_hybrid.json', 'File too small — may be corrupted')
} else {
  err('stitch_v24_hybrid.json', 'Model file not found in models/')
}

// ══════════════════════════════════════════════════════════════
// FINAL REPORT
// ══════════════════════════════════════════════════════════════
async function main() {
  await runNetworkChecks()
  await runEnrichTest()
  await runPythonCheck()

  console.log('\n' + '═'.repeat(60))
  console.log(B('TITANIUM DIAGNOSTIC REPORT'))
  console.log('═'.repeat(60))
  console.log(G(`  ✔ PASSED   : ${passed}`))
  console.log(Y(`  ⚠ WARNINGS : ${warnings}`))
  console.log(R(`  ✘ FAILED   : ${failed}`))
  console.log('═'.repeat(60))

  if (errors.length > 0) {
    console.log(B(R('\nCRITICAL ERRORS TO FIX:')))
    errors.forEach((e, i) => {
      console.log(R(`  ${i + 1}. [${e.label}] → ${e.detail || 'see above'}`))
    })
  } else {
    console.log(G('\n  ✅ ALL SYSTEMS OPERATIONAL!'))
  }

  const overall = failed === 0 ? 'HEALTHY' : failed <= 3 ? 'DEGRADED' : 'CRITICAL'
  const statusColor = overall === 'HEALTHY' ? G : overall === 'DEGRADED' ? Y : R
  console.log('\n' + statusColor(`  SYSTEM STATUS: ${overall}`) + '\n')

    // E104 : sortie explicite. Avant la correction des chemins, les 20 requires
    // echouaient instantanement et n'ouvraient aucun handle, donc le processus
    // se terminait tout seul. Une fois les chemins corriges, les services
    // reellement charges (DB, Redis, crons, timers) maintiennent la boucle
    // d'evenements ouverte : le script imprimait son rapport puis restait
    // bloque indefiniment. Le code de retour permet aussi d'enchainer en CI.
    process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(R('Fatal diagnostic error:'), e.message)
})
