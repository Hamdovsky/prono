/**
 * backfill_xg_fotmob.js — E73b : remplit les xG des matchs deja joues.
 *
 * POURQUOI CE SCRIPT EXISTE
 * ------------------------
 * Mesure E73 : le modele classe correctement mais mal evalue, et son accuracy
 * (42.8%) reste SOUS la baseline naive "toujours le favori a domicile" (45.2%).
 * Recalibrer les sorties ne peut pas arranger un classement : il faut plus
 * d'INFORMATION entree. Or 10 200 des 13 915 matchs joues n'ont aucun xG
 * (73% de trou), et le circuit anti-integrite les classe DONNEE_INSUFFISANTE.
 *
 * Pourquoi ne pas simplement tourner `fotmobStatsExtractor._processHistorical`
 * a la main : son SELECT est `ORDER BY timestamp DESC` et il n'a ni reprise
 * ni arret propre. Un appel interrompu (redemarrage Render, rate limit) laisse
 * le curseur perdu et le rapport final muet. Ce script rend le travail
 * REPRENABLE et dit ce qu'il a fait.
 *
 * RENDEMENT MESURE (lot de 60, 2026-10-02) : 53/60 = 88%.
 * Cadence : 2.51 s/match (REQUEST_GAP = 2200 ms + 1 appel /details par match).
 * => le backlog complet represente ~7 h de calls, d'ou le --limit par defaut.
 *
 * LECTURE :
 *   node scripts/backfill_xg_fotmob.js --dry-run --limit 60
 *   node scripts/backfill_xg_fotmob.js --limit 200        # ecrit
 *   node scripts/backfill_xg_fotmob.js --stats            # etat du backlog
 *
 * DRY-RUN PAR DEFAUT : sans --write, rien n'est persiste.
 */

const database = require('../core/database')
const logger = require('../core/logger')
const fotmobStatsExtractor = require('../services/fotmobStatsExtractor')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

function backlog(db) {
  // E73b : meme filtre que _processHistorical — les matchs deja interroges sans
  // stats sont exclus, sinon le "backlog" annonce des matchs que le backfill ne
  // selectionnera jamais (et le pilote concluait a tort qu'il ne progressait pas).
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM historical_matches
       WHERE scoreHome IS NOT NULL
         AND json_extract(COALESCE(fullData,'{}'), '$.home_xg') IS NULL
         AND COALESCE(json_extract(COALESCE(fullData,'{}'), '$._fotmob_no_stats'), 0) = 0`
    )
    .get().n
}

function noStatsCount(db) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM historical_matches
       WHERE scoreHome IS NOT NULL
         AND json_extract(COALESCE(fullData,'{}'), '$.home_xg') IS NULL
         AND COALESCE(json_extract(COALESCE(fullData,'{}'), '$._fotmob_no_stats'), 0) = 1`
    )
    .get().n
}

async function main() {
  const db = database.db
  const write = hasFlag('write')
  const limit = Number(arg('limit', 200))
  const statsOnly = hasFlag('stats')

  if (statsOnly) {
    const missing = backlog(db)
    const noStats = noStatsCount(db)
    const total = db.prepare('SELECT COUNT(*) AS n FROM historical_matches WHERE scoreHome IS NOT NULL').get().n
    const covered = total - missing - noStats
    console.log('\n  etat xG des matchs joues')
    console.log('  ------------------------')
    console.log(`  couverts          : ${covered}/${total} (${((covered / total) * 100).toFixed(1)}%)`)
    console.log(`  a traiter         : ${missing}`)
    console.log(`  source sans stats : ${noStats}  (interroges, FotMob n'expose rien)`)
    if (missing > 0) {
      console.log(`  cadence estimee   : ~${((missing * 2.51) / 3600).toFixed(1)} h de calls`)
    } else {
      console.log('  backlog epuise    : plus rien a recuperer')
    }
    console.log('')
    return
  }

  if (!write) {
    console.log('\n  DRY-RUN : rien ne sera ecrit (ajouter --write pour persister)\n')
  }

  const before = backlog(db)
  console.log(`  backlog avant : ${before}`)
  console.log(`  lot : ${limit} matchs, ${write ? 'ECRITURE' : 'lecture seule'}\n`)

  const t0 = Date.now()
  const res = await fotmobStatsExtractor._processHistorical(db, { limit, write })
  const secs = (Date.now() - t0) / 1000

  const after = backlog(db)
  console.log('\n  resultat')
  console.log('  --------')
  console.log(`  scanned : ${res.scanned}`)
  console.log(`  matched : ${res.matched}${res.scanned ? ` (${((res.matched / res.scanned) * 100).toFixed(0)}%)` : ''}`)
  console.log(`  written : ${res.written}`)
  const done = before - after
  console.log(`  backlog : ${before} -> ${after} (${done} traite${done > 1 ? 's' : ''})`)
  if (res.scanned > 0) {
    const perMatch = secs / res.scanned
    console.log(`  duree   : ${secs.toFixed(0)}s (${perMatch.toFixed(2)} s/match)`)
    if (after > 0) {
      console.log(`  reste   : ~${((after * perMatch) / 3600).toFixed(1)} h de calls`)
    }
  }
  console.log('')
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error(`[XGBACKFILL] echec : ${e.message}`)
      console.error(e)
      process.exit(1)
    })
}

module.exports = { backlog }