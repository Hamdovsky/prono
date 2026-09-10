// Token JWT utilisateur (via /api/auth/login) — distinct du admin_token
// (secret d'API global). La bankroll BetTracker accepte les deux.
const KEY = 'jwt_token'

export function getUserToken() {
  try {
    return localStorage.getItem(KEY) || ''
  } catch (_) {
    return ''
  }
}

export function setUserToken(token) {
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch (_) {}
}

export function clearUserToken() {
  setUserToken('')
}
