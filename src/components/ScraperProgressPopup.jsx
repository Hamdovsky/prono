import React, { useState, useEffect, useCallback } from 'react'
import { getApiUrl } from '../config/apiConfig'
import './ScraperDashboard.css'

const FREE_SOURCES = [
  { key: 'sofascore', label: 'Sofascore' },
  { key: 'openligadb', label: 'OpenLigaDB' },
  { key: 'sportscore', label: 'SportScore' },
  { key: 'betexplorer', label: 'BetExplorer' },
  { key: 'footballDataUK', label: 'Football-Data UK' },
  { key: 'clubelo', label: 'ClubElo' },
]

function fmtClock(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function etaText(p) {
  if (!p || !p.isRunning) return '—'
  const done = p.done || 0
  const total = p.total || 0
  if (total <= 0 || done <= 0) return 'en cours de démarrage…'
  const remaining = total - done
  if (remaining <= 0) return 'finalisation…'
  const elapsedMs = Date.now() - new Date(p.startedAt || Date.now()).getTime()
  const rate = elapsedMs > 0 ? done / elapsedMs : 0
  if (rate <= 0) return 'estimation indisponible'
  const etaMs = remaining / rate
  if (!Number.isFinite(etaMs) || etaMs <= 0) return 'estimation indisponible'
  const min = Math.ceil(etaMs / 60000)
  if (min < 1) return 'moins d\u2019une minute'
  return `environ ${min} min restantes`
}

function sourceState(src) {
  const disabled = !!src?.disabled
  if (src?.blocked) return { ok: false, text: `Bloqué (cooldown jusqu\u2019à ${fmtClock(src.blockedUntil)})` }
  if (disabled) return { ok: false, text: 'Désactivée' }
  if (src?.error) return { ok: false, text: `Erreur: ${src.error}` }
  if (src?.available === false) return { ok: false, text: 'Non configurée' }
  return { ok: true, text: 'Active' }
}

export default function ScraperProgressPopup() {
  const [status, setStatus] = useState(null)
  const [sources, setSources] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [sRes, srcRes] = await Promise.all([
        fetch(getApiUrl('/api/scraper/status')),
        fetch(getApiUrl('/api/scraper/sources')),
      ])
      if (sRes.ok) setStatus(await sRes.json())
      if (srcRes.ok) setSources(await srcRes.json())
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [load])

  const s = status || {}
  const running = !!s.isRunning
  const percent = Math.max(0, Math.min(100, s.percent || 0))
  const srcMap = sources?.sources || {}
  const diag = sources?.freeSourcesDiagnostic || {}

  return (
    <div className="scraper-dash scraper-popup">
      <div className="scraper-progress-head">
        <h3>Progression du scraper (Sofascore)</h3>
        <span className={running ? 'scraper-progress-badge scraper-progress-badge-live' : 'scraper-progress-badge'}>
          {running ? '● Scan en cours' : 'Idle'}
        </span>
      </div>

      {error && <div className="scraper-msg scraper-msg-error">Erreur: {error}</div>}

      {(s.total || 0) > 0 ? (
        <>
          <div className="scraper-progress-bar">
            <div className="scraper-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="scraper-progress-stats">
            <div>
              <span className="scraper-k">Traités</span>
              <span className="scraper-v">{s.done ?? 0} / {s.total ?? 0}</span>
            </div>
            <div>
              <span className="scraper-k">Pourcentage</span>
              <span className="scraper-v">{Math.round(percent)}%</span>
            </div>
            <div>
              <span className="scraper-k">Erreurs</span>
              <span className="scraper-v">{s.failed ?? 0}</span>
            </div>
            <div>
              <span className="scraper-k">Restants</span>
              <span className="scraper-v">{s.remaining ?? 0}</span>
            </div>
            <div>
              <span className="scraper-k">Fin estimée</span>
              <span className="scraper-v">{etaText(s)}</span>
            </div>
          </div>
          {s.currentTask && (
            <div className="scraper-progress-task">
              <span className="scraper-k">Match en cours</span>
              <span className="scraper-v">{s.currentTask}</span>
              {s.currentLeague && s.currentLeague !== 'N/A' && (
                <span className="scraper-progress-league">{s.currentLeague}</span>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="scraper-sub">Aucun scan en cours.</div>
      )}

      <div className="popup-sources">
        <h3>Sources gratuites</h3>
        {FREE_SOURCES.map(({ key, label }) => {
          const diagState = diag[key]
          const st = sourceState(diagState || srcMap[key])
          return (
            <div className="scraper-source" key={key}>
              <div className="scraper-source-head">
                <span className="scraper-source-name">{label}</span>
                <span className="scraper-status" style={{ color: st.ok ? 'var(--success)' : 'var(--danger)' }}>
                  {st.ok ? 'OK' : st.text}
                </span>
              </div>
              {diagState?.detail && <div className="scraper-ok" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{diagState.detail}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
