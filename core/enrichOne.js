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

  return {
    home_win_probability: hPct,
    draw_probability: dPct,
    away_win_probability: aPct,
    btts_prob: quantResult.probs.btts,
    ou_25_prob: quantResult.probs.over25,
    ai_source: 'TITANIUM_QUANT_V4',
    insufficient_data: m.insufficient_data || 1,
    expected_score: quantResult.expected_score,

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

module.exports = { enrichOne }
