/**
 * honestyGate — neutralisation des matchs insuffisants (Chantier 2, ÉTAPE 2 audit)
 *
 * Module PUR, extrait de enriched_predictions.js (lignes 1548-1593) pour être
 * testable sans les dépendances lourdes du service d'enrichissement.
 *
 * FIX STRUCTUREL (cause racine de la contradiction risk_label:"PENDING" + sufficient:true) :
 * resultData est construit par spread de l'état précédent ({ ...m, ... }). La branche
 * `else` (match suffisant) ne réinitialisait PAS risk_label ni enriched.sufficient :
 * un match passé par une passe insuffisante puis suffisante gardait un verdict périmé.
 *
 * Règle appliquée ici : CHAQUE passe écrit TOUS les champs dérivés du verdict, qu'elle
 * soit suffisante ou non — jamais d'héritage silencieux.
 *
 * Audit des champs hérités via { ...m, ... } (résultat du grep, Chantier 2 point 1) :
 *   - risk_label        (top-level)  → STALE, corrigé ici (reset dans les 2 branches)
 *   - enriched.sufficient            → STALE, corrigé ici (reset dans les 2 branches)
 *   - enriched.risk_label/prediction/insufficient_data → STALE latent, resets ajoutés
 *   - verdict/prediction/confidence/quant/predictions[]/sufficient/market_scope →
 *     déjà recalculés frais à chaque passe (verdict/quant/prediction dans le literal,
 *     sufficient dans les branches) → aucun autre cas
 *   - odds_home/draw/away → null si insufficient OU !hasRealOdds, hérités sinon (cohérent)
 */

/**
 * Applique le HONESTY GATE sur resultData (muté en place, puis retourné).
 * @param {object} resultData   résultat assemblé de la passe courante
 * @param {object} ctx
 * @param {0|1}    ctx.insufficient   1 si aucune donnée exploitable (pas de cote + signal plat)
 * @param {boolean} ctx.hasRealOdds    cotes bookmaker réelles persistées en colonnes
 * @param {boolean} ctx.oddsSynthetic  m._oddsAreSynthetic (pour le label de la source)
 * @returns {object} resultData réconcilié
 */
function applyHonestyGate(resultData, { insufficient, hasRealOdds, oddsSynthetic }) {
  if (insufficient) {
    resultData.odds_home = null
    resultData.odds_draw = null
    resultData.odds_away = null
    if (resultData.odds_source) resultData.odds_source = oddsSynthetic ? 'synthetic' : 'model_league'
    resultData.prediction = null
    resultData.verdict = 'PENDING'
    resultData.risk_label = 'PENDING'
    resultData.quant.main_pick = null
    resultData.quant.risk_label = 'PENDING'
    resultData.quant.all_picks = []
    resultData.quant.markets = {}
    resultData.quant.market_odds = null
    resultData.quant.ev_score = 0
    resultData.quant.edge_score = 0
    resultData.quant.massive_edge = false
    resultData.draw_value_bet = false
    resultData.predictions = []
    resultData.confidence = Math.min(resultData.confidence || 0, 40)
    if (resultData.enriched) {
      resultData.enriched.winner = null
      resultData.enriched.main_predictions = []
      resultData.enriched.verdict = 'PENDING'
      resultData.enriched.sufficient = false
      resultData.enriched.risk_label = 'PENDING'
      resultData.enriched.prediction = null
      resultData.enriched.insufficient_data = 1
    }
    resultData.sufficient = false
  } else {
    resultData.sufficient = true
    // FIX STRUCTUREL : reset explicite à CHAQUE passe suffisante (jamais hérité via ...m).
    resultData.risk_label = resultData.quant?.risk_label || resultData.verdict || 'SAFE'
    if (resultData.enriched) {
      resultData.enriched.sufficient = true
      resultData.enriched.risk_label = resultData.risk_label
      resultData.enriched.prediction = resultData.prediction ?? null
      resultData.enriched.insufficient_data = 0
    }
    // HONESTY: sans cotes bookmaker réelles, la valeur/le edge sont neutralisés
    // (le pick modèle et le verdict sont conservés — jamais d'odds inventées).
    if (!hasRealOdds) {
      resultData.quant.ev_score = 0
      resultData.quant.edge_score = 0
      resultData.quant.massive_edge = false
      resultData.draw_value_bet = false
      resultData.odds_home = null
      resultData.odds_draw = null
      resultData.odds_away = null
      if (resultData.odds_source) resultData.odds_source = oddsSynthetic ? 'synthetic' : 'model_league'
    }
  }
  return resultData
}

module.exports = { applyHonestyGate }
