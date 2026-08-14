import React, { useState, useEffect, useCallback } from 'react'
import { getApiUrl } from '../config/apiConfig'
import './ScraperDashboard.css'

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' })
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(0)}%`
}

function SourceRow({ name, s }) {
  const disabled = !!s.disabled
  const statusColor = disabled ? 'var(--danger)' : 'var(--success)'
  const statusLabel = disabled ? 'Cooldown' : 'OK'
  return (
    <div className="scraper-source">
      <div className="scraper-source-head">
        <span className="scraper-source-name">{name}</span>
        <span className="scraper-status" style={{ color: statusColor }}>
          {statusLabel}
        </span>
      </div>
      <div className="scraper-source-grid">
        <div>
          <span className="scraper-k">Scans</span>
          <span className="scraper-v">{s.scans ?? 0}</span>
        </div>
        <div>
          <span className="scraper-k">Taux succès</span>
          <span className="scraper-v">{pct(s.successRate)}</span>
        </div>
        <div>
          <span className="scraper-k">Échecs</span>
          <span className="scraper-v">{s.failures ?? 0}</span>
        </div>
        <div>
          <span className="scraper-k">Fixtures/scan</span>
          <span className="scraper-v">{Math.round(s.avgFetched ?? 0)}</span>
        </div>
        <div>
          <span className="scraper-k">Nouveaux/scan</span>
          <span className="scraper-v">{Math.round(s.avgNew ?? 0)}</span>
        </div>
        <div>
          <span className="scraper-k">Dernier scan</span>
          <span className="scraper-v">{fmtTime(s.lastScanAt)}</span>
        </div>
      </div>
      {s.lastError ? (
        <div className="scraper-err">Dernière erreur: {s.lastError}</div>
      ) : (
        <div className="scraper-err scraper-ok">Aucune erreur récente</div>
      )}
    </div>
  )
}

export default function ScraperDashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState(null)
  const [progress, setProgress] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(getApiUrl('/api/scraper/sources'))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadProgress = useCallback(async () => {
    try {
      const res = await fetch(getApiUrl('/api/scraper/status'))
      if (!res.ok) return
      setProgress(await res.json())
    } catch (_) {
      /* polling non-bloquant */
    }
  }, [])

  useEffect(() => {
    load()
    loadProgress()
    const id = setInterval(loadProgress, 4000)
    return () => clearInterval(id)
  }, [load, loadProgress])

  const runScan = async () => {
    const token = localStorage.getItem('admin_token')
    if (!token) {
      setScanMsg({
        type: 'warn',
        text: "Token admin manquant. Définissez 'admin_token' dans le localStorage pour déclencher un scan.",
      })
      return
    }
    setScanning(true)
    setScanMsg({ type: 'info', text: 'Scan en cours… (résultats + fixtures + settlement)' })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000)
    try {
      const res = await fetch(getApiUrl('/api/scraper/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setScanMsg({ type: 'warn', text: body.error || 'Un scan est déjà en cours' })
      } else if (!res.ok) {
        setScanMsg({ type: 'error', text: body.error || `HTTP ${res.status}` })
      } else {
        const r = body.result?.results
        setScanMsg({
          type: 'ok',
          text: `Scan terminé — résultats: ${r?.updated ?? 0} réglés / ${r?.fetched ?? 0} fetched`,
        })
      }
      load()
    } catch (e) {
      setScanMsg({
        type: 'error',
        text: e.name === 'AbortError' ? 'Scan trop long (5 min) — vérifiez plus tard' : e.message,
      })
    } finally {
      clearTimeout(timer)
      setScanning(false)
    }
  }

  const openProgressPopup = () => {
    const origin = window.location.origin
    window.open(`${origin}/scraper-progress`, 'scraperProgress', 'width=560,height=700')
  }

  const sources = data?.sources || {}
  const sourceNames = Object.keys(sources).sort()
  const lastScan = data?.lastScan

  return (
    <div className="scraper-dash">
      <div className="scraper-dash-head">
        <div>
          <h1 className="scraper-title">Scraper — Supervision</h1>
          <p className="scraper-sub">Sources, métriques, historique et scan manuel</p>
        </div>
        <div className="scraper-dash-actions">
          <button className="scraper-btn" onClick={openProgressPopup} disabled={loading || scanning}>
            ↗ Progression
          </button>
          <button className="scraper-btn" onClick={load} disabled={loading || scanning}>
            {loading ? '…' : '⟳ Rafraîchir'}
          </button>
          <button className="scraper-btn scraper-btn-primary" onClick={runScan} disabled={scanning}>
            {scanning ? 'Scan en cours…' : '▶ Lancer un scan'}
          </button>
        </div>
      </div>

      {scanMsg && (
        <div className={`scraper-msg scraper-msg-${scanMsg.type}`}>{scanMsg.text}</div>
      )}

      {data?.silentFailure && (
        <div className="scraper-msg scraper-msg-error">
          ⚠️ Source principale silencieuse : 0 fixture sur les derniers scans.
        </div>
      )}

      {error && <div className="scraper-msg scraper-msg-error">Erreur de chargement: {error}</div>}

      <div className="scraper-progress">
        <div className="scraper-progress-head">
          <h3>Progression du scraper (Sofascore)</h3>
          {progress?.isRunning ? (
            <span className="scraper-progress-badge scraper-progress-badge-live">● Scan en cours</span>
          ) : (
            <span className="scraper-progress-badge">Idle</span>
          )}
        </div>

        {progress && (progress.total ?? 0) > 0 ? (
          <>
            <div className="scraper-progress-bar">
              <div className="scraper-progress-fill" style={{ width: `${Math.max(0, Math.min(100, progress.percent || 0))}%` }} />
            </div>
            <div className="scraper-progress-stats">
              <div>
                <span className="scraper-k">Traités</span>
                <span className="scraper-v">{progress.done ?? 0} / {progress.total ?? 0}</span>
              </div>
              <div>
                <span className="scraper-k">Pourcentage</span>
                <span className="scraper-v">{Math.round(progress.percent || 0)}%</span>
              </div>
              <div>
                <span className="scraper-k">Erreurs</span>
                <span className="scraper-v">{progress.failed ?? 0}</span>
              </div>
              <div>
                <span className="scraper-k">Restants</span>
                <span className="scraper-v">{progress.remaining ?? 0}</span>
              </div>
            </div>
            {progress.currentTask && (
              <div className="scraper-progress-task">
                <span className="scraper-k">Match en cours</span>
                <span className="scraper-v">{progress.currentTask}</span>
                {progress.currentLeague && progress.currentLeague !== 'N/A' && (
                  <span className="scraper-progress-league">{progress.currentLeague}</span>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="scraper-sub">Aucun scan en cours.</div>
        )}
      </div>

      <div className="scraper-lastscan">
        <h3>Dernier scan</h3>
        {lastScan ? (
          <div className="scraper-lastscan-grid">
            <div>
              <span className="scraper-k">À</span>
              <span className="scraper-v">{fmtTime(lastScan.at)}</span>
            </div>
            <div>
              <span className="scraper-k">Dates</span>
              <span className="scraper-v">{lastScan.dates?.join(', ') || '—'}</span>
            </div>
            <div>
              <span className="scraper-k">Uniques</span>
              <span className="scraper-v">{lastScan.coverage?.totalUnique ?? 0}</span>
            </div>
            <div>
              <span className="scraper-k">Nouveaux</span>
              <span className="scraper-v">{lastScan.coverage?.new ?? 0}</span>
            </div>
            <div>
              <span className="scraper-k">MENA</span>
              <span className="scraper-v">{lastScan.coverage?.mena ?? 0}</span>
            </div>
          </div>
        ) : (
          <div className="scraper-sub">Aucun scan enregistré.</div>
        )}
      </div>

      <h3 className="scraper-section">Sources ({sourceNames.length})</h3>
      <div className="scraper-sources">
        {sourceNames.length === 0 && <div className="scraper-sub">Aucune source.</div>}
        {sourceNames.map((n) => (
          <SourceRow key={n} name={n} s={sources[n]} />
        ))}
      </div>

      {data?.history?.length > 0 && (
        <>
          <h3 className="scraper-section">Historique (derniers scans)</h3>
          <div className="scraper-history">
            {data.history.map((h, i) => (
              <div className="scraper-history-row" key={i}>
                <span>{fmtTime(h.at)}</span>
                <span>{h.dates?.join(', ')}</span>
                <span>U {h.coverage?.totalUnique ?? 0}</span>
                <span>+{h.coverage?.new ?? 0}</span>
                <span>MENA {h.coverage?.mena ?? 0}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
