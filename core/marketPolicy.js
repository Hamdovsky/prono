/**
 * marketPolicy — P4 audit 2026-08 : masquage RÉVERSIBLE du 1X2 pur.
 *
 * Contexte : le marché 1X2 pur plombe le ROI global (40,5 % de précision,
 * break-even à 42,6 % avec une cote moyenne de 2,35). Tant que la calibration
 * n'est pas fiabilisée, tout verdict 1X2 pur est converti en son équivalent
 * double chance au moment de la persistance :
 *   '1' → '1X', '2' → 'X2', 'X' → côté le plus probable (pas de DC « nul seul »).
 *
 * Activation : DISABLE_PURE_1X2=true (.env). La prédiction d'origine est
 * conservée dans originalPrediction (fullData) pour l'audit et la réactivation.
 * Critère de réactivation : précision calibrée ≥ 42,6 % sur un échantillon
 * n ≥ 200 (voir scripts/diagnose_1x2.js et CHANGELOG_AUDIT.md).
 */
const DISABLE_PURE_1X2 =
  String(process.env.DISABLE_PURE_1X2 || '')
    .trim()
    .toLowerCase() === 'true'

function applyMarketPolicy(prediction, probs) {
  if (!prediction) return { prediction, converted: false }
  const p = String(prediction).trim().toUpperCase()
  if (!DISABLE_PURE_1X2 || (p !== '1' && p !== 'X' && p !== '2')) {
    return { prediction, converted: false }
  }
  if (p === 'X') {
    const p1 = Number(probs?.home_win_probability ?? probs?.p1 ?? 0)
    const p2 = Number(probs?.away_win_probability ?? probs?.p2 ?? 0)
    return { prediction: p1 >= p2 ? '1X' : 'X2', originalPrediction: p, converted: true }
  }
  return {
    prediction: p === '1' ? '1X' : 'X2',
    originalPrediction: p,
    converted: true,
  }
}

/**
 * Audit « marchés supplémentaires » (2026-08-24) — dérivation du pick BTTS au
 * temps T. Source prioritaire : quant.markets.btts.YES (proba modèle), sinon
 * colonne btts_prob (% OUI). Seuil 50 %. Retourne aussi la proba normalisée
 * (%) pour la calibration accuracyEngine. Null si aucune donnée exploitable.
 */
function deriveBttsPick(src) {
  let yes = null

  const q = src?.quant?.markets?.btts ?? src?.enriched?.quant?.markets?.btts
  if (q) {
    const raw = typeof q.YES === 'object' && q.YES !== null ? q.YES.prob : q.YES
    const v = Number(raw)
    if (Number.isFinite(v) && v > 0) yes = v <= 1 ? v * 100 : v
  }

  if (yes == null && src?.btts_prob != null) {
    const v = Number(src.btts_prob)
    if (Number.isFinite(v) && v > 0) yes = v <= 1 ? v * 100 : v
  }

  if (yes == null || !Number.isFinite(yes)) return { bttsPick: null, bttsProb: null }

  const bttsProb = +Math.min(99.9, Math.max(0.1, yes)).toFixed(1)
  return { bttsPick: bttsProb >= 50 ? 'BTTS YES' : 'BTTS NO', bttsProb }
}

/**
 * Audit « marchés supplémentaires » (2026-08-25) — dérivation du pick Corners
 * (O/U d'une ligne, défaut 9.5) au temps T. Source prioritaire :
 * quant.markets.corners.expected, sinon colonne expected_corners. Le pick est
 * OVER si le total attendu >= ligne, UNDER sinon. Probabilité = confiance
 * linéaire autour de la ligne (50 % sur la ligne). Null si aucune donnée.
 */
function deriveCornerPick(src) {
  const line = Number(process.env.CORNER_LINE || '9.5')
  let ec = null
  const q = src?.quant?.markets?.corners
  if (q) {
    const v = Number(q.expected != null ? q.expected : q.expected_corners)
    if (Number.isFinite(v) && v > 0) ec = v
  }
  if (ec == null && src?.expected_corners != null) {
    const v = Number(src.expected_corners)
    if (Number.isFinite(v) && v > 0) ec = v
  }
  if (ec == null || !Number.isFinite(ec)) return { cornerPick: null, cornerProb: null, line }
  const over = ec >= line
  const prob = +Math.min(95, Math.max(5, Math.round(50 + (ec - line) * 12))).toFixed(1)
  return {
    cornerPick: over ? `CORNERS OVER ${line}` : `CORNERS UNDER ${line}`,
    cornerProb: prob,
    line,
  }
}

/**
 * Audit « marchés supplémentaires » (2026-08-25) — dérivation du pick HT
 * (O/U 0.5 but en 1re mi-temps) au temps T. Source prioritaire :
 * quant.markets.ht.goal_yes (prob Over 0.5), sinon ht_goal_prob. Seuil 50 %.
 * Null si aucune donnée exploitable.
 */
function deriveHTPick(src) {
  let p = null
  const q = src?.quant?.markets?.ht
  if (q) {
    const raw = q.goal_yes != null ? q.goal_yes : q.over_05
    const v = Number(raw)
    if (Number.isFinite(v) && v > 0) p = v <= 1 ? v * 100 : v
  }
  if (p == null && src?.ht_goal_prob != null) {
    const v = Number(src.ht_goal_prob)
    if (Number.isFinite(v) && v > 0) p = v <= 1 ? v * 100 : v
  }
  if (p == null || !Number.isFinite(p)) return { htPick: null, htProb: null }
  const htProb = +Math.min(99.9, Math.max(0.1, p)).toFixed(1)
  return { htPick: htProb >= 50 ? 'HT OVER 0.5' : 'HT UNDER 0.5', htProb }
}

module.exports = {
  applyMarketPolicy,
  isPure1x2Disabled: () => DISABLE_PURE_1X2,
  deriveBttsPick,
  deriveCornerPick,
  deriveHTPick,
}
