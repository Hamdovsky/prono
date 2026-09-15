/**
 * backfill_fotmob_stats.js — E37 backfill stats d'equipe (xG/corners/shots/poss).
 *
 * Deux cibles :
 *   matches           -> via fotmobStatsExtractor (UPDATE des COLONNES; home_xg/...)
 *   historical_matches -> via merge du fullData (les colonnes home_xg/fotmob_id n'y
 *                        existent pas; accuracyEngine & ML relisent fd.home_xg).
 *
 * Lien livescore -> fotmob_id : par (date + equipes normalisees) via liste
 * journaliere FotMob (cache par jour, 1 req/jour). Idempotent : ne recouvre
 * jamais une valeur deja presente (COALESCE / merge sans ecrasement).
 *
 * Usage : node scripts/backfill_fotmob_stats.js            (DRY-RUN)
 *         node scripts/backfill_fotmob_stats.js --write
 *         ... --limit=200 [--target=matches|historical|both]
 */
const path = require('path')
const REPO = path.join(__dirname, '..')
const Database = require('better-sqlite3')
const { normDate, joinKey } = require(REPO + '/core/fdJoin')
const { mergeOddsIntoFullData } = require(REPO + '/core/archiveMerge')

const WRITE = process.argv.includes('--write')
const TARGET = ((process.argv.find((a) => a.startsWith('--target=')) || '--target=both').split('=')[1])
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '--limit=200').split('=')[1])

;(async () => {
  const db = new Database(REPO + '/data/tactical.db', WRITE ? {} : { readonly: true })
  const { processFinishedMatches, _dayMap } = require(REPO + '/services/fotmobStatsExtractor')
  const fotmob = require(REPO + '/services/fotmobService')

  const done = { matches: null, historical: null }
  if (TARGET === 'matches' || TARGET === 'both') {
    done.matches = await processFinishedMatches(db, { limit: LIMIT, write: WRITE })
  }
  if (TARGET === 'historical' || TARGET === 'both') {
    // idempotent : lignes sans fd.home_xg; ordre recent d'abord
    const rows = db
      .prepare(
        `SELECT id, timestamp, homeTeam, awayTeam, fullData
         FROM historical_matches
         WHERE scoreHome IS NOT NULL
           AND json_extract(COALESCE(fullData,'{}'), '$.home_xg') IS NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(LIMIT)
    let matched = 0
    let written = 0
    let skipped = 0
    const upd = db.prepare('UPDATE historical_matches SET fullData=? WHERE id=?')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const GAP = Number(process.env.FOTMOB_STATS_GAP_MS ?? 2200)
    for (const r of rows) {
      let fd = {}
      try {
        fd = JSON.parse(r.fullData || '{}')
      } catch {
        fd = {}
      }
      const date = normDate(r.timestamp)
      const key = date ? joinKey(date, r.homeTeam, r.awayTeam) : null
      let fid = fd.fotmob_id
      if (!fid && key) {
        const map = await _dayMap(fotmob, date)
        fid = map.get(key)
      }
      if (!fid) {
        skipped++
        continue
      }
      const s = await fotmob.getMatchStats(fid)
      if (!s || (s.xg_home == null && s.corners_home == null)) {
        skipped++
        continue
      }
      matched++
      const merged = mergeOddsIntoFullData(fd, s)
      merged.fotmob_id = merged.fotmob_id || fid
      if (WRITE) {
        upd.run(JSON.stringify(merged), r.id)
        written++
      }
      await sleep(GAP)
    }
    done.historical = { scanned: rows.length, matched, written, skipped }
    console.log(`[FOTMOB-BF] historical ${WRITE ? 'WRITE' : 'DRY-RUN'} ${JSON.stringify(done.historical)}`)
  }
  if (done.matches) console.log(`[FOTMOB-BF] matches   ${WRITE ? 'WRITE' : 'DRY-RUN'} ${JSON.stringify(done.matches)}`)
  if (!WRITE) console.log('[FOTMOB-BF] DRY-RUN : rien ecrit. Relancer avec --write pour appliquer.')
  db.close()
})().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
