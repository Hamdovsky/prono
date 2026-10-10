// background.js — Sofascore Day Collector
// Service worker MV3 : relais entre le content script (fetch Sofascore,
// même-origin) et l'API locale (127.0.0.1:3001, protégée par localOrAuth).
// Les POST sortants sont faits ICI : les pages d'extension bénéficient de
// host_permissions et ne sont donc pas soumises à CORS.

const DEFAULT_API = 'http://127.0.0.1:3001'
const SOFA_ORIGIN = 'https://www.sofascore.com/*'

async function getSettings() {
  const s = await chrome.storage.local.get({
    apiBase: DEFAULT_API,
    autoRun: false,
    lastRunDay: '',
    lastProgress: null,
    lastSummary: null,
  })
  return s
}

async function postLocal(path, body) {
  const { apiBase } = await getSettings()
  const base = (apiBase || DEFAULT_API).replace(/\/+$/, '')
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_) {}
  if (!res.ok) throw new Error(`API locale ${path} -> HTTP ${res.status}`)
  return json || {}
}

// ── Démarrage : on n'envoie SOFA_RUN qu'à un onglet déjà chargé ------------
let pendingDay = null

async function kickPendingRun() {
  if (!pendingDay) return
  const tabs = await chrome.tabs.query({ url: SOFA_ORIGIN })
  const tab = tabs.find((t) => t.status === 'complete') || null
  if (!tab) {
    // Aucun onglet Sofascore : on en ouvre un, onUpdated relancera le kick.
    if (!tabs.length) await chrome.tabs.create({ url: 'https://www.sofascore.com/' })
    return
  }
  const day = pendingDay
  pendingDay = null
  try {
    const summary = await chrome.tabs.sendMessage(tab.id, { type: 'SOFA_RUN', day })
    await chrome.storage.local.set({ lastSummary: summary || null, lastRunDay: summary && summary.ok ? day : '' })
    chrome.runtime.sendMessage({ type: 'SOFA_SUMMARY', summary }).catch(() => {})
  } catch (e) {
    chrome.storage.local.set({ lastSummary: { ok: false, error: e.message } })
  }
}

chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'complete') kickPendingRun()
})

// Auto-run : une fois par jour, si activé.
chrome.runtime.onInstalled.addListener(async () => {
  const { autoRun } = await getSettings()
  if (autoRun) scheduleAutoRun()
})
async function scheduleAutoRun() {
  try {
    if (chrome.alarms) chrome.alarms.create('sofa-daily', { periodInMinutes: 30 })
  } catch (_) {}
}
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== 'sofa-daily') return
    const s = await getSettings()
    if (!s.autoRun) return
    const day = new Date().toISOString().slice(0, 10)
    if (s.lastRunDay === day) return
    pendingDay = day
    kickPendingRun()
  })
}

// ── Messages ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return

  // Progression du content script -> popup (et trace en storage).
  if (msg.type === 'SOFA_PROGRESS') {
    chrome.storage.local.set({ lastProgress: { ...msg, ts: Date.now() } })
    chrome.runtime.sendMessage(msg).catch(() => {})
    return
  }

  // Phase 1 : fixtures -> API locale -> liste voulue.
  if (msg.type === 'SOFA_COLLECT') {
    postLocal('/api/sofascore/collect', { day: msg.day, fixtures: msg.fixtures })
      .then((j) =>
        sendResponse({
          ok: !!(j && j.success),
          wanted: (j && j.wanted) || [],
          matched: j && j.matched,
          dbCandidates: j && j.dbCandidates,
          error: (j && j.error) || null,
        })
      )
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }

  // Phase 3 : fixtures + cotes brutes -> API locale -> persistOdds.
  if (msg.type === 'SOFA_INGEST') {
    postLocal('/api/sofascore/ingest', { day: msg.day, rows: msg.rows })
      .then((j) => sendResponse({ ...j, ok: !!(j && j.success) }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }

  // Popup -> déclenche la collecte.
  if (msg.type === 'SOFA_START') {
    pendingDay = /^\d{4}-\d{2}-\d{2}$/.test(msg.day || '') ? msg.day : new Date().toISOString().slice(0, 10)
    kickPendingRun()
    sendResponse({ ok: true, queued: true })
    return
  }

  // Popup -> test de l'API locale (round-trip factice sur /collect).
  if (msg.type === 'SOFA_PING') {
    ;(async () => {
      try {
        const { apiBase: base } = await getSettings()
        const res = await fetch(
          `${(base || DEFAULT_API).replace(/\/+$/, '')}/api/sofascore/collect`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day: new Date().toISOString().slice(0, 10), fixtures: [] }),
          }
        )
        sendResponse({ ok: res.ok, status: res.status })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true
  }

  // Popup -> lecture de l'état.
  if (msg.type === 'SOFA_STATE') {
    getSettings().then((s) => sendResponse(s))
    return true
  }

  // Popup -> sauvegarde des réglages.
  if (msg.type === 'SOFA_SAVE') {
    chrome.storage.local.set(msg.settings || {}).then(() => sendResponse({ ok: true }))
    if (msg.settings && msg.settings.autoRun) scheduleAutoRun()
    return true
  }
})
