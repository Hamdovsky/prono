/**
 * Audit A1 : gardes de réactivation des marchés masqués (miroir du ISO gate).
 *
 * Les deux masques posés par l'audit sont réversibles sur PREUVES :
 *   - 1X2 pur   : masqué depuis P4 (DISABLE_PURE_1X2) car 42,2 % < 42,6 % requis.
 *     Critère de sortie : >= 42,6 % de précision sur n >= 200 verdicts ORIGINAUX
 *     émis post-fix (fullData.originalPrediction) et settlés.
 *   - BTTS      : affichage masqué (VITE_DISABLE_BTTS_DISPLAY) car 50-53 % ~= hasard.
 *     Critère de sortie : précision >= 55 % ET ROI flat > 0 sur n >= 200 picks
 *     btts_pick post-fix settlés (ROI via cotes odds_btts_yes/no persistées au sweep).
 *
 * Cutoff commun : déploiement des fixes (commit d5d182c) = 2026-08-23T20:00Z.
 * Tant que les critères ne sont pas réunis : simple rapport chiffré.
 * --activate : applique les bascules .env des gates en GO + redémarre la stack.
 *
 * Usage :
 *   node scripts/check_market_gates.js             # état des critères
 *   node scripts/check_market_gates.js --activate  # active ce qui est GO
 */
const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')

const root = path.join(__dirname, '..')
process.chdir(root)
const { db } = require(path.join(root, 'core', 'database'))

const CUTOFF = '2026-08-23T20:00:00.000Z'
const N_MIN = 200
const CUTOFF_MS = Date.parse(CUTOFF)

// Les settles vivent dans DEUX tables : matches (settled_at posé par
// updateMatchResult quand le score final arrive) et historical_matches
// (archivées après le match — proxy de settle : archived_at).
function loadSettled(selectCols) {
  const out = []
  try {
    const a = db
      .prepare(
        `SELECT ${selectCols}, fullData FROM matches
         WHERE timestamp >= ? AND settled_at IS NOT NULL`
      )
      .all(CUTOFF)
    for (const r of a) out.push(r)
  } catch (_) {}
  try {
    const b = db
      .prepare(
        `SELECT ${selectCols}, fullData FROM historical_matches
         WHERE archived_at >= ?`
      )
      .all(CUTOFF_MS)
    for (const r of b) out.push(r)
  } catch (_) {}
  return out
}

function parseFd(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s || {}
  } catch (_) {
    return {}
  }
}

// ---------------- GATE 1X2 PUR ----------------
function gate1x2() {
  const rows = loadSettled('id, homeTeam, awayTeam, scoreHome, scoreAway, prediction')
  let n = 0
  let ok = 0
  const byOrig = {}
  for (const r of rows) {
    const fd = parseFd(r.fullData)
    const orig = String(fd.originalPrediction || '').trim()
    if (!['1', 'X', '2'].includes(orig)) continue // verdicts non purs exclus
    const h = Number(r.scoreHome)
    const a = Number(r.scoreAway)
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue
    const real = h > a ? '1' : h === a ? 'X' : '2'
    n++
    byOrig[orig] = byOrig[orig] || { n: 0, ok: 0 }
    byOrig[orig].n++
    if (real === orig) {
      ok++
      byOrig[orig].ok++
    }
  }
  const acc = n ? (ok / n) * 100 : null
  return { n, ok, acc, byOrig, pass: n >= N_MIN && acc != null && acc >= 42.6 }
}

// ---------------- GATE BTTS ----------------
function gateBtts() {
  const rows = loadSettled('id, homeTeam, awayTeam, scoreHome, scoreAway, odds_btts_yes, odds_btts_no')
  let n = 0
  let ok = 0
  let profit = 0
  let bets = 0
  for (const r of rows) {
    const fd = parseFd(r.fullData)
    const pick = String(fd.btts_pick || '').toUpperCase() // 'BTTS YES' | 'BTTS NO'
    if (pick !== 'BTTS YES' && pick !== 'BTTS NO') continue
    const h = Number(r.scoreHome)
    const a = Number(r.scoreAway)
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue
    const realized = h > 0 && a > 0
    const yes = pick === 'BTTS YES'
    n++
    if (realized === yes) ok++
    // ROI flat 1u sur la jambe correspondante (cote persistée au sweep,
    // colonne matches ou fullData pour les lignes archivées)
    const o = parseFloat(yes ? r.odds_btts_yes : r.odds_btts_no) || parseFloat(yes ? fd.odds_btts_yes : fd.odds_btts_no)
    if (Number.isFinite(o) && o > 1) {
      bets++
      profit += realized === yes ? o - 1 : -1
    }
  }
  const acc = n ? (ok / n) * 100 : null
  const roi = bets ? (profit / bets) * 100 : null
  return {
    n,
    ok,
    acc,
    bets,
    profit: Math.round(profit * 100) / 100,
    roi,
    pass: n >= N_MIN && acc != null && acc >= 55 && roi != null && roi > 0,
  }
}

// ---------------- ACTIVATION CONDITIONNELLE ----------------
function setEnvFlag(key, value) {
  const envPath = path.join(root, '.env')
  let env = fs.readFileSync(envPath, 'utf8')
  const re = new RegExp(`^${key}=.*`, 'm')
  if (re.test(env)) env = env.replace(re, `${key}=${value}`)
  else env += (env.endsWith('\n') ? '' : '\n') + `${key}=${value}\n`
  fs.writeFileSync(envPath, env)
}

function restartStack() {
  console.log('[GATES] redémarrage de la stack pour charger les nouvelles flags...')
  const ps = path.join(root, 'scripts', 'stop_local_services.ps1')
  execFile(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps],
    { timeout: 60000 },
    () => {
      setTimeout(() => {
        const child = spawn('cmd.exe', ['/c', 'C:\\Users\\HAMDI\\Desktop\\HamdiProno\\pronos-server.bat'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.unref()
        console.log('[GATES] stack relancée (pronos-server.bat détaché).')
      }, 5000)
    }
  )
}

module.exports = { gate1x2, gateBtts, N_MIN, CUTOFF }

if (require.main === module) {
  process.chdir(root)
  const g12 = gate1x2()
  const gbt = gateBtts()
  console.log('=== GATES MARCHÉS (sortie de masque sur preuves) ===')
  console.log(
    `1X2 pur : n=${g12.n}/${N_MIN} précision=${g12.acc != null ? g12.acc.toFixed(1) + '%' : '-'} (requis >=42,6%) -> ${g12.pass ? 'GO' : 'PAS ENCORE'}`
  )
  if (g12.byOrig && Object.keys(g12.byOrig).length) {
    for (const [k, v] of Object.entries(g12.byOrig)) {
      console.log(`   verdict ${k}: ${v.ok}/${v.n}`)
    }
  }
  console.log(
    `BTTS   : n=${gbt.n}/${N_MIN} précision=${gbt.acc != null ? gbt.acc.toFixed(1) + '%' : '-'} ROI=${gbt.roi != null ? gbt.roi.toFixed(1) + '%' : '-'} (${gbt.bets} bets, profit ${gbt.profit}u) -> ${gbt.pass ? 'GO' : 'PAS ENCORE'}`
  )

  if (process.argv.includes('--activate')) {
    let activated = false
    if (g12.pass) {
      setEnvFlag('DISABLE_PURE_1X2', 'false')
      console.log('[GATES] ACTIVÉ : DISABLE_PURE_1X2=false — le 1X2 pur redevient émissible.')
      activated = true
    }
    if (gbt.pass) {
      setEnvFlag('VITE_DISABLE_BTTS_DISPLAY', 'false')
      console.log('[GATES] ACTIVÉ : VITE_DISABLE_BTTS_DISPLAY=false — affichage BTTS rétabli.')
      activated = true
    }
    if (activated) {
      restartStack()
    } else {
      console.log('[GATES] --activate : aucun critère GO, rien modifié.')
    }
  }
}
