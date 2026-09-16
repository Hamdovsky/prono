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
const { mergeOddsIntoFullData } = require('../core/archiveMerge')
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

  // E57 : la passe historique tourne MEME si `matches` est vide -> c'est le point
  // fixe ou vivent les matchs termines (l'archivage les supprime de `matches` avant
  // que ce cron ne les voie : course E56). On traite donc les deux tables.
  if (rows.length > 0) {
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
  }

  const hist = await _processHistorical(db, { limit, write, log: lg, fotmob })
  stats.historical = hist

  lg.info(
    `[FOTMOB-STATS] ${write ? 'WRITE' : 'DRY-RUN'} scanned=${stats.scanned} matched=${stats.matched} written=${stats.written} noId=${stats.skippedNoId} err=${stats.errors} | hist scanned=${hist.scanned} matched=${hist.matched} written=${hist.written}`
  )
  return stats
}

// E57 : enrichit les lignes DEJA archivees (historical_matches). Les stats sont
// stockees dans fullData (cle home_xg/... ; PAS de colonnes) -> on relit/merge/ecrit
// le JSON via mergeOddsIntoFullData (COALESCE-safe : n'ecrase jamais l'existant).
async function _processHistorical(db, { limit = 200, write = false, log = null, fotmob = null } = {}) {
  const lg = log || logger
  const svc = fotmob || require('./fotmobService')
  const stats = { scanned: 0, matched: 0, written: 0 }
  let rows = []
  try {
    rows = db
      .prepare(
        `SELECT id, timestamp, homeTeam, awayTeam, fullData
         FROM historical_matches
         WHERE scoreHome IS NOT NULL
           AND json_extract(COALESCE(fullData,'{}'), '$.home_xg') IS NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit)
  } catch (_) {
    return stats
  }
  stats.scanned = rows.length
  if (rows.length === 0) return stats

  const upd = db.prepare('UPDATE historical_matches SET fullData=? WHERE id=?')
  for (const r of rows) {
    try {
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
        const map = await _dayMap(svc, date)
        fid = map.get(key)
      }
      if (!fid) continue
      const s = await svc.getMatchStats(fid)
      if (!s || (s.xg_home == null && s.corners_home == null)) continue
      stats.matched++
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
      if (!merged.fotmob_id) merged.fotmob_id = fid
      if (write) {
        upd.run(JSON.stringify(merged), r.id)
        stats.written++
      }
      await sleep(REQUEST_GAP)
    } catch (e) {
      lg.warn(`[FOTMOB-STATS] hist ${r.id} ko : ${e.message}`)
    }
  }
  return stats
}

module.exports = { processFinishedMatches, _processHistorical, _dayMap, _clearDayMap, UPDATE_SQL }
