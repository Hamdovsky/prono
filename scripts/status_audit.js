/**
 * Audit — statut consolidé en une commande.
 *
 *   node scripts/status_audit.js
 *
 * Sections :
 *   1. Gardes de réactivation (ISO_CAL, 1X2 pur, BTTS) — réutilise la logique
 *      des scripts de gates (aucune duplication des critères).
 *   2. Couverture cotes sur les matchs à venir (odds_source renseigné).
 *   3. Derniers événements politiques dans logs/info.log
 *      ([MARKET_POLICY], [LEAGUE_POLICY], dernière cote DATAFUSION).
 *   4. Tâches planifiées audit : dernier résultat Pronos-DataPipeline /
 *      Pronos-ISO-Gate / Pronos-MarketGates.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
process.chdir(root)

const { isoGate } = require(path.join(root, 'scripts', 'check_iso_gate'))
const { gate1x2, gateBtts, N_MIN } = require(path.join(root, 'scripts', 'check_market_gates'))

function line() {
  console.log('-'.repeat(62))
}

// ---------- 1. Gardes ----------
console.log('AUDIT STITCH — STATUT CONSOLIDÉ —', new Date().toLocaleString('fr-FR'))
line()
const iso = isoGate()
const g12 = gate1x2()
const gbt = gateBtts()
console.log('1) GARDES DE RÉACTIVATION')
console.log(
  `   ISO_CAL : C1 ${iso.nPost}/200 ${iso.nPost >= 200 ? 'OK' : '…'} | C2 monotone ${iso.c2.ok ? 'OK' : '…'} -> ${iso.go ? 'GO' : 'attente'}`
)
console.log(
  `   1X2 pur : n=${g12.n}/${N_MIN} précision=${g12.acc != null ? g12.acc.toFixed(1) + '%' : '-'} -> ${g12.pass ? 'GO' : 'attente'}`
)
console.log(
  `   BTTS    : n=${gbt.n}/${N_MIN} précision=${gbt.acc != null ? gbt.acc.toFixed(1) + '%' : '-'} ROI=${gbt.roi != null ? gbt.roi.toFixed(1) + '%' : '-'} -> ${gbt.pass ? 'GO' : 'attente'}`
)

// ---------- 2. Couverture cotes à venir ----------
let cov = { total: 0, avecSource: 0, bySrc: {} }
try {
  const { db } = require(path.join(root, 'core', 'database'))
  const now = Math.floor(Date.now() / 1000)
  const tot = db
    .prepare(
      `SELECT COUNT(*) n FROM matches
       WHERE startTimestamp > ? AND status IN ('scheduled','NOT_STARTED','NS','TIMED')`
    )
    .get(now).n
  const rows = db
    .prepare(
      `SELECT odds_source, COUNT(*) n FROM matches
       WHERE startTimestamp > ? AND status IN ('scheduled','NOT_STARTED','NS','TIMED')
       AND odds_source IS NOT NULL GROUP BY odds_source`
    )
    .all(now)
  let withSrc = 0
  for (const r of rows) {
    withSrc += r.n
    cov.bySrc[r.odds_source] = r.n
  }
  cov = { total: tot, avecSource: withSrc, bySrc: cov.bySrc }
} catch (_) {}
const pct = cov.total ? ((cov.avecSource / cov.total) * 100).toFixed(1) : '0'
console.log('\n2) COUVERTURE COTES À VENIR')
console.log(`   ${cov.avecSource}/${cov.total} (${pct}%) avec odds_source | détail: ${JSON.stringify(cov.bySrc)}`)

// ---------- 3. Derniers événements politiques ----------
console.log('\n3) DERNIERS ÉVÉNEMENTS (logs/info.log)')
try {
  const logPath = path.join(root, 'logs', 'info.log')
  const raw = fs.readFileSync(logPath, 'utf8')
  const lines = raw.split('\n').slice(-4000)
  const lastMatching = (re) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (re.test(lines[i])) return lines[i]
    }
    return null
  }
  const show = (label, re) => {
    const l = lastMatching(re)
    if (!l) return
    const ts = (l.match(/"timestamp":"([^"]+)"/) || [])[1] || ''
    const msg = (l.match(/"message":"(.*)"\}?$/) || [])[1] || l.slice(0, 120)
    console.log(`   ${ts} ${label}: ${msg.slice(0, 110)}`)
  }
  show('[MARKET_POLICY]', /\[MARKET_POLICY\]/)
  show('[LEAGUE_POLICY]', /\[LEAGUE_POLICY\]/)
  show('[DATAFUSION cote]', /Odds from/)
} catch (_) {}

// ---------- 4. Tâches planifiées ----------
console.log('\n4) TÂCHES PLANIFIÉES AUDIT')
const tasks = ['Pronos-DataPipeline', 'Pronos-Fenetres-P1', 'Pronos-ISO-Gate', 'Pronos-MarketGates']
for (const t of tasks) {
  try {
    const out = execFileSync('schtasks', ['/query', '/tn', t, '/v', '/fo', 'CSV'], {
      encoding: 'utf8',
      timeout: 15000,
    })
    const rows = out.split(/\r?\n/).filter((l) => l.includes('","'))
    if (rows.length >= 2) {
      // CSV verbeux FR/EN positionnel : 2=Prochaine exécution, 3=Statut,
      // 4=Mode d'ouverture, 5=Dernière exécution, 6=Dernier résultat
      const f = rows[1].split('","').map((s) => s.replace(/^"|"$/g, ''))
      const nextRun = f[2] || '-'
      let lastRun = f[5] || '-'
      const lastRes = (f[6] || '-').trim()
      if (/^30\/11\/1999|^11\/30\/1999/.test(lastRun)) lastRun = 'jamais'
      let okMark = /^(0|0x0)$/i.test(lastRes) ? 'OK' : lastRes || 'jamais'
      if (/^267011/.test(okMark)) okMark = 'jamais'
      console.log(`   ${t.padEnd(22)} dernier=${lastRun} résultat=${okMark} prochain=${nextRun}`)
    }
  } catch (_) {
    console.log(`   ${t.padEnd(22)} introuvable`)
  }
}

line()
console.log('Astuce : relancer après les cycles (cron 07h00, gates lundi matin).')
