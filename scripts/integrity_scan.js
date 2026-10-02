/**
 * integrity_scan.js — E70 backtest du score d'intégrité a posteriori.
 *
 * Scanne les matchs TERMINES (matches + historical_matches), applique
 * IntegrityScorer, et affiche le classement des matchs les plus anormaux.
 * Aucune preuve de match-fixing n'est produite : on mesure des écarts
 * statistiques (score vs xG, cote du vainqueur, steam, incidents).
 *
 * Usage : node scripts/integrity_scan.js                    (DRY-RUN, lecture seule)
 *         node scripts/integrity_scan.js --write            (persiste les 3 colonnes)
 *         ... --limit=50 --min=25 --target=matches|historical|both
 *         ... --by=league                                   (repartition par championnat)
 */
const path = require('path')
const REPO = path.join(__dirname, '..')
// E71 : passer par core/database (et non un new Database() direct) pour que le
// cron fonctionne sur les deux backends. core/database expose un handle avec
// .prepare().all/get/run ET .transaction() identiques en SQLite (better-sqlite3)
// et en PostgreSQL (pg_database fournit un worker synchrone + un wrapper
// transaction no-op). Un chemin 'data/tactical.db' en dur cassait le cron en prod
// (DATABASE_URL = PG) et ne voyait aucune donnee.
const database = require(REPO + '/core/database')
const integrityScorer = require(REPO + '/services/integrityScorer')

const WRITE = process.argv.includes('--write')
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '--limit=50').split('=')[1])
const MINScore = Number((process.argv.find((a) => a.startsWith('--min=')) || '--min=50').split('=')[1])
const TARGET = (process.argv.find((a) => a.startsWith('--target=')) || '--target=both').split('=')[1]
const BY_LEAGUE = process.argv.includes('--by=league')

const FINISHED = `('FT','Finished','finished','FINISHED','AET','PEN')`

;(async () => {
  const db = database.db

  const results = []

  if (TARGET === 'matches' || TARGET === 'both') {
    const rows = db
      .prepare(
        `SELECT * FROM matches
         WHERE status IN ${FINISHED} AND scoreHome IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(LIMIT)
    for (const r of rows) results.push({ table: 'matches', row: r, ...integrityScorer.scoreMatch(r) })
  }

  if (TARGET === 'historical' || TARGET === 'both') {
    const rows = db
      .prepare(
        `SELECT * FROM historical_matches
         WHERE scoreHome IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(LIMIT)
    for (const r of rows) results.push({ table: 'historical', row: r, ...integrityScorer.scoreMatch(r) })
  }

  results.sort((a, b) => b.fixing_score - a.fixing_score)

  // ── Statistiques globales ────────────────────────────────────────────
  const dist = { NORMAL: 0, A_SURVEILLER: 0, SUSPECT: 0, HAUTEMENT_SUSPECT: 0 }
  const famCnt = { XG: 0, MARCHE: 0, INCIDENTS: 0, SIGNATURE: 0 }
  let notAssessable = 0
  let lowConf = 0
  for (const r of results) {
    if (dist[r.verdict] !== undefined) dist[r.verdict]++
    else dist[r.verdict] = (dist[r.verdict] || 0) + 1
    if (!r.assessable) notAssessable++
    if (r.low_confidence) lowConf++
    for (const f of r.coverage) famCnt[f] = (famCnt[f] || 0) + 1
  }

  const flagged = results.filter((r) => r.fixing_score >= MINScore)

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(`  E70 — SCAN D'INTÉGRITÉ A POSTERIORI`)
  console.log(`  Table(s) : ${TARGET} · Scannés : ${results.length} · Seuil : ${MINScore}`)
  console.log('══════════════════════════════════════════════════════════════')
  console.log(
    `  NORMAL ${dist.NORMAL} | A_SURVEILLER ${dist.A_SURVEILLER} | SUSPECT ${dist.SUSPECT} | HAUTEMENT_SUSPECT ${dist.HAUTEMENT_SUSPECT}`
  )
  if (dist.DONNEE_INSUFFISANTE) console.log(`  DONNEE_INSUFFISANTE : ${dist.DONNEE_INSUFFISANTE}`)
  console.log(`  Score bas mais NON ÉVALUABLE (aucune donnée) : ${notAssessable}`)
  console.log(`  Score >= 25 mais CONFIANCE FAIBLE (rotation/score extrême) : ${lowConf}`)
  console.log('\n  COUVERTURE DES FAMILLES DE SIGNAUX :')
  for (const k of Object.keys(famCnt)) {
    const pct = ((famCnt[k] / results.length) * 100).toFixed(1)
    console.log(`    ${k.padEnd(12)} ${String(famCnt[k]).padStart(6)}  (${pct}%)`)
  }

  // ── Top des plus suspects ────────────────────────────────────────────
  const top = flagged.slice(0, 25)
  if (top.length === 0) {
    console.log('\n  ✅ Aucun match au-dessus du seuil.')
  } else {
    console.log(`\n  TOP ${top.length} MATCHS LES PLUS ANORMAUX :\n`)
    for (const [i, r] of top.entries()) {
      const m = r.row
      console.log(
        `  ${String(i + 1).padStart(2)}. [${r.fixing_score}] ${r.verdict.padEnd(17)} ` +
          `${m.homeTeam} ${m.scoreHome}-${m.scoreAway} ${m.awayTeam}  (${m.league || '?'})`
      )
      for (const s of r.signals) console.log(`        +${s.weight} ${s.flag} — ${s.detail}`)
    }
  }

  // ── Répartition par championnat (taux de suspicion) ──────────────────
  if (BY_LEAGUE) {
    const byLg = new Map()
    for (const r of results) {
      const lg = r.row.league || 'UNKNOWN'
      const acc = byLg.get(lg) || { n: 0, sum: 0, hi: 0 }
      acc.n += 1
      acc.sum += r.fixing_score
      if (r.fixing_score >= 50) acc.hi += 1
      byLg.set(lg, acc)
    }
    const ranked = [...byLg.entries()]
      .map(([lg, a]) => ({ lg, n: a.n, avg: a.sum / a.n, hi: a.hi, rate: (a.hi / a.n) * 100 }))
      .sort((a, b) => b.rate - a.rate || b.avg - a.avg)
    console.log('\n  SUSPICION PAR CHAMPIONNAT (taux >= 50, moy. score) :\n')
    for (const g of ranked.slice(0, 20)) {
      console.log(
        `    ${g.lg.padEnd(28)} n=${String(g.n).padStart(4)}  taux=${g.rate.toFixed(1).padStart(5)}%  moy=${g.avg.toFixed(1).padStart(5)}`
      )
    }
  }

  // ── Persistance ──────────────────────────────────────────────────────
  if (WRITE) {
    let n = 0
    const updM = db.prepare(
      'UPDATE matches SET fixing_score=?, fixing_flags=?, integrity_verdict=? WHERE id=?'
    )
    const updH = db.prepare(
      'UPDATE historical_matches SET fixing_score=?, fixing_flags=?, integrity_verdict=? WHERE id=?'
    )
    db.transaction(() => {
      for (const r of results) {
        const args = [r.fixing_score, JSON.stringify(r.flags), r.verdict, r.row.id]
        if (r.table === 'matches') updM.run(...args)
        else updH.run(...args)
        n++
      }
    })()
    console.log(`\n  ✅ Written : ${n} ligne(s) mise(s) à jour.`)
  } else {
    console.log('\n  ℹ️  DRY-RUN — relancer avec --write pour persister.')
  }

  console.log(
    '\n  ⚠️  Rappel : score d\'ANOMALIE statistique. Faux positifs fréquents (blessures,\n' +
      '     météo,Composition). Ne jamais traiter comme une preuve de manipulation.\n'
  )
})()
