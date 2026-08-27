/**
 * enrichOne — enrichissement indépendant d'un match (PRIORITÉ 0, ÉTAPE 2 audit)
 *
 * Extracté de la closure setTimeout de server.js pour être testable en module pur.
 * Principe (symétrique du honestyGate / chantier2) : chaque passe écrit TOUS les
 * champs dérivés (prediction, verdict, risk_label, confidence, sufficient,
 * market_scope, quant, enriched) — jamais un retour partiel qui laisserait
 * updatePredictions hériter d'une colonne staled.
 *
 * Bug historique : le return ne contenait que probs + quant (sans prediction),
 * donc server.js:519 `updatePredictions(m.id, { ...m, ...enriched })` réécrivait
 * la colonne prediction stale ('1') au lieu de quant.main_pick (1X/O0.5/12) →
 * mismatch 94% sur le slate. Voir CHANGELOG_AUDIT.md — Chantier 4.
 */

const QuantumQuantEngine = require('./QuantumQuantEngine')
const featureEngineer = require('./services/FeatureEngineer')
const { marketScopeOf } = require('./marketScope')

function computeXg(m) {
  // Generate hash-based synthetic odds (deterministic per match)
  const str = `${m.homeTeam || 'Home'}_vs_${m.awayTeam || 'Away'}_${m.league || ''}`
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash = hash & hash
  }
  const seed = Math.abs(hash) / 2147483647
  const seed2 = ((hash >> 8) & 0xff) / 255

  // Use real odds if available, otherwise synthetic
  let xgH, xgA
  if (m.odds_home && m.odds_draw && m.odds_away && !m._oddsAreSynthetic) {
    // Derive xG from real odds
    const oh = parseFloat(m.odds_home)
    const od = parseFloat(m.odds_draw)
    const oa = parseFloat(m.odds_away)
    const ph = 1 / oh,
      pd = 1 / od,
      pa = 1 / oa
    const sum = ph + pd + pa
    const nh = ph / sum,
      na = pa / sum
    xgH = Math.max(0.5, Math.min(3.5, nh * 4.0))
    xgA = Math.max(0.5, Math.min(3.5, na * 4.0))
  } else {
    // Synthetic odds fallback
    const hp = 0.3 + seed * 0.25 // narrower range for more realistic odds
    const dp = 0.18 + seed2 * 0.16
    const ap = Math.max(0.08, 1 - hp - dp)
    const odH = hp / 1.05,
      odD = dp / 1.05,
      odA = ap / 1.05
    const oSum = odH + odD + odA
    xgH = Math.max(0.5, Math.min(3.5, (odH / oSum) * 4.0))
    xgA = Math.max(0.5, Math.min(3.5, (odA / oSum) * 4.0))
  }

  // Apply free features for better differentiation
  const adjusted = featureEngineer.applyFeatures(m, xgH, xgA)
  return { xgH: adjusted.xgH, xgA: adjusted.xgA }
}

/**
 * Enrichit un match avec l'ensemble COMPLET des champs dérivés.
 * Dépendances injectables pour tests (quantEngine/marketScopeOf peuvent être mockés).
 *
 * @param {object} m match brut (getMatchesByStatuses)
 * @param {object} [deps] - { quantEngine, marketScopeOf }
 * @returns {object} résultat complet, auto-consistant, à passer à updatePredictions
 */
async function enrichOne(m, deps = {}) {
  const quantEngine = deps.quantEngine || QuantumQuantEngine
  const scopeOf = deps.marketScopeOf || marketScopeOf

  const { xgH, xgA } = computeXg(m)

  // Run QuantumQuantEngine (fast, synchronous)
  const quantResult = quantEngine.analyze(m, xgH, xgA)
  const probs = quantResult.markets.match_result
  const hPct = Math.max(1, +(probs['1'].prob * 100).toFixed(1))
  const dPct = Math.max(1, +(probs['X'].prob * 100).toFixed(1))
  const aPct = Math.max(1, +(probs['2'].prob * 100).toFixed(1))

  const prediction = quantResult.main_pick || (hPct >= aPct ? '1' : '2')
  const verdict = quantResult.risk_label || 'BALANCED'
  const scope = scopeOf(quantResult.main_pick, quantResult.markets)
  const confidence = quantResult.confidence
  const sufficient = true

  // Audit P3 (2026-08-26) : marquage low-data CORRIGÉ. L'ancien code
  // `m.insufficient_data || 1` forçait toujours 1 (car 0 || 1 === 1) → tous les
  // matchs étaient marqués insufficient_data. On utilise une valeur booléenne
  // stricte pour que seuls les matchs réellement insufficient_data=1 soient
  // marqués (permet à accuracyEngine de mesurer la perf low-data séparément).
  const isLowData = !!m.insufficient_data

  // Audit Prio 2 (2026-08-26) : snapshot « engine_exit » = probabilités FINALES
  // du moteur AVANT toute fusion DB. Permet de tracer / mesurer l'écart entre ce
  // point de sortie et ce qui est effectivement persisté dans fullData.probs
  // (database.updatePredictions écrit fullData.home_win_probability =
  // enriched.home_win_probability || …, donc en principe identique — ce helper
  // sert à LE prouver et à détecter toute mutation ultérieure).
  const engineExit = {
    p1: hPct,
    px: dPct,
    p2: aPct,
    btts: quantResult.probs.btts,
    over25: quantResult.probs.over25,
  }

  return {
    home_win_probability: hPct,
    draw_probability: dPct,
    away_win_probability: aPct,
    btts_prob: quantResult.probs.btts,
    ou_25_prob: quantResult.probs.over25,
    ai_source: 'TITANIUM_QUANT_V4',
    insufficient_data: isLowData ? 1 : 0,
    zero_data_rescue: isLowData,
    is_low_data_prediction: isLowData,
    expected_score: quantResult.expected_score,

    // Audit Prio 2 : ancre traçable (persistée dans fullData.enriched.engine_exit
    // via data.enriched || data dans database.updatePredictions).
    engine_exit: engineExit,

    // ── Champs dérivés complets (le fix : jamais laisser la colonne staled) ──
    prediction,
    verdict,
    risk_label: verdict,
    confidence,
    sufficient,
    market_scope: scope,

    quant: {
      main_pick: prediction,
      ev_score: quantResult.ev_score || '0.00',
      risk_label: verdict,
      confidence,
      markets: quantResult.markets,
      probs: quantResult.probs,
      expected_score: quantResult.expected_score,
    },

    // Sous-objet enriched synchronisé (consommé par database.updatePredictions
    // via data.enriched || data — doit refléter la passe courante, pas la précédente)
    enriched: {
      winner: prediction,
      prediction,
      verdict,
      risk_label: verdict,
      confidence,
      sufficient,
      market_scope: scope,
      // Audit P3 : marqueurs low-data répliqués dans enriched (lus par
      // accuracyEngine pour isoler les picks low-data / ZERO-DATA).
      insufficient_data: isLowData ? 1 : 0,
      zero_data_rescue: isLowData,
      is_low_data_prediction: isLowData,
      // Audit Prio 2 : même snapshot dans enriched pour consultation directe.
      engine_exit: engineExit,
      // quant EMBARQUÉ : l'ancien enrichOne écrivait quant en top-level, qui était
      // ensuite fusionné dans fullData.enriched.quant par updatePredictions. Sans
      // réécrire enriched.quant ici, ce sous-champ restait stale (ex: colonne 12
      // mais enriched.quant.main_pick = O0.5). Réécrit à chaque passe.
      quant: {
        main_pick: prediction,
        ev_score: quantResult.ev_score || '0.00',
        risk_label: verdict,
        confidence,
        markets: quantResult.markets,
        probs: quantResult.probs,
        expected_score: quantResult.expected_score,
      },
    },
  }
}

/**
 * Audit Prio 2 (2026-08-26) : mesure l'écart absolu maximal entre les
 * probabilités de sortie du moteur (engine_exit) et celles effectivement
 * persistées (fullData.probs). Retourne un nombre ≥ 0 ; 0 = fidèle.
 *
 * @param {{p1:number,px:number,p2:number}} engineExit
 * @param {{home_win_probability?:number,draw_probability?:number,away_win_probability?:number}} persisted
 * @returns {number} écart absolu maximal (en points de pourcentage)
 */
function engineExitDiff(engineExit, persisted) {
  if (!engineExit || !persisted) return NaN
  const diffs = [
    Math.abs((engineExit.p1 ?? 0) - (persisted.home_win_probability ?? 0)),
    Math.abs((engineExit.px ?? 0) - (persisted.draw_probability ?? 0)),
    Math.abs((engineExit.p2 ?? 0) - (persisted.away_win_probability ?? 0)),
  ]
  return Math.max(...diffs)
}

module.exports = { enrichOne, engineExitDiff }
