/**
 * LiveResultResolver — résolution AUTOMATIQUE des scores finaux (calibrage, point 3).
 *
 * Quand une prédiction O/U live a été journalisée puis que le match disparaît du
 * flux live (il s'est terminé), on va chercher son statut + score final auprès de
 * Sofascore (/event/{id}) et on résout l'issue dans le journal -> plus besoin de
 * saisie manuelle. Le taux de réussite réel se met à jour tout seul.
 *
 * Garanties :
 *  - Intervient UNIQUEMENT sur des prédictions non résolues.
 *  - Ne résout JAMAIS un match encore en cours (on saute ceux encore dans le flux live).
 *  - Non bloquant : lancé en fond, jamais en amont de la réponse /flash-odds.
 *  - Throttlé + « running » flag pour ne pas superposer les scans ni marteler l'API.
 */
const Journal = require('./LivePredictionJournal')
const Bypass = require('./SofascoreBypass')

const MIN_SCAN_INTERVAL = 90 * 1000 // au plus 1 scan / 90 s
const SCORE_PLAUSIBLE_MAX = 15 // garde-fou anti-score aberrant

let lastScan = 0
let running = false

/**
 * Certitude de score final : home/away entiers, >= 0, plausibles.
 */
function plausibleScore(h, a) {
  if (h == null || a == null) return false
  const hh = Number(h)
  const aa = Number(a)
  if (!Number.isFinite(hh) || !Number.isFinite(aa)) return false
  if (hh < 0 || aa < 0 || hh > SCORE_PLAUSIBLE_MAX || aa > SCORE_PLAUSIBLE_MAX) return false
  return true
}

/**
 * Résout automatiquement les prédictions dont le match est terminé.
 * @returns {Promise<{scanned:number, resolved:number, errors:number}>}
 */
async function autoResolve({ force = false } = {}) {
  if (running) return { scanned: 0, resolved: 0, errors: 0, reason: 'running' }
  const now = Date.now()
  if (!force && now - lastScan < MIN_SCAN_INTERVAL) {
    return { scanned: 0, resolved: 0, errors: 0, reason: 'throttled' }
  }
  running = true
  lastScan = now
  const stats = { scanned: 0, resolved: 0, errors: 0 }
  try {
    const journal = Journal.getJournal()
    const pending = journal.filter((r) => !r.resolved)
    if (!pending.length) return stats

    // Ids encore en direct (on ne résout pas un match en cours)
    const liveIds = new Set()
    try {
      const live = await Bypass.getLiveEvents()
      live.forEach((e) => liveIds.add(String(e.id)))
    } catch (_) {
      /* on continue sans la liste live (le statut serie de garde de secours) */
    }

    const workers = []
    const pool = (async (list, concurrency) => {
      const results = []
      let i = 0
      const next = async () => {
        if (i >= list.length) return
        const r = list[i++]
        results.push(await process(r, liveIds, stats))
        await next()
      }
      const start = Math.min(concurrency, list.length)
      const arr = []
      for (let k = 0; k < start; k++) arr.push(next())
      await Promise.all(arr)
      return results
    })(pending, 3)

    await pool
  } catch (_) {
    /* ignore */
  } finally {
    running = false
  }
  return stats
}

async function process(record, liveIds, stats) {
  const id = String(record.eventId)
  try {
    // Encore en direct => on ne résout pas maintenant.
    if (liveIds.has(id)) return { eventId: id, skipped: true }
    const st = await Bypass.getEventStatus(id)
    if (!st || !st.finished) return { eventId: id, skipped: true }
    if (!plausibleScore(st.home, st.away)) return { eventId: id, skipped: true }
    stats.scanned++
    const resolved = Journal.resolve(id, Number(st.home), Number(st.away))
    if (resolved.length) stats.resolved += resolved.length
    return { eventId: id, resolved: resolved.length }
  } catch (_) {
    stats.errors++
    return { eventId: id, error: true }
  }
}

module.exports = { autoResolve }
