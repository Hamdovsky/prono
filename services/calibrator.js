/**
 * calibrator.js — Recalibrage EMPIRIQUE des probabilités du modèle.
 *
 * Problème mesuré (données réelles, bets + historical_matches) : les
 * probabilités brutes du modèle sont mal calibrées et de manière différente
 * selon le marché :
 *   - 1X2 pur : réussi ~39 % en réel alors que le modèle annonce 50-70 %
 *     (surconfiance massive).
 *   - Double Chance : correct ~71 % dans la bande 70-79 %, mais ~63 %
 *     dans la bande 80-89 % (le modèle est TROP confiant au-delà de 80).
 *   - O/U (O0.5...) : réussi ~94 % dans la bande 70-79 % (sous-confiance).
 *
 * Ce module construit, à partir des paris réglés joints aux matchs
 * historiques, une courbe bande→taux réel PAR MARCHÉ, lisse par régression
 * isotonique (PAVA pondéré) avec retrait bayésien vers le taux moyen du
 * marché pour les bandes à faible échantillon, puis l'applique au moment du
 * pick (topPicksEngine, Plan Pro) — avant edge / EV / Kelly / gardes.
 *
 * Marchés couverts : '1X2', 'DC' (1X/X2/12), 'OU' (O0.5/U...). Un marché
 * sans données revient à l'identité (probabilité inchangée).
 */

const logger = require('../core/logger')

// ── Constantes ───────────────────────────────────────────────────
const MIN_BAND_SAMPLES = 20 // retrait bayésien : poids de la moyenne du marché
const TTL_MS = 6 * 3600 * 1000 // refonte de la courbe toutes les 6 h
const MAX_CALIBRATED = 90 // plafond de la proba calibrée
const PICK_MARKET = { '1': '1X2', '2': '1X2', X: '1X2', '1X': 'DC', X2: 'DC', '12': 'DC' }

let _curve = null
let _builtAt = 0

// ── Courbe ───────────────────────────────────────────────────────
function pickProb(pick, mr) {
  const s = String(pick || '').toUpperCase().trim()
  if (s === '1' || s === '2' || s === 'X') {
    const v = mr[s] && mr[s].prob
    return v != null ? v * 100 : null
  }
  if (s === '1X' || s === 'X2' || s === '12') {
    let p = 0
    for (const k of s) {
      const v = mr[k] && mr[k].prob
      if (v == null) return null
      p += v
    }
    return p * 100
  }
  return null
}

// Régression isotonique (PAVA relaxé) : rend la séquence non décroissante.
function pavaIsotonic(items) {
  const out = items.map((it) => ({ ...it }))
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].rate > out[i + 1].rate) {
        const w = out[i].n + out[i + 1].n
        const wRate = (out[i].rate * out[i].n + out[i + 1].rate * out[i + 1].n) / Math.max(w, 1)
        out[i].rate = wRate
        out[i].n = w
        out[i + 1].rate = wRate
        out[i + 1].n = w
        changed = true
      }
    }
  }
  return out
}

function buildCurve(db, minIsoTs) {
  const byMarket = {}
  // Audit gel cascade (2026-08-24) : la courbe ne se construit QUE sur des
  // prédictions émises après le gel Python (fullData.quant propre). On filtre
  // sur h.timestamp (date-match/prédiction), PAS sur b.created_at (le pari peut
  // être récent alors que la prédiction pointée est de l'ère contaminée).
  const rows = db
    .prepare(
      `SELECT b.pick, b.result, h.fullData
       FROM bets b JOIN historical_matches h
         ON (LOWER(b.match_label) LIKE '%' || LOWER(h.homeTeam) || '%'
             AND LOWER(b.match_label) LIKE '%' || LOWER(h.awayTeam) || '%')
       WHERE b.result IN ('won','lost') AND h.timestamp >= ?`
    )
    .all(minIsoTs || '1970-01-01')

  for (const r of rows) {
    const pick = String(r.pick || '').toUpperCase().trim()
    const market = PICK_MARKET[pick]
    if (!market) continue
    let fd = {}
    try {
      fd = JSON.parse(r.fullData || '{}')
    } catch {
      fd = {}
    }
    const q = (fd.quant && typeof fd.quant === 'object') ? fd.quant : {}
    const mr = (q.markets && q.markets.match_result) || {}
    if (!mr['1'] || !mr['2'] || !mr['X']) continue
    const prob = pickProb(pick, mr)
    if (prob == null || prob <= 0 || prob >= 100) continue
    const acc = byMarket[market] || (byMarket[market] = { bands: new Map(), n: 0, w: 0 })
    acc.n++
    if (r.result === 'won') acc.w++
    const idx = Math.min(9, Math.floor(prob / 10))
    const b = acc.bands.get(idx) || { n: 0, w: 0 }
    b.n++
    if (r.result === 'won') b.w++
    acc.bands.set(idx, b)
  }

  const markets = {}
  for (const [market, acc] of Object.entries(byMarket)) {
    const base = acc.n > 0 ? (acc.w / acc.n) * 100 : 33
    const items = []
    for (let i = 0; i < 10; i++) {
      const b = acc.bands.get(i)
      const n = b ? b.n : 0
      const w = b ? b.w : 0
      const rawRate = n > 0 ? (w / n) * 100 : base
      const rate = (rawRate * n + base * MIN_BAND_SAMPLES) / (n + MIN_BAND_SAMPLES)
      items.push({ min: i * 10, max: i * 10 + 10, n, w, rate })
    }
    markets[market] = { bands: pavaIsotonic(items), base, n: acc.n, builtAt: Date.now() }
  }
  return markets
}

// Audit gel cascade (2026-08-24) : la calibration marchés est GELÉE (identité)
// tant que les échantillons propres post-gel sont insuffisants — la courbe
// précédente, construite sur l'ère contaminée, effondrait tout en paliers
// (DC 35%→63.4 = 65%→63.4) et faussait filtre/EV/Kelly des Top Picks.
// Cutoff = déploiement du gel Python (toute quant antérieure a été produite
// par la chaîne déformée). À avancer si le gel est redéployé plus tard.
const CLEAN_CUTOFF_ISO = '2026-08-24T19:00:00.000Z'
const REBUILD_MIN_SAMPLES = 150

function getCurve(force = false) {
  const identity = process.env.MARKET_CALIB_IDENTITY !== 'false'
  if (!force && _curve && Date.now() - _builtAt < TTL_MS) return _curve
  try {
    const db = require('../core/database').db
    if (!db) return _curve || {}
    const markets = buildCurve(db, CLEAN_CUTOFF_ISO)
    const nClean = Object.values(markets).reduce((s, m) => s + m.n, 0)
    if (
      identity &&
      !(nClean >= REBUILD_MIN_SAMPLES && process.env.MARKET_CALIB_AUTO !== 'false')
    ) {
      logger.info(
        `[CALIBRATOR] identité imposée (gel données pré-fix) — échantillon propre: ${nClean}/${REBUILD_MIN_SAMPLES}`
      )
      _curve = {}
      _builtAt = Date.now()
      return _curve
    }
    if (identity) {
      logger.info(
        `[CALIBRATOR] AUTO-UNFREEZE: ${nClean} échantillons propres >= ${REBUILD_MIN_SAMPLES}`
      )
    }
    _curve = markets
    _builtAt = Date.now()
    logger.info(
      `[CALIBRATOR] Courbe recalibrée: ${Object.entries(markets)
        .map(([m, c]) => `${m}(n=${c.n}, base=${Math.round(c.base)}%)`)
        .join(', ')}`
    )
  } catch (e) {
    logger.warn(`[CALIBRATOR] buildCurve échoué (courbe précédente conservée): ${e.message}`)
  }
  return _curve || {}
}

/**
 * Proba calibrée d'un pick. Marché inconnu ou sans données → identité.
 */
function calibrateProb(prob, market) {
  const p = Number(prob) || 0
  if (p <= 0 || p >= 100) return p
  const m = getCurve()[market]
  if (!m || !m.bands || m.bands.length === 0) return Math.min(Math.max(p, 0), 100)
  const idx = Math.min(9, Math.floor(p / 10))
  const band = m.bands[idx]
  if (!band) return Math.min(Math.max(p, 0), 100)
  return Math.min(Math.max(band.rate, 1), MAX_CALIBRATED)
}

/**
 * Calibre un triplet 1X2 complet (chacune des trois issues puis renormalisation).
 */
function calibrate1x2({ p1, px, p2 }) {
  const c1 = calibrateProb(p1, '1X2')
  const cx = calibrateProb(px, '1X2')
  const c2 = calibrateProb(p2, '1X2')
  const sum = c1 + cx + c2
  if (sum <= 0) return { p1: 33.3, px: 33.3, p2: 33.3 }
  const f = 100 / sum
  return { p1: +(c1 * f).toFixed(2), px: +(cx * f).toFixed(2), p2: +(c2 * f).toFixed(2) }
}

module.exports = {
  buildCurve,
  getCurve,
  calibrateProb,
  calibrate1x2,
  _internal: { PICK_MARKET, MIN_BAND_SAMPLES, MAX_CALIBRATED, pavaIsotonic },
}
