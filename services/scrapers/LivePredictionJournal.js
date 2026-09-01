/**
 * LivePredictionJournal — journal de résultats pour le calibrage (point 3).
 *
 * Objectif : enregistrer chaque prédiction LIVE O/U 2.5 (et le contexte de
 * décision) puis, une fois le score final connu, enregistrer l'issue afin de
 * mesurer le taux de réussite réel par tranche de confiance (« quel % de mes
 * OVER 70% passent ? ») et recalibrer les seuils.
 *
 * Stockage : deux JSONL append-only (aucune dépendance DB).
 *   - data/live_prediction_journal.jsonl   : snapshots de prédictions
 *   - data/live_prediction_results.jsonl   : issues résolues
 *
 * Déduplication : une prédiction est enregistrée au plus une fois par
 * « fenêtre » (~20 min) par eventId pour éviter le bruit des polls 15s tout
 * en capturant l'évolution du score en direct.
 */
const path = require('path')
const fs = require('fs')

const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const JOURNAL = path.join(DATA_DIR, 'live_prediction_journal.jsonl')
const RESULTS = path.join(DATA_DIR, 'live_prediction_results.jsonl')

const WINDOW_MS = 20 * 60 * 1000 // 20 min

function readLines(file) {
  try {
    if (!fs.existsSync(file)) return []
    const out = []
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t))
      } catch (_) {
        /* ligne corrompue → ignorée */
      }
    }
    return out
  } catch (_) {
    return []
  }
}

function appendLine(file, obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
  } catch (_) {
    /* jamais d'exception vers l'appelant */
  }
}

function computeWindowStart(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS
}

/**
 * Extrait une prédiction « décidable » pour le calibrage O/U 2.5.
 * @returns {Object|null}
 */
function extractPrediction(ev) {
  const p = ev && ev.pred
  if (!p || p.over25 == null) return null
  return {
    over25: Number(p.over25),
    under25: Number(p.under25) != null ? Number(p.under25) : Math.round((1 - Number(p.over25)) * 1000) / 1000,
    pick: p.ou_pick || (Number(p.over25) >= 0.55 ? 'OVER 2.5' : Number(p.over25) <= 0.45 ? 'UNDER 2.5' : 'PUSH'),
    totalXg: p.total_xg_live != null ? Number(p.total_xg_live) : null,
    xgsrc: p.xgsrc || null,
    homeXg: p.home_xg_live != null ? Number(p.home_xg_live) : null,
    awayXg: p.away_xg_live != null ? Number(p.away_xg_live) : null,
    value: p.value || null,
    calibFloor: !!p.calib_floor,
    predScore: p.pred_score || null,
  }
}

/**
 * Enregistre les snapshots de prédiction pour les events live.
 * Non bloquant (n'empêche jamais la réponse d'arriver).
 * @param {Array} events
 */
function recordEvents(events) {
  try {
    if (!Array.isArray(events)) return
    const existing = readLines(JOURNAL)
    const seen = new Set(existing.map((r) => r.recordId))
    const now = Date.now()
    const winStart = computeWindowStart(now)
    for (const ev of events) {
      const pred = extractPrediction(ev)
      if (!pred) continue
      const recordId = `${ev.id}-${winStart}`
      if (seen.has(recordId)) continue
      seen.add(recordId)
      appendLine(JOURNAL, {
        recordId,
        eventId: String(ev.id),
        ts: now,
        minute: ev.liveMinute != null ? ev.liveMinute : ev.minute,
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        tournament: ev.tournament || null,
        homeScore: ev.homeScore,
        awayScore: ev.awayScore,
        statusType: ev.statusType || null,
        ...pred,
        resolved: false,
      })
    }
  } catch (_) {
    /* journal jamais bloquant */
  }
}

/**
 * Résout une prédiction avec le score final : calcule si la prédiction O/U 2.5
 * a été correcte. Appliqué à toutes les lignes non résolues du même eventId.
 * @param {string|number} eventId
 * @param {number} finalHome
 * @param {number} finalAway
 */
function resolve(eventId, finalHome, finalAway) {
  const id = String(eventId)
  const lines = readLines(JOURNAL)
  const results = readLines(RESULTS)
  const done = new Set(results.map((r) => r.recordId))
  const total = Number(finalHome) + Number(finalAway)
  const finalOver = total > 2.5 ? 1 : 0
  const changed = []
  for (const r of lines) {
    if (r.eventId !== id || r.resolved) continue
    if (done.has(r.recordId)) continue
    const outcome = {
      recordId: r.recordId,
      eventId: id,
      ts: Date.now(),
      finalHome: Number(finalHome),
      finalAway: Number(finalAway),
      finalTotal: total,
      finalOver,
      predictedOver: r.over25,
      pick: r.pick,
      pickCorrect: r.pick.includes('OVER') ? finalOver === 1 : r.pick.includes('UNDER') ? finalOver === 0 : null,
      overBetWon: r.over25 >= 0.55 ? finalOver === 1 : null,
      underBetWon: r.under25 >= 0.55 ? finalOver === 0 : null,
    }
    done.add(r.recordId)
    appendLine(RESULTS, outcome)
    changed.push(outcome)
    // marquer résolu dans le journal (réécriture amortie, fichiers petits)
  }
  if (changed.length) {
    for (const r of lines) {
      if (r.eventId === id) r.resolved = true
    }
    try {
      fs.writeFileSync(JOURNAL, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
    } catch (_) {
      /* ignore */
    }
  }
  return changed
}

function bucket(prob) {
  if (prob >= 0.75) return '≥75%'
  if (prob >= 0.6) return '60-74%'
  if (prob >= 0.5 && prob < 0.6) return '50-59%'
  if (prob > 0.4 && prob < 0.5) return '40-49%'
  return '<40%'
}

/**
 * Stats de calibrage : taux de réussite par tranche de confiance.
 */
function stats() {
  const results = readLines(RESULTS)
  const byBucket = {}
  const byPick = { 'OVER 2.5': { n: 0, hit: 0 }, 'UNDER 2.5': { n: 0, hit: 0 } }
  for (const r of results) {
    const prob = r.pick.includes('OVER') ? r.predictedOver : r.under25 != null ? 1 - r.predictedOver : r.predictedOver
    const b = bucket(prob)
    if (!byBucket[b]) byBucket[b] = { n: 0, hit: 0 }
    byBucket[b].n++
    if (r.pickCorrect === true) byBucket[b].hit++
    const key = r.pick.includes('OVER') ? 'OVER 2.5' : r.pick.includes('UNDER') ? 'UNDER 2.5' : null
    if (key && byPick[key]) {
      byPick[key].n++
      if (r.pickCorrect === true) byPick[key].hit++
    }
  }
  const totalN = results.length
  const totalHit = results.filter((r) => r.pickCorrect === true).length
  const buckets = Object.keys(byBucket)
    .sort()
    .map((k) => {
      const { n, hit } = byBucket[k]
      return { bucket: k, n, hit, hitRate: n ? Math.round((hit / n) * 100) : null }
    })
  return {
    totalPredictions: totalN,
    resolved: results.length,
    hits: totalHit,
    overallHitRate: totalN ? Math.round((totalHit / totalN) * 100) : null,
    byBucket: buckets,
    byPick: Object.keys(byPick).map((k) => {
      const { n, hit } = byPick[k]
      return { pick: k, n, hit, hitRate: n ? Math.round((hit / n) * 100) : null }
    }),
    journalSnapshot: new Date().toISOString(),
  }
}

module.exports = { recordEvents, resolve, stats, getJournal: () => readLines(JOURNAL), getResults: () => readLines(RESULTS) }
