/**
 * marketScope — dérivation du marché réel d'un main_pick (Chantier 1, ÉTAPE 2 audit)
 *
 * Le main_pick du moteur quant (QuantumQuantEngine) peut provenir de n'importe quel
 * marché (match_result, over_under, double_chance, first_half, btts). Le label seul
 * (ex: "O0.5") ne code pas le marché : un "O0.5" full-time est trivial, un "O0.5"
 * first-half est un vrai pari mi-temps. Ce module permet à accuracyEngine d'évaluer
 * chaque pick contre le bon référentiel, sans changer ce qui est promu en prediction.
 */

const MARKET_SCOPES = {
  match_result: 'full_time_1x2',
  over_under: 'full_time_ou',
  double_chance: 'full_time_dc',
  first_half: 'first_half',
  btts: 'btts',
}

/**
 * Retrouve le marché auquel appartient mainPick dans l'objet quant.markets.
 * @param {string|null} mainPick  valeur du main pick (ex: "O0.5", "12", "1")
 * @param {object|null} markets   quantResult.markets ({ match_result, over_under, ... })
 * @returns {string|null} scope normalisé, 'unknown' si non trouvé, null si pas de pick
 */
function marketScopeOf(mainPick, markets) {
  if (mainPick == null || mainPick === '') return null
  if (!markets || typeof markets !== 'object') return 'unknown'

  const pick = String(mainPick)
  for (const [market, map] of Object.entries(markets)) {
    if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, pick)) {
      return MARKET_SCOPES[market] || market
    }
  }
  return 'unknown'
}

module.exports = { marketScopeOf, MARKET_SCOPES }
