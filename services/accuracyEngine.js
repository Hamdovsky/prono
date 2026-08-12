/**
 * accuracyEngine.js — Métrique de performance UNIFIÉE
 *
 * Source unique de vérité pour l'exactitude des prédictions du moteur.
 * Remplace les deux mesures divergentes (promosport_accuracy_trend.json —
 * backfill ML dégénéré « tout-X » — et retro_accuracy_report.json — oracle
 * du favori avec look-ahead massif). Voir CHANGELOG_AUDIT.md ÉTAPE 1.
 *
 * Principes :
 *  - Périmètre : matchs terminés (scoreHome/scoreAway renseignés), qu'ils soient
 *    dans `matches` (statut FT) ou `historical_matches` (archivés).
 *  - Snapshot au temps T : n'utilise QUE la prédiction et la confiance telles
 *    qu'enregistrées à l'origine (colonne prediction / fullData archivée).
 *    AUCUN recalcul avec des données plus fraîches, aucun backfill rétroactif.
 *  - Whitelist stricte : 1, X, 2, 1X, X2, 12, O<seuil>, U<seuil>. Tout autre
 *    label (RISKY BET, PENDING, …) est EXCLU du calcul et compté dans
 *    `excludedLabels` — jamais ignoré silencieusement.
 *  - Deux vues avec le même code : rolling (7j/30j) et cumulé → seul le filtre
 *    de fenêtre change.
 *  - Métriques : accuracy brute, Brier score, log-loss, courbe de calibration
 *    par bande de 10 %, accuracy par ligue.
 */

const FT_STATUSES = ['FT', 'finished', 'Finished', 'Ended']
const VALID_1X2 = new Set(['1', 'X', '2', '1X', 'X2', '12'])
const OU_RE = /^[OU](\d+(?:\.\d+)?)$/

let _db = null
function getDb(injected) {
  if (injected) return injected
  if (_db) return _db
  _db = require('../core/database').db
  return _db
}

function normalizeLabel(raw) {
  if (raw == null) return null
  const s = String(raw).toUpperCase().trim().replace(/\s+/g, '')
  if (s === '') return null
  return s
}

function is1x2(label) {
  return VALID_1X2.has(label)
}

function isOU(label) {
  return OU_RE.test(label)
}

function isAllowed(label, marketFilter) {
  if (is1x2(label)) return marketFilter === 'all' || marketFilter === '1x2'
  if (isOU(label)) return marketFilter === 'all' || marketFilter === 'over_under'
  return false
}

function actualOutcome(scoreHome, scoreAway) {
  if (scoreHome == null || scoreAway == null) return null
  if (scoreHome > scoreAway) return '1'
  if (scoreHome < scoreAway) return '2'
  return 'X'
}

/**
 * Une prédiction est correcte si :
 *  - 1X2 simple : pick === résultat
 *  - 1X2 double chance (1X/X2/12) : le résultat appartient au pick
 *  - O/U : total de buts au-dessus (O) ou en dessous (U) du seuil
 */
function isCorrect(pick, actual, scoreHome, scoreAway) {
  if (is1x2(pick)) {
    if (pick.length === 1) return pick === actual
    return pick.includes(actual)
  }
  if (isOU(pick)) {
    if (scoreHome == null || scoreAway == null) return null
    const total = scoreHome + scoreAway
    const threshold = parseFloat(pick.slice(1))
    return pick[0] === 'O' ? total > threshold : total < threshold
  }
  return null
}

/**
 * Probabilité de l'issue prédite (pour la calibration), en % (0-100).
 * Retourne null si aucune probabilité exploitable enregistrée au temps T.
 */
function pickProbability(pick, probs) {
  if (!probs) return null
  const { p1, px, p2 } = probs
  if (p1 == null || px == null || p2 == null) return null
  if (is1x2(pick)) {
    let prob
    if (pick === '1') prob = p1
    else if (pick === 'X') prob = px
    else if (pick === '2') prob = p2
    else if (pick === '1X') prob = p1 + px
    else if (pick === 'X2') prob = px + p2
    else if (pick === '12') prob = p1 + p2
    else prob = Math.max(p1, px, p2)
    return prob * 100
  }
  if (isOU(pick)) {
    return Math.max(p1, px, p2) * 100 // proxy : probs 1X2 disponibles seulement
  }
  return null
}

function computeLogLoss(p1, px, p2, actual) {
  if (p1 == null || px == null || p2 == null || !actual) return null
  const eps = 1e-12
  const q = actual === '1' ? p1 : actual === 'X' ? px : actual === '2' ? p2 : null
  if (q == null || q <= 0) return null
  return -Math.log(Math.max(q, eps))
}

function computeBrier(p1, px, p2, actual) {
  if (p1 == null || px == null || p2 == null || !actual) return null
  const truth = [0, 0, 0]
  if (actual === '1') truth[0] = 1
  else if (actual === 'X') truth[1] = 1
  else if (actual === '2') truth[2] = 1
  else return null
  const pred = [p1, px, p2]
  return pred.reduce((acc, v, i) => acc + (v - truth[i]) * (v - truth[i]), 0)
}

/**
 * Extraction de la prédiction depuis une ligne `matches` (colonnes directes).
 */
function recordFromMatches(r, options) {
  const pick = normalizeLabel(r.prediction)
  const actual = actualOutcome(r.scoreHome, r.scoreAway)
  const confidence = r.confidence != null ? Number(r.confidence) : null
  const probs =
    r.home_win_probability != null || r.draw_probability != null || r.away_win_probability != null
      ? {
          p1: r.home_win_probability != null ? r.home_win_probability / 100 : null,
          px: r.draw_probability != null ? r.draw_probability / 100 : null,
          p2: r.away_win_probability != null ? r.away_win_probability / 100 : null,
        }
      : null
  return buildRecord({
    matchId: r.id,
    league: r.league || 'Unknown',
    pick,
    actual,
    scoreHome: r.scoreHome,
    scoreAway: r.scoreAway,
    confidence,
    probs,
    source: 'matches',
    ts: r.startTimestamp || parseDateTs(r.timestamp),
  }, options)
}

/**
 * Extraction de la prédiction depuis une ligne `historical_matches`.
 * Les colonnes prediction/confidence n'existent pas : elles sont dans fullData
 * (archivée telle quelle au moment du pronostic → snapshot au temps T).
 */
function recordFromHistorical(r, options) {
  let fd = {}
  try {
    fd = JSON.parse(r.fullData || '{}')
  } catch {
    fd = {}
  }

  const pick = normalizeLabel(
    fd.prediction ?? fd.quant?.main_pick ?? fd.quant?.all_picks?.[0]?.val ?? null
  )
  const actual = actualOutcome(r.scoreHome, r.scoreAway)
  const confidence = fd.confidence != null ? Number(fd.confidence) : fd.quant?.confidence ?? null

  const qmr = fd.quant?.markets?.match_result
  const p1 =
    fd.home_win_probability != null
      ? fd.home_win_probability / 100
      : qmr?.['1']?.prob != null
        ? qmr['1'].prob
        : null
  const px =
    fd.draw_probability != null
      ? fd.draw_probability / 100
      : qmr?.X?.prob != null
        ? qmr.X.prob
        : null
  const p2 =
    fd.away_win_probability != null
      ? fd.away_win_probability / 100
      : qmr?.['2']?.prob != null
        ? qmr['2'].prob
        : null
  const probs = p1 != null || px != null || p2 != null ? { p1, px, p2 } : null

  return buildRecord({
    matchId: r.id,
    league: r.league || 'Unknown',
    pick,
    actual,
    scoreHome: r.scoreHome,
    scoreAway: r.scoreAway,
    confidence,
    probs,
    source: 'historical_matches',
    ts: parseDateTs(r.timestamp) || parseDateTs(r.archived_at),
  }, options)
}

function parseDateTs(v) {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isNaN(n)) return n
  const d = Date.parse(v)
  return Number.isNaN(d) ? null : d
}

function buildRecord(base, options) {
  const { from, to, marketFilter } = options
  if (base.pick == null) return null
  if (!isAllowed(base.pick, marketFilter)) return null
  if (base.ts != null && from != null && base.ts < from) return null
  if (base.ts != null && to != null && base.ts > to) return null
  // Le résultat doit être définitif
  if (base.actual == null) return null
  return base
}

function calibrationBands(pickProb) {
  if (pickProb == null) return null
  const clamped = Math.max(0, Math.min(100, pickProb))
  const idx = Math.min(9, Math.floor(clamped / 10))
  return { min: idx * 10, max: Math.min(100, (idx + 1) * 10), band: `${idx * 10}-${Math.min(100, (idx + 1) * 10)}` }
}

/**
 * Métrique unifiée.
 *
 * @param {object} [options]
 * @param {number|string} [options.from]  — borne basse (ts ms ou date ISO)
 * @param {number|string} [options.to]    — borne haute (ts ms ou date ISO)
 * @param {'all'|'1x2'|'over_under'} [options.marketFilter='all']
 * @param {object} [options.db]           — injectable pour les tests
 * @returns {object} rapport structuré (toujours valide, jamais de NaN)
 */
function computeAccuracy(options = {}) {
  const from = options.from != null ? parseDateTs(options.from) : null
  const to = options.to != null ? parseDateTs(options.to) : null
  const marketFilter = options.marketFilter || 'all'
  const db = getDb(options.db)

  const records = []
  const excludedLabels = {}
  let noPredictionCount = 0
  let pendingCount = 0
  let finishedCount = 0

  try {
    const liveRows = db
      .prepare(`SELECT * FROM matches WHERE status IN (${FT_STATUSES.map(() => '?').join(',')})`)
      .all(...FT_STATUSES)
    for (const r of liveRows) {
      finishedCount++
      const rec = recordFromMatches(r, { from, to, marketFilter })
      if (rec) records.push(rec)
      else {
        const pick = normalizeLabel(r.prediction)
        if (pick === 'PENDING') {
          pendingCount++
        } else if (pick && !isAllowed(pick, marketFilter)) {
          excludedLabels[pick] = (excludedLabels[pick] || 0) + 1
        } else if (!pick) {
          noPredictionCount++
        }
      }
    }
  } catch {
    /* matches absente dans certains contextes de test — non bloquant */
  }

  let histRows = []
  try {
    histRows = db.prepare(`SELECT * FROM historical_matches`).all()
  } catch {
    histRows = []
  }
  for (const r of histRows) {
    finishedCount++
    const rec = recordFromHistorical(r, { from, to, marketFilter })
    if (rec) records.push(rec)
    else {
      let fd = {}
      try {
        fd = JSON.parse(r.fullData || '{}')
      } catch {}
      if (fd.verdict === 'PENDING' || fd.risk_label === 'PENDING') {
        pendingCount++
      } else {
        const pick = normalizeLabel(fd.prediction ?? fd.quant?.main_pick ?? fd.quant?.all_picks?.[0]?.val ?? null)
        if (pick && !isAllowed(pick, marketFilter)) {
          excludedLabels[pick] = (excludedLabels[pick] || 0) + 1
        } else if (!pick) {
          noPredictionCount++
        }
      }
    }
  }

  const N = records.length
  let evaluated = 0
  let correct = 0
  let pushCount = 0
  let logLossSum = 0
  let logLossCount = 0
  let brierSum = 0
  let brierCount = 0
  const calib = {}
  const leagueMap = {}

  for (const rec of records) {
    const ok = isCorrect(rec.pick, rec.actual, rec.scoreHome, rec.scoreAway)
    if (ok === null) continue
    evaluated++
    if (ok) correct++
    else if (isOU(rec.pick) && rec.scoreHome + rec.scoreAway === parseFloat(rec.pick.slice(1))) {
      pushCount++ // O/U exactement sur le seuil → push
    }

    const ll = computeLogLoss(rec.probs?.p1, rec.probs?.px, rec.probs?.p2, rec.actual)
    if (ll != null) {
      logLossSum += ll
      logLossCount++
    }
    const br = computeBrier(rec.probs?.p1, rec.probs?.px, rec.probs?.p2, rec.actual)
    if (br != null) {
      brierSum += br
      brierCount++
    }

    const pickProb = pickProbability(rec.pick, rec.probs) ?? rec.confidence
    if (pickProb != null) {
      const band = calibrationBands(pickProb)
      if (band) {
        if (!calib[band.band]) calib[band.band] = { count: 0, correct: 0 }
        calib[band.band].count++
        if (ok) calib[band.band].correct++
      }
    }

    const lg = rec.league || 'Unknown'
    if (!leagueMap[lg]) leagueMap[lg] = { count: 0, correct: 0 }
    leagueMap[lg].count++
    if (ok) leagueMap[lg].correct++
  }

  // L'accuracy est calculée sur les matchs évalués hors push (traitement standard :
  // un push O/U est remboursé, ni gagné ni perdu).
  const denominator = Math.max(1, evaluated - pushCount)
  const accuracy = evaluated > 0 ? (correct / denominator) * 100 : null
  const accuracyPct = accuracy === null ? null : accuracy.toFixed(1) + '%'

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      from: options.from ?? null,
      to: options.to ?? null,
      marketFilter,
      sources: { matches: FT_STATUSES.join('|'), historical_matches: true },
    },
    empty: N === 0,
    summary: {
      total: N,
      evaluated,
      correct,
      pushCount,
      finishedCount,
      noPredictionCount,
      pendingCount,
      accuracy: accuracy === null ? null : correct / denominator,
      accuracyPct,
      logLoss: logLossCount > 0 ? +((logLossSum / logLossCount) * 100).toFixed(4) : null,
      brierScore: brierCount > 0 ? +((brierSum / brierCount) * 1000).toFixed(4) : null,
    },
    calibrationCurve: Object.entries(calib)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([band, d]) => ({
        band,
        count: d.count,
        correct: d.correct,
        accuracy: +((d.correct / d.count) * 100).toFixed(1),
      })),
    byLeague: Object.entries(leagueMap)
      .map(([league, d]) => ({
        league,
        total: d.count,
        correct: d.correct,
        accuracy: +((d.correct / d.count) * 100).toFixed(1),
      }))
      .sort((a, b) => b.total - a.total),
    excludedLabels: Object.entries(excludedLabels).map(([label, count]) => ({
      label,
      reason: `Label hors whitelist (valides: 1, X, 2, 1X, X2, 12, O/U+seuil) — exclu du calcul d'accuracy`,
      count,
    })),
  }
}

module.exports = { computeAccuracy }
