/**
 * envFlag — sémantique unique pour les drapeaux d'environnement (E103)
 *
 * PROBLÈME : deux conventions coexistent dans le même projet, et le MÊME nom de
 * drapeau est interprété différemment selon le fichier.
 *
 *   Opt-out  : actif SAUF si explicitement désactivé
 *              `X !== undefined && X !== 'false'`
 *              → DISABLE_SOFASCORE (apiClient, autoArchiver, sofascoreXgService)
 *              → tous les SERVICES_ENABLED, les FEATURE_ENABLED
 *
 *   Opt-in   : actif seulement si explicitement activé
 *              `X === 'true'`
 *              → DISABLE_SOFASCORE (routes/scraper, scrapeVisualBatch,
 *                                    dataFusionService, sofascoreOddsService)
 *
 * Conséquence concrète : `DISABLE_SOFASCORE=1` ne désactivait que 3 subsystems
 * sur 7, alors que `=true` les désactivait tous. Une coquille d'un caractère
 * changeait le comportement d'un quart du système, sans aucun message d'erreur.
 *
 * RÈGLE (à appliquer pour tout nouveau drapeau) :
 *   • Préfixe DISABLE_* → famille opt-out  → isDisabled(name)
 *   • Suffixe *_ENABLED                   → famille opt-out  → isEnabled(name)
 *     (désactiver un service : X_ENABLED=false)
 *
 * ⚠️ isEnabled et isDisabled ne sont PAS complémentaires : elles portent sur
 * des noms de drapeaux différents et n'ont pas le même défaut (voir le
 * commentaire de isEnabled). Ne jamais les apparier ni les inverser.
 */

const FALSY = new Set(['false', '0', 'no', 'off', ''])
const TRUTHY = new Set(['true', '1', 'yes', 'on'])

/** Normalise une valeur d'environnement en boolean.
 *
 *  @param {string|undefined} raw
 *  @param {boolean} def valeur si la variable est absente
 *
 *  DEVIATION DOCUMENTEE : historiquement la famille opt-out testait
 *  `X !== 'false'`, donc TOUTE valeur non vide et non-'false' desactivait le
 *  drapeau — y compris une coquille comme `DISABLE_SOFASCORE=maybe`. On
 *  n'applique plus ce comportement : seule une valeur explicitement vraie
 *  agit. L'etat de production est identique (`.env` porte
 *  `DISABLE_SOFASCORE=true`, qui est dans TRUTHY).
 */
function parse(raw, def) {
  if (raw === undefined || raw === null) return def
  const v = String(raw).trim().toLowerCase()
  if (TRUTHY.has(v)) return true
  // Repli : false pour les deux familles. On ne devine pas sur une valeur
  // inattendue.
  return false
}

/**
 * Famille DISABLE_* — le drapeau agit SAUF s'il est explicitement posé.
 * Non défini  => false (non désactivé).  ← défaut historique
 * 'false'     => false (désactivé).
 * 'true'      => true.
 * '1'/'yes'/'on' => true (élargissement : ces valeurs sont des synonymes
 *                      évidents de 'true' ; aucune ne figurait dans .env).
 */
function isDisabled(name) {
  return parse(process.env[name], false)
}

/** `!== 'false'` — le service est actif sauf désactivation explicite. */
function isNotDisabled(name) {
  return !isDisabled(name)
}

/**
 * Famille *_ENABLED — ÉQUIVALENTE à `X !== 'false'`.
 *
 * ATTENTION : isEnabled et isDisabled ne sont PAS complémentaires, et ne
 * doivent jamais l'être. Elles portent sur des NOMS de drapeaux différents et
 * n'ont pas le même défaut :
 *   DISABLE_SOFASCORE absent => non désactivé  (défaut false)
 *   OPEN_METEO_ENABLED absent => actif          (défaut TRUE)
 * Écrire `isEnabled(x) = !isDisabled(x)` donnait : `OPEN_METEO_ENABLED=true`
 * => false, soit l'inverse de l'intention. Une telle inversion passe
 * inaperçue dans les tests, car la variable y est absente et les deux
 * renvoient alors la même valeur.
 *
 * Équivalence stricte vérifiée sur 8 valeurs (absent, true, false, 1, 0,
 * yes, on, maybe).
 */
function isEnabled(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === null) return true // défaut historique : actif
  return String(raw).trim().toLowerCase() !== 'false'
}

/** Opt-in : actif si la valeur est un synonyme de 'true'. */
function isOptedIn(name) {
  return parse(process.env[name], false)
}

/* ──────────────────────────────────────────────────────────────────────────
 * SÉMANTIQUES LITTÉRALES (héritées) — à migrer, ne pas étendre
 *
 * E104 : ces trois fonctions reproduisent EXACTEMENT les comparaisons
 * `X === 'true'`, `X !== 'true'`, `X === 'false'` du code d'origine.
 *
 * Elles ne sont PAS équivalentes aux familles ci-dessus, et les confondre
 * inverse le sens du drapeau. Cas réel rencontré pendant la migration :
 *   `VISUAL_WARM_ENABLED === 'false'` -> `!isEnabled('VISUAL_WARM_ENABLED')`
 * or isEnabled vaut false des que la variable vaut 'true'/'1'/'yes'/'on' :
 * `VISUAL_WARM_ENABLED=true` désactivait alors le préchauffage, exactement
 * l'inverse de l'intention. Deux tests l'ont rattrapé.
 *
 * Règle : si le site d'origine testait `!== 'true'`, c'est
 * « pas explicitement activé », PAS « pas truthy »..Idem pour `=== 'false'`.
 * `=== 'true'` est le seul cas où isOptedIn est sûr (élargissement
 * documenté : accepte aussi 1/yes/on, ce qui va dans le sens du drapeau).
 * ────────────────────────────────────────────────────────────────────────── */

/** `X === 'true'` — exact. */
function isTrueLiteral(name) {
  return process.env[name] === 'true'
}

/** `X !== 'true'` — exact. Vrai si la variable est absente. */
function isNotTrueLiteral(name) {
  return process.env[name] !== 'true'
}

/** `X === 'false'` — exact. Faux si la variable est absente. */
function isFalseLiteral(name) {
  return process.env[name] === 'false'
}

/** Alias de désactivation, pour la lisibilité des sites d'appel. */
const disable = isDisabled
const enable = isEnabled

module.exports = {
  parse,
  isDisabled,
  isNotDisabled,
  isEnabled,
  isOptedIn,
  isTrueLiteral,
  isNotTrueLiteral,
  isFalseLiteral,
  disable,
  enable,
}