/**
 * Audit étape 2 : garde de réactivation de la calibration isotonique.
 *
 * Critères (plan V2, validés) :
 *   C1. n >= 200 picks enregistrés APRÈS les fixes d'honnêteté (post-P1,
 *       cutoff 2026-08-23T20:00Z) et settle connus (score final posé).
 *   C2. Courbe de calibration monotone croissante : dernière bande > première,
 *       aucune chute consécutive > 3 pts, au moins 4 bandes avec n >= 30.
 *
 * Tant que les critères ne sont pas réunis, la calibration reste celle du
 * rapport (probabilityCalibrator P1) — ISO_SOURCE=brackets (défaut).
 *
 * Usage :
 *   node scripts/check_iso_gate.js            # état des critères
 *   node scripts/check_iso_gate.js --activate # active ISO_SOURCE + refit si GO
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')

const CUTOFF = '2026-08-23T20:00:00.000Z'
const N_MIN = 200

// ---------- C1 : volume post-fix ----------
// Settles réels : matches.settled_at (posé par updateMatchResult) OU
// historical_matches.archived_at (archivage post-match). Les lignes
// scheduled avec score 0-0 par défaut sont exclues.
function computeC1() {
  try {
    const { db } = require(path.join(root, 'core', 'database'))
    const a = db
      .prepare(
        `SELECT COUNT(*) AS n FROM matches
         WHERE timestamp >= ? AND prediction IS NOT NULL AND settled_at IS NOT NULL`
      )
      .get(CUTOFF)
    const b = db
      .prepare(
        `SELECT COUNT(*) AS n FROM historical_matches
         WHERE timestamp >= ? AND prediction IS NOT NULL`
      )
      .get(CUTOFF)
    return (a.n || 0) + (b.n || 0)
  } catch (_) {
    return 0
  }
}

// ---------- C2 : monotonie ----------
function computeIsoCurve() {
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(root, 'data', 'accuracy_report.json'), 'utf8'))
    let bands = (((rep || {}).rolling || {}).last30days || {}).calibrationCurve || []
    bands = bands
      .map((b) => ({ ...b, lo: parseInt(String(b.band).split('-')[0], 10) || 0 }))
      .sort((a, b) => a.lo - b.lo)
    const usable = bands.filter((b) => b.count >= 30)
    let noBigDrop = true
    for (let i = 1; i < usable.length; i++) {
      if (usable[i].accuracy < usable[i - 1].accuracy - 3) noBigDrop = false
    }
    const rising = usable.length >= 2 && usable[usable.length - 1].accuracy > usable[0].accuracy
    const c2 = { ok: usable.length >= 4 && noBigDrop && rising, usable: usable.length, rising, noBigDrop }
    return { bands, c2 }
  } catch (_) {
    return { bands: [], c2: { ok: false } }
  }
}

function isoGate() {
  const nPost = computeC1()
  const { bands, c2 } = computeIsoCurve()
  return { nPost, bands, c2, go: nPost >= N_MIN && c2.ok }
}

function activateIso() {
  // 1. bascule .env
  const envPath = path.join(root, '.env')
  let env = fs.readFileSync(envPath, 'utf8')
  if (/^ISO_SOURCE=.*/m.test(env)) {
    env = env.replace(/^ISO_SOURCE=.*/m, 'ISO_SOURCE=accuracy_report')
  } else {
    env += (env.endsWith('\n') ? '' : '\n') + 'ISO_SOURCE=accuracy_report\n'
  }
  fs.writeFileSync(envPath, env)
  console.log('[GATE] .env: ISO_SOURCE=accuracy_report')

  // 2. refit isotonique depuis les agrégats accuracyEngine
  try {
    const py = fs.existsSync(path.join(root, '.venv', 'Scripts', 'python.exe'))
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : 'python'
    const out = execFileSync(py, [path.join(root, 'core', 'calibration_iso.py'), '--fit'], {
      env: { ...process.env, ISO_SOURCE: 'accuracy_report' },
      encoding: 'utf8',
      timeout: 120000,
    })
    console.log(out.split('\n').slice(0, 12).join('\n'))
    const iso = JSON.parse(fs.readFileSync(path.join(root, 'models', 'isotonic_params.json'), 'utf8'))
    console.log(
      `[GATE] refit OK: n=${iso.n_samples} brier ${Number(iso.brier_before).toFixed(4)} -> ${Number(iso.brier_after).toFixed(4)} (${iso.fitted_at})`
    )
    console.log('[GATE] Redémarrer la stack pour charger le nouveau modèle.')
  } catch (e) {
    console.log('[GATE] refit échoué:', e.message)
    process.exitCode = 1
  }
}

module.exports = { isoGate, activateIso, CUTOFF, N_MIN }

if (require.main === module) {
  process.chdir(root)
  const { nPost, bands, c2, go } = isoGate()
  console.log('=== GATE ISO_CAL ===')
  console.log(`C1 picks post-fix settle: ${nPost}/${N_MIN} -> ${nPost >= N_MIN ? 'OK' : 'PAS ENCORE'}`)
  console.log(
    `C2 courbe monotone: ${c2.ok ? 'OK' : 'PAS ENCORE'} (bandes utilisables=${c2.usable}, montee=${c2.rising}, pas-de-chute>3pts=${c2.noBigDrop})`
  )
  if (bands.length) {
    console.log('Bandes (bande, n, accuracy%):')
    for (const b of bands) console.log(`  ${b.band}: n=${b.count} acc=${b.accuracy}`)
  }
  console.log(go ? '\n>>> GO : réactivation possible.' : '\n>>> ATTENDRE : critères non réunis.')
  if (go && process.argv.includes('--activate')) activateIso()
}
