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
 *         ... --with-incidents  (historical : ajoute les lignes qui ont le xG
 *                             mais aucune timeline — réparation du merge E71)
 *         ... --has-ou-odds  (historical uniquement : lignes ayant deja une cote
 *                             O/U 2.5 propre sans xG -> alimente l'echantillon
 *                             ROI E38)
 */
const path = require('path')
const REPO = path.join(__dirname, '..')
const Database = require('better-sqlite3')
const { normDate, joinKey } = require(REPO + '/core/fdJoin')
const { mergeOddsIntoFullData, mergeIncidentsIntoFullData } = require(REPO + '/core/archiveMerge')

const WRITE = process.argv.includes('--write')
const HAS_OU = process.argv.includes('--has-ou-odds')
// E71 : retouche aussi les lignes qui ont le xG mais aucune timeline (voir le
// WHERE plus bas). Sans ce flag, on ne repare que les matchs sans xG du tout.
const WITH_INCIDENTS = process.argv.includes('--with-incidents')
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
    // Idempotent : on ne retouche que ce qui MANQUE. Deux cas de manque :
    //   - pas de xG            -> le filtre historique d'origine
    //   - xG ok MAIS 0 incident -> E71 : le merge des incidents a ete corrige
    //     apres coup, donc des lignes scoriees par le premier jet du backfill
    //     ont un tableau `incidents` vide alors que la source les expose. Le
    //     filtre d'origine les sautaitDEFINITIVEMENT (c'etait le bug).
    const missing =
      WITH_INCIDENTS
        ? `AND (json_extract(COALESCE(fullData,'{}'), '$.home_xg') IS NULL
                OR COALESCE(json_array_length(json_extract(fullData,'$.incidents')), 0) = 0)`
        : `AND json_extract(COALESCE(fullData,'{}'), '$.home_xg') IS NULL`
    const rows = db
      .prepare(
        `SELECT id, timestamp, homeTeam, awayTeam, fullData
         FROM historical_matches
         WHERE scoreHome IS NOT NULL
           ${missing}
         ${HAS_OU ? "AND json_extract(COALESCE(fullData,'{}'), '$.odds_over25') IS NOT NULL" : ''}
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(LIMIT)
    let matched = 0
    let written = 0
    let skipped = 0
    const upd = db.prepare('UPDATE historical_matches SET fullData=? WHERE id=?')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const GAP = Number(process.env.FOTMOB_STATS_GAP_MS ?? 2200)
    // E71-ter : le script ne loguait RIEN avant la fin. Un backfill de plusieurs
    // heures est donc impossible a suivre (on ne sait pas s'il avance ou s'il est
    // bloque sur le rate-limit FotMob). On emet un point de progression periodique.
    const PROGRESS_EVERY = Number(process.env.FOTMOB_BF_PROGRESS_EVERY ?? 50)
    // NE PAS nommer ce compteur `done` : un `const done = {}` plus haut sert
    // d'accumulateur de resume, et le shadower faisait `done.historical = ...`
    // sur un Number -> JSON.stringify(undefined) -> "historical DRY-RUN undefined".
    let processed = 0
    let lastProgressAt = Date.now()
    const tick = () => {
      processed++
      if (processed % PROGRESS_EVERY !== 0) return
      const pct = ((processed / rows.length) * 100).toFixed(1)
      const rate = processed / ((Date.now() - lastProgressAt) / 60000)
      console.log(
        `[FOTMOB-BF] ${processed}/${rows.length} (${pct}%) matched=${matched} written=${written} skipped=${skipped} ${rate.toFixed(0)} lig/min`
      )
      lastProgressAt = Date.now()
    }
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
        tick()
        continue
      }
      const s = await fotmob.getMatchStats(fid)
      if (!s || (s.xg_home == null && s.corners_home == null)) {
        skipped++
        tick()
        continue
      }
      matched++
      // getMatchStats normalise en xg_home/... ; fullData attend home_xg/...
      // -> renormaliser vers les cles STATS_FIELDS avant merge (COALESCE-safe).
      const statsRow = {
        fotmob_id: fid,
        home_xg: s.xg_home,
        away_xg: s.xg_away,
        xg_ht_home: s.xg_ht_home,
        xg_ht_away: s.xg_ht_away,
        corners_home: s.corners_home,
        corners_away: s.corners_away,
        corners_ht_home: s.corners_ht_home,
        corners_ht_away: s.corners_ht_away,
        shots_home: s.shots_home,
        shots_away: s.shots_away,
        shots_on_target_home: s.shots_on_target_home,
        shots_on_target_away: s.shots_on_target_away,
        possession_home: s.possession_home,
        possession_away: s.possession_away,
      }
      const merged = mergeOddsIntoFullData(fd, statsRow)
      merged.fotmob_id = merged.fotmob_id || fid
      // E71 : getMatchStats est un alias de getMatchDetails, qui renvoie deja la
      // timeline (fotmobClient.py:331, 0 requete supplementaire). On ne la
      // mergait pas -> le signal ANOMALOUS_INCIDENT de integrityScorer.js restait
      // a 0% de couverture alors que la donnee etait deja sous notre main.
      // ATTENTION : mergeIncidentsIntoFullData renvoie le fullData ENTIER, pas la
      // liste d'incidents (signature archiveMerge.js:76). Il faut donc remplacer
      // l'objet, pas/ecraser le champ. Premier jet : on assignait l'objet a
      // merged.incidents -> json_array_length = 0 sur toutes les lignes.
      if (Array.isArray(s.incidents) && s.incidents.length > 0) {
        Object.assign(merged, mergeIncidentsIntoFullData(merged, s.incidents))
      }
      if (WRITE) {
        upd.run(JSON.stringify(merged), r.id)
        written++
      }
      await sleep(GAP)
      tick()
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
