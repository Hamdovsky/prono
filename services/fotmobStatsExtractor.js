/**
 * fotmobStatsExtractor.js — E37 (Chantier rentabilité, FotMob)
 *
 * Objectif : alimenter les stats D'EQUIPE (xG/corners/tirs/possession) via FotMob
 * pour les matchs `finished` qui n'en ont pas encore. C'est la matière première
 * des modèles O/U et corners (cf. E30/E31 : le modèle ou_25_prob interne ne bat
 * pas la base). Le SCORE de 1re mi-temps, lui, vient de livescore (Trh1/Trh2) via
 * updateMatchResult (E37 Étape 3).
 *
 * Miroir de sofascoreStatsExtractor, mais FotMob n'est pas IP-banni ici (Sofascore
 * 403). Idempotent (COALESCE) ; ne recouvre une colonne deja renseignee ; dry-run
 * par defaut. Lien livescore_<Eid> -> fotmob_id par (date + equipes normalisees)
 * via une liste journaliere /api/data/matches (1 requete/jour).
 *
 * Gate : l'appel du CRON #15b passe par FOTMOB_STATS_ENABLED (defaut OFF) ->
 * l'execution automatique n'a lieu que si l'operateur l'active. Le manuel
 * (node CLI / dry-run) n'est pas gated (juste lecture / --write explicite).
 */
const { normDate, joinKey } = require('../core/fdJoin')
const logger = require('../core/logger')

const DAY_MAP_TTL = 20 * 60 * 60 * 1000
const _dayMaps = new Map() // dateISO -> { ts, map: key->fotmobId }
// Cadence : sur (1 req/2s). Test/reglages -> FOTMOB_STATS_GAP_MS=0.
const REQUEST_GAP = Number(process.env.FOTMOB_STATS_GAP_MS ?? 2200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function _clearDayMap() {
  _dayMaps.clear()
}

// La carte des rencontres d'un jour (1 appel). Charge paresseusement + memoise.
async function _dayMap(fotmob, dateISO) {
  const hit = _dayMaps.get(dateISO)
  if (hit && Date.now() - hit.ts < DAY_MAP_TTL) return hit.map
  const list = (await fotmob.getMatchesByDate(dateISO.replace(/-/g, ''))) || []
  const map = new Map()
  for (const m of list) {
    if (!m.id || !m.home || !m.away) continue
    map.set(joinKey(dateISO, m.home, m.away), String(m.id))
  }
  _dayMaps.set(dateISO, { ts: Date.now(), map })
  return map
}

const UPDATE_SQL = `
  UPDATE matches SET
    fotmob_id      = COALESCE(?, fotmob_id),
    home_xg        = COALESCE(?, home_xg),
    away_xg        = COALESCE(?, away_xg),
    corners_home   = COALESCE(?, corners_home),
    corners_away   = COALESCE(?, corners_away),
    shots_home     = COALESCE(?, shots_home),
    shots_away     = COALESCE(?, shots_away),
    possession_home= COALESCE(?, possession_home),
    possession_away= COALESCE(?, possession_away)
  WHERE id = ?`

/**
 * @param {object} db better-sqlite3
 * @param {{limit?:number, write?:boolean, log?:object}} opts
 * @returns {Promise<{scanned,matched,written,skippedNoId,errors}>}
 */
async function processFinishedMatches(db, { limit = 200, write = false, log = null } = {}) {
  const lg = log || logger
  const fotmob = require('./fotmobService')
  const rows = db
    .prepare(
      `SELECT id, timestamp, homeTeam, awayTeam, fotmob_id, home_xg, corners_home
       FROM matches
       WHERE status='finished' AND scoreHome IS NOT NULL
         AND (home_xg IS NULL OR corners_home IS NULL)
       ORDER BY last_updated DESC
       LIMIT ?`
    )
    .all(limit)

  const stats = { scanned: rows.length, matched: 0, written: 0, skippedNoId: 0, errors: 0 }
  if (rows.length === 0) {
    lg.info('[FOTMOB-STATS] Rien a traiter (xG/corners deja presents ou aucun finished).')
    return stats
  }

  const upd = db.prepare(UPDATE_SQL)
  for (const r of rows) {
    try {
      let fid = r.fotmob_id
      const date = normDate(r.timestamp)
      if (!fid) {
        if (!date || !r.homeTeam || !r.awayTeam) {
          stats.skippedNoId++
          continue
        }
        const map = await _dayMap(fotmob, date)
        fid = map.get(joinKey(date, r.homeTeam, r.awayTeam))
      }
      if (!fid) {
        stats.skippedNoId++
        continue
      }
      const s = await fotmob.getMatchStats(fid)
      if (!s || (s.xg_home == null && s.corners_home == null && s.xg_away == null && s.corners_away == null)) {
        stats.skippedNoId++
        continue
      }
      stats.matched++
      const args = [
        fid,
        s.xg_home,
        s.xg_away,
        s.corners_home,
        s.corners_away,
        s.shots_home,
        s.shots_away,
        s.possession_home,
        s.possession_away,
        r.id,
      ]
      if (write) {
        upd.run(...args)
        stats.written++
      }
      await sleep(REQUEST_GAP)
    } catch (e) {
      stats.errors++
      lg.warn(`[FOTMOB-STATS] ${r.id} ko : ${e.message}`)
    }
  }
  lg.info(
    `[FOTMOB-STATS] ${write ? 'WRITE' : 'DRY-RUN'} scanned=${stats.scanned} matched=${stats.matched} written=${stats.written} noId=${stats.skippedNoId} err=${stats.errors}`
  )
  return stats
}

module.exports = { processFinishedMatches, _dayMap, _clearDayMap, UPDATE_SQL }
