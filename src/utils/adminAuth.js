// In-memory admin token for sensitive actions (promosport retrain / diagnostic).
// Stored in a module variable only — NEVER persisted to localStorage,
// sessionStorage, or cookies. It is lost on page reload.

let token = ''

export function getAdminToken() {
  return token
}

export function setAdminToken(value) {
  token = (value || '').trim()
}

export function clearAdminToken() {
  token = ''
}

export function hasAdminToken() {
  return !!token
}
