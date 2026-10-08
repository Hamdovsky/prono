// popup.js — Sofascore Day Collector
const $ = (id) => document.getElementById(id)
const status = $('status')

function setStatus(text, cls) {
  status.textContent = text
  status.className = cls || ''
}

function progressLabel(p) {
  if (!p) return ''
  return `[${p.stage}] ${p.detail || ''}`
}

async function settings() {
  return chrome.runtime.sendMessage({ type: 'SOFA_STATE' })
}

async function save(patch) {
  return chrome.runtime.sendMessage({ type: 'SOFA_SAVE', settings: patch })
}

function render(s) {
  $('api').value = s.apiBase || ''
  $('auto').checked = !!s.autoRun
  if (s.lastSummary && s.lastSummary.ok) {
    const x = s.lastSummary
    setStatus(
      `Dernière collecte ${x.day} : ${x.tournois} tournois, ${x.fixtures} fixtures,\n` +
        `${x.voulus} ciblés, ${x.persistes} cotes écrites, ${x.sansCote} sans cote, ${x.inconnus} inconnus.`,
      'ok'
    )
  } else if (s.lastSummary && s.lastSummary.error) {
    setStatus(`Échec : ${s.lastSummary.error}`, 'err')
  } else if (s.lastProgress) {
    setStatus(progressLabel(s.lastProgress), 'muted')
  }
}

async function init() {
  const s = await settings()
  render(s)
  $('api').placeholder = 'http://127.0.0.1:3001'
}

$('run').addEventListener('click', async () => {
  await save({ apiBase: $('api').value.trim() || 'http://127.0.0.1:3001', autoRun: $('auto').checked })
  $('run').disabled = true
  setStatus('Démarrage : ouverture de l’onglet Sofascore si besoin…', 'muted')
  const r = await chrome.runtime.sendMessage({ type: 'SOFA_START', day: '' })
  if (r && r.ok) setStatus('Collecte en cours… (voir ci-dessous)', 'muted')
  else setStatus(`Refus : ${(r && r.error) || 'inconnu'}`, 'err')
  setTimeout(() => {
    $('run').disabled = false
  }, 4000)
})

$('ping').addEventListener('click', async () => {
  await save({ apiBase: $('api').value.trim() || 'http://127.0.0.1:3001' })
  setStatus('Test de l’API locale…', 'muted')
  const r = await chrome.runtime.sendMessage({ type: 'SOFA_PING' })
  if (r && r.ok) setStatus(`API locale joignable (HTTP ${r.status}).`, 'ok')
  else setStatus(`API locale injoignable : ${(r && (r.error || r.status)) || 'inconnu'}`, 'err')
})

// Flux de progression relais par le background.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return
  if (msg.type === 'SOFA_PROGRESS') {
    setStatus(`[en cours] ${msg.stage} : ${msg.detail || ''}`, 'muted')
  } else if (msg.type === 'SOFA_SUMMARY') {
    const x = msg.summary
    if (!x) return
    if (x.ok) {
      setStatus(
        `OK ${x.day} : ${x.tournois} tournois, ${x.fixtures} fixtures, ${x.voulus} ciblés,\n` +
          `${x.persistes} cotes écrites, ${x.sansCote} sans cote, ${x.inconnus} inconnus.`,
        'ok'
      )
    } else {
      setStatus(`Échec : ${x.error || 'inconnu'}`, 'err')
    }
  }
})

// Rafraîchissement périodique depuis le storage (le popup peut être fermé).
setInterval(async () => {
  const s = await settings()
  if (s && s.lastProgress && s.lastSummary !== status.dataset.summary) {
    if (!s.lastSummary) setStatus(progressLabel(s.lastProgress), 'muted')
  }
}, 900)

init()
