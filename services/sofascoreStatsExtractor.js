/**
 * sofascoreStatsExtractor.js
 * ─────────────────────────────────────────────────────────────────
 * Extrait les stats de match Sofascore pour les matchs terminés
 * (status=finished) et écrit dans la table `matches` :
 *   - ht_score_home, ht_score_away   (mi-temps via /incidents)
 *   - corners_home, corners_away     (FT via /statistics, COALESCE = ne pas écraser)
 *   - corners_ht_home, corners_ht_away (HT via /statistics)
 *
 * Idempotent : n'écrit que si la valeur courante est NULL.
 *
 * Endpoints utilisés :
 *   GET /event/{id}/incidents     -> score au moment de la MT (event text=HT)
 *   GET /event/{id}/statistics    -> "Corner kicks" dans le groupe "Match overview"
 *
 * Nécessite l'import `getRandomUserAgent` de SofascoreScraping/src/apiClient.
 * ⚠️ Important : Sofascore bloque les requêtes non-impersonnifiées (HTTP 403).
 *    Si apiClient n'est pas disponible, on log un warning et on skip.
 */
const path = require('path')
const logger = require('../core/logger')

const SOFA_API = 'https://www.sofascore.com/api/v1'
const SOFA_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.sofascore.com/',
  Origin: 'https://www.sofascore.com',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
}

let getRandomUserAgent = null
try {
  getRandomUserAgent = require('../SofascoreScraping/src/apiClient').getRandomUserAgent
} catch (e) {
  logger.warn('[SofascoreStatsExtractor] apiClient not available — fetches will fail with 403')
}

function _headers() {
  return {
    ...SOFA_HEADERS,
    'User-Agent': getRandomUserAgent ? getRandomUserAgent() : 'Mozilla/5.0',
  }
}

async function _apiGet(p) {
  if (!getRandomUserAgent) return null
  try {
    const r = await fetch(`${SOFA_API}${p}`, { headers: _headers() })
    if (!r.ok) return null
    return await r.json()
  } catch (e) {
    logger.warn(`[SofascoreStatsExtractor] ${p} failed: ${e.message}`)
    return null
  }
}

function _htScoreFromIncidents(incs) {
  if (!Array.isArray(incs)) return [null, null]
  for (const it of incs) {
    if ((it.text || '').trim().toUpperCase() === 'HT' && it.incidentType === 'period') {
      const h = it.homeScore
      const a = it.awayScore
      if (h != null && a != null) return [Number(h), Number(a)]
    }
  }
  return [null, null]
}

function _cornersFromStatistics(stats, period) {
  if (!stats || !Array.isArray(stats.statistics)) return [null, null]
  for (const block of stats.statistics) {
    if (block.period !== period) continue
    for (const grp of block.groups || []) {
      for (const it of grp.statisticsItems || []) {
        if ((it.name || '').toLowerCase() === 'corner kicks') {
          const h = it.home
          const a = it.away
          if (h != null && a != null) return [Number(h), Number(a)]
        }
      }
    }
  }
  return [null, null]
}

/**
 * Fetch HT score + corners for a single event.
 * Returns { ht_h, ht_a, c_ft_h, c_ft_a, c_ht_h, c_ht_a } — any field may be null.
 */
async function fetchEventStats(eventId) {
  const [incs, stats] = await Promise.all([
    _apiGet(`/event/${eventId}/incidents`),
    _apiGet(`/event/${eventId}/statistics`),
  ])
  const [ht_h, ht_a] = _htScoreFromIncidents(incs?.incidents || [])
  const [c_ft_h, c_ft_a] = _cornersFromStatistics(stats, 'ALL')
  const [c_ht_h, c_ht_a] = _cornersFromStatistics(stats, '1ST')
  return { ht_h, ht_a, c_ft_h, c_ft_a, c_ht_h, c_ht_a }
}

/**
 * Process all finished matches in the DB that are missing HT score.
 * Uses the better-sqlite3 db handle passed in (or opens a new one).
 * Returns { processed, htWritten, cornersFtWritten, cornersHtWritten, skipped, errors }.
 */
async function processFinishedMatches(db, { limit = 100, log = null } = {}) {
  const lg = log || logger
  let processed = 0
  let htWritten = 0
  let cornersFtWritten = 0
  let cornersHtWritten = 0
  let skipped = 0
  let errors = 0

  const rows = db
    .prepare(
      `SELECT id, home_team_id FROM matches
        WHERE status = 'finished'
          AND home_team_id IS NOT NULL
          AND (ht_score_home IS NULL OR corners_home IS NULL)
        ORDER BY last_updated DESC
        LIMIT ?`
    )
    .all(limit)

  if (rows.length === 0) {
    lg.info('[SofascoreStatsExtractor] No finished matches to process.')
    return { processed, htWritten, cornersFtWritten, cornersHtWritten, skipped, errors }
  }

  lg.info(`[SofascoreStatsExtractor] Processing ${rows.length} finished matches…`)

  for (const row of rows) {
    const sofascoreId = String(row.home_team_id)
    if (!/^\d+$/.test(sofascoreId)) {
      skipped++
      continue
    }
    processed++
    try {
      const r = await fetchEventStats(sofascoreId)
      const updates = []
      const params = []
      if (r.ht_h != null) {
        updates.push('ht_score_home = ?', 'ht_score_away = ?')
        params.push(r.ht_h, r.ht_a)
        htWritten++
      }
      if (r.c_ft_h != null) {
        updates.push('corners_home = COALESCE(corners_home, ?)', 'corners_away = COALESCE(corners_away, ?)')
        params.push(r.c_ft_h, r.c_ft_a)
        cornersFtWritten++
      }
      if (r.c_ht_h != null) {
        updates.push('corners_ht_home = ?', 'corners_ht_away = ?')
        params.push(r.c_ht_h, r.c_ht_a)
        cornersHtWritten++
      }
      if (updates.length) {
        params.push(row.id)
        db.prepare(`UPDATE matches SET ${updates.join(', ')} WHERE id = ?`).run(...params)
      }
    } catch (e) {
      errors++
      lg.warn(`[SofascoreStatsExtractor] event ${sofascoreId} failed: ${e.message}`)
    }
    // Respect rate limit (Sofascore: ~5 req/s safe)
    await new Promise((res) => setTimeout(res, 220))
  }

  lg.info(
    `[SofascoreStatsExtractor] Done: processed=${processed} ht=${htWritten} c_ft=${cornersFtWritten} c_ht=${cornersHtWritten} skipped=${skipped} errors=${errors}`
  )
  return { processed, htWritten, cornersFtWritten, cornersHtWritten, skipped, errors }
}

module.exports = {
  fetchEventStats,
  processFinishedMatches,
  _htScoreFromIncidents,
  _cornersFromStatistics,
}
