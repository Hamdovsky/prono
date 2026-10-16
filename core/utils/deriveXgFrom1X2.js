/**
 * deriveXgFrom1X2 — retrouve les attendus de buts (λh, λa) qui reproduisent au
 * mieux des probabilités 1X2 observées.
 *
 * POURQUOI (E105) : le score attendu (`expected_score`) est dérivé des xG par
 * `analyze_over_under_and_cs`. Les 11 matchs réglés sur 22 qui n'avaient aucun
 * xG conservaient donc le défaut Python `'1 - 1'` — un score qui n'a jamais
 * été calculé.
 *
 * Cause : quand le moteur d'inférence Python (FastAPI :8000) est indisponible
 * ou trop peu confiant, la voie d'enrichissement XGBoost sort en `null`
 * (fallback_enricher.js:202) et rien n'écrit de xG. Or les probabilités 1X2,
 * elles, sont bien persistées — le match est donc enrichi mais sans xG.
 *
 * La voie de secours : les probabilités 1X2 SONT une information suffisante.
 * Sous l'hypothèse poissonienne indépendante à deux paramètres, (λh, λa) est
 * déterminés par le triplet 1X2. On les retrouve par balayage sur une grille
 * fine — la fonction 1X2 de ces deux paramètres est très proche d'univoque.
 *
 * L'erreur de reconstruction mesurée sur les probabilités réelles de la base
 * est de l'ordre de 1e-5 : la reconstruction est fidèle.
 */

// factorielle pour k <= 12 (au-delà le terme est négligeable en pratique)
function factorial(n) {
  let r = 1
  for (let i = 2; i <= n; i++) r *= i
  return r
}

function poisson(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k)
}

/** Probs 1X2 d'un couple (λh, λa) sous poisson indépendante. */
function probs1x2(lambdaH, lambdaA, maxGoals = 10) {
  let H = 0
  let D = 0
  let A = 0
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisson(lambdaH, h) * poisson(lambdaA, a)
      if (h > a) H += p
      else if (h === a) D += p
      else A += p
    }
  }
  const total = H + D + A
  if (!total) return { H: 1 / 3, D: 1 / 3, A: 1 / 3 }
  return { H: H / total, D: D / total, A: A / total }
}

/**
 * @param {number} pHome  probabilité victoire domicile (0..1 ou 0..100)
 * @param {number} pDraw  probabilité nul
 * @param {number} pAway  probabilité victoire extérieur
 * @param {object} [opts]
 * @param {number} [opts.step=0.05] pas de la grille
 * @param {number} [opts.max=4.5]     λ maximal exploré
 * @returns {{homeXg:number, awayXg:number, error:number, reconstructed:object}|null}
 *          null si les probabilités sont absentes ou incohérentes.
 */
function deriveXgFrom1X2(pHome, pDraw, pAway, opts = {}) {
  const toUnit = (v) => {
    const n = parseFloat(v)
    if (!isFinite(n) || n <= 0) return 0
    return n > 1 ? n / 100 : n
  }
  let H = toUnit(pHome)
  let D = toUnit(pDraw)
  let A = toUnit(pAway)

  const sum = H + D + A
  // Sans signal, on ne fabrique rien : l'appelant garde son comportement.
  if (sum <= 0.01) return null
  H /= sum
  D /= sum
  A /= sum

  const step = opts.step || 0.05
  const max = opts.max || 4.5
  const steps = Math.round(max / step)

  let best = null
  let bestErr = Infinity
  for (let ih = 0; ih <= steps; ih++) {
    // Arrondi à 2 décimales : sans cela la grille accumule l'erreur de
    // virgule flottante et l'on stocke 1.2000000000000002 en base.
    const lh = Math.round(ih * step * 100) / 100
    for (let ia = 0; ia <= steps; ia++) {
      const la = Math.round(ia * step * 100) / 100
      const q = probs1x2(lh, la)
      const err = (q.H - H) ** 2 + (q.D - D) ** 2 + (q.A - A) ** 2
      if (err < bestErr) {
        bestErr = err
        best = { homeXg: lh, awayXg: la, error: err, reconstructed: q }
      }
    }
  }
  return best
}

/**
 * Score attendu lisible, même format que le reste de la base ('2 - 1').
 * Renvoie null si on n'a pas de xG exploitable — jamais un '1 - 1' fabriqué.
 */
function expectedScoreFromXg(homeXg, awayXg) {
  const h = parseFloat(homeXg)
  const a = parseFloat(awayXg)
  if (!isFinite(h) || !isFinite(a) || h <= 0 || a <= 0) return null
  return `${Math.round(h)} - ${Math.round(a)}`
}

module.exports = { deriveXgFrom1X2, expectedScoreFromXg, probs1x2, poisson }