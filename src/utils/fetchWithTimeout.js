// fetchWithTimeout — fetch avec delai maximal (E106).
//
// Constat : AUCUN appel reseau du dashboard n'avait de timeout (sauf
// ScraperDashboard). Quand l'API ou le moteur ML ne repond pas, les pages
// restent en "Chargement..." indefiniment au lieu d'afficher une erreur.
//
// L'erreur de delai porte `timeout: true` et `name: 'TimeoutError'` pour que
// l'UI distingue "delai depasse / reessayer" d'une vraie erreur metier.
// Les autres erreurs (HTTP, reseau) sont reemises telles quelles.
//
// Sans point-virgule (convention du projet), sans import.meta (doit rester
// importable sous Jest en environnement node).

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeout = new Error(`Delai depasse (${timeoutMs} ms) : ${url}`)
      timeout.name = 'TimeoutError'
      timeout.timeout = true
      timeout.url = url
      throw timeout
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export const FETCH_TIMEOUTS = {
  read: 15000,
  write: 30000,
}
