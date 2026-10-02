/**
 * build_integrity_registry.js — E71
 *
 * Agrège les fixing_score >= 50 (SUSPECT) par equipe dans integrity_registry.
 * Ce registre est consommé par suspicious_match_guard.py (motif RECIDIVIST_TEAM)
 * et exposé dans l'API integrity.
 *
 * Usage : node scripts/build_integrity_registry.js           (DRY-RUN)
 *         node scripts/build_integrity_registry.js --write   (persiste)
 *         node scripts/build_integrity_registry.js --min=40  (seuil adaptatif)
 */
const path = require('path')
const REPO = path.join(__dirname, '..')
// Passer par database.js garantit initSchema + les migrations.
// On accede au handle SQLite via require(REPO + '/core/database').db
const database = require(REPO + '/core/database')

const WRITE = process.argv.includes('--write')
const MINScore = Number((process.argv.find((a) => a.startsWith('--min=')) || '--min=50').split('=')[1])

;(async () => {
  const db = database.db

  // Matchs avec un fixing_score au-dessus du seuil, contenant le score et les equipes
  const rows = db
    .prepare(
      `SELECT homeTeam, awayTeam, scoreHome, scoreAway, league, fixing_score, fixing_flags, integrity_verdict
       FROM historical_matches
       WHERE fixing_score >= ? AND scoreHome IS NOT NULL
       ORDER BY fixing_score DESC`
    )
    .all(MINScore)

  console.log(`\n══════════════════════════════════════════════════════════════`)
  console.log(`  E71 — REGISTRE D'INTEGRITE PAR EQUIPE`)
  console.log(`  Seuil : ${MINScore} · Matchs sources : ${rows.length}`)
  console.log(`══════════════════════════════════════════════════════════════\n`)

  // Agrégation par equipe : pour chaque team on collecte tous les matchs suspects
  // ou elle apparait (home ou away).
  const teamMap = new Map()
  for (const r of rows) {
    const addTeam = (team, league) => {
      if (!team) return
      const key = String(team).trim()
      if (!key) return
      const acc = teamMap.get(key) || { count: 0, totalScore: 0, maxScore: 0, last: r.integrity_verdict, league: league || '' }
      acc.count += 1
      acc.totalScore += r.fixing_score
      if (r.fixing_score > acc.maxScore) acc.maxScore = r.fixing_score
      teamMap.set(key, acc)
    }
    addTeam(r.homeTeam, r.league)
    addTeam(r.awayTeam, r.league)
  }

  // Filtrer : ne garder que les equipes >= 2 matchs suspects
  const teams = [...teamMap.entries()]
    .filter(([, a]) => a.count >= 2)
    .map(([team, a]) => ({
      team,
      flagged_count: a.count,
      avg_score: Math.round(a.totalScore / a.count),
      max_score: a.maxScore,
      last_flagged: a.last,
      league: a.league,
    }))
    .sort((a, b) => b.flagged_count - a.flagged_count || b.max_score - a.max_score)

  if (teams.length === 0) {
    console.log(`  Aucune équipe avec >= 2 matchs suspects (seuil ${MINScore}).`)
  } else {
    console.log(`  RECIDIVISTES (${teams.length}) :`)
    for (const t of teams.slice(0, 25)) {
      console.log(
        `    ${String(t.flagged_count).padStart(3)} flag(s) | avg ${String(t.avg_score).padStart(3)} | max ${String(t.max_score).padStart(3)} | ${t.team} (${t.league || '?'}) [${t.last_flagged}]`
      )
    }
  }

  // Persistance
  if (WRITE) {
    db.exec('DELETE FROM integrity_registry')
    const ins = db.prepare(
      'INSERT INTO integrity_registry (team, flagged_count, avg_score, max_score, last_flagged, league) VALUES (?, ?, ?, ?, ?, ?)'
    )
    db.transaction(() => {
      for (const t of teams) ins.run(t.team, t.flagged_count, t.avg_score, t.max_score, t.last_flagged, t.league)
    })()
    console.log(`\n  ✅ Written : ${teams.length} équipe(s) dans integrity_registry.`)
  } else {
    console.log(`\n  ℹ️  DRY-RUN — relancer avec --write pour persister.`)
  }
})()
