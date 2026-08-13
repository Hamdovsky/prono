import React, { useState, useEffect, useCallback, useRef } from 'react'
import './ModelTraining.css'
import { getAdminToken, setAdminToken, clearAdminToken } from '../utils/adminAuth'

const TRAIN_API = '/api/training'

const MODEL_COLORS = {
  v24: '#3b82f6',
  v56: '#8b5cf6',
  live: '#ef4444',
  promosport: '#10b981',
  titanium: '#f59e0b',
  corners: '#06b6d4',
  cards: '#ec4899',
}

export default function ModelTraining() {
  const [models, setModels] = useState([])
  const [trainStatus, setTrainStatus] = useState({
    running: false,
    type: null,
    lastResult: null,
    log: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [diag, setDiag] = useState(null)
  const [askToken, setAskToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const logEndRef = useRef(null)

  const fetchAll = useCallback(async () => {
    try {
      const [mRes, sRes] = await Promise.all([
        fetch(`${TRAIN_API}/models`),
        fetch(`${TRAIN_API}/status`),
      ])
      if (mRes.ok) {
        const j = await mRes.json()
        if (j.success) setModels(j.models)
      }
      if (sRes.ok) {
        const j = await sRes.json()
        if (j.success) setTrainStatus(j)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    const i = setInterval(fetchAll, 3000)
    return () => clearInterval(i)
  }, [fetchAll])
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [trainStatus.log])

  const handleRetrain = async (type) => {
    try {
      const r = await fetch(`${TRAIN_API}/retrain/${type}`, { method: 'POST' })
      const j = await r.json()
      if (!j.success) setError(j.error || 'Erreur')
    } catch (e) {
      setError(e.message)
    }
  }

  const confirmToken = () => {
    if (!tokenInput.trim()) return
    setAdminToken(tokenInput)
    setTokenInput('')
    setAskToken(false)
    fetchDiag()
  }

  const fetchDiag = async () => {
    const token = getAdminToken()
    if (!token) {
      setAskToken(true)
      return
    }
    try {
      const r = await fetch('/api/promosport/diagnostic', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.status === 401 || r.status === 403) {
        clearAdminToken()
        setError('Token invalide — ressaisissez-le.')
        setAskToken(true)
        return
      }
      const j = await r.json()
      setDiag(j)
    } catch (e) {
      setError(e.message)
    }
  }

  const formatDate = (d) => {
    if (!d) return '—'
    const date = new Date(d)
    return date.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  if (loading) return <div className="mt-loader">Chargement...</div>

  return (
    <div className="mt-container">
      <div className="mt-header">
        <div>
          <h1>🧠 Entraînement des Modèles</h1>
          <p>Gère et lance les retrains de tous les modèles Titanium AI</p>
        </div>
        <button className="mt-btn mt-btn-secondary" onClick={fetchDiag}>
          🔍 Diagnostic Python
        </button>
      </div>

      {error && (
        <div className="mt-error">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {askToken && (
        <div
          style={{
            marginBottom: 16,
            padding: '10px 14px',
            borderRadius: 8,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.3)',
          }}
        >
          <div
            style={{
              color: '#fbbf24',
              fontWeight: 600,
              fontSize: '0.8rem',
              marginBottom: 8,
            }}
          >
            🔐 Token d'administration requis pour le diagnostic
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmToken()
              }}
              placeholder="API Secret Key"
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: '0.8rem',
                background: '#0f172a',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 6,
                color: '#e2e8f0',
                outline: 'none',
              }}
            />
            <button className="mt-btn mt-btn-secondary" onClick={confirmToken}>
              OK
            </button>
          </div>
        </div>
      )}

      {trainStatus.running && (
        <div className="mt-banner-running">
          <span className="mt-pulse-dot" /> Retrain en cours : <strong>{trainStatus.type}</strong>
        </div>
      )}

      {diag && (
        <div className="mt-diag">
          <h3>Diagnostic Python</h3>
          <div className="mt-diag-grid">
            <div>
              Python:{' '}
              <span style={{ color: diag.python ? '#3fb950' : '#f85149' }}>
                {diag.python || '❌'}
              </span>
            </div>
            <div>
              Pip:{' '}
              <span style={{ color: diag.pip ? '#3fb950' : '#f85149' }}>{diag.pip || '❌'}</span>
            </div>
            {Object.entries(diag.deps || {})
              .slice(0, 8)
              .map(([k, v]) => (
                <div key={k}>
                  {k}: <span style={{ color: v ? '#3fb950' : '#f85149' }}>{v || '❌'}</span>
                </div>
              ))}
          </div>
          <button
            className="mt-btn mt-btn-secondary"
            style={{ marginTop: 8 }}
            onClick={() => setDiag(null)}
          >
            Fermer
          </button>
        </div>
      )}

      <div className="mt-grid">
        {models
          .filter((m) => m.exists)
          .map((model) => {
            const color = MODEL_COLORS[model.id] || '#6366f1'
            const isTraining = trainStatus.running && trainStatus.type === model.id
            return (
              <div
                key={model.id}
                className={`mt-card ${isTraining ? 'training' : ''}`}
                style={{ borderLeftColor: color }}
              >
                <div className="mt-card-header">
                  <h3>{model.name}</h3>
                  <span className="mt-badge" style={{ background: `${color}22`, color }}>
                    {model.id}
                  </span>
                </div>
                <div className="mt-card-stats">
                  <div>
                    <span className="mt-label">Taille</span>
                    <span className="mt-value">{model.sizeKB} KB</span>
                  </div>
                  <div>
                    <span className="mt-label">Dernier entraînement</span>
                    <span className="mt-value">{formatDate(model.modifiedAt)}</span>
                  </div>
                  <div>
                    <span className="mt-label">Fichier</span>
                    <span className="mt-value mt-file">{model.file}</span>
                  </div>
                  <div>
                    <span className="mt-label">CRON</span>
                    <span className="mt-value">{model.cron}</span>
                  </div>
                </div>
                <button
                  className={`mt-btn mt-btn-retrain ${isTraining ? 'disabled' : ''}`}
                  disabled={isTraining}
                  onClick={() => handleRetrain(model.id)}
                  style={{ background: color }}
                >
                  {isTraining ? '⏳ En cours...' : '🔄 Lancer le retrain'}
                </button>
              </div>
            )
          })}
        {models
          .filter((m) => !m.exists)
          .map((model) => (
            <div key={model.id} className="mt-card mt-card-missing">
              <div className="mt-card-header">
                <h3>{model.name}</h3>
                <span className="mt-badge" style={{ background: '#334155', color: '#64748b' }}>
                  {model.id}
                </span>
              </div>
              <div className="mt-card-stats">
                <div>
                  <span className="mt-label">Statut</span>
                  <span className="mt-value" style={{ color: '#f87171' }}>
                    Fichier manquant
                  </span>
                </div>
              </div>
            </div>
          ))}
      </div>

      {trainStatus.running && (
        <div className="mt-log">
          <h3>📋 Log du retrain en cours</h3>
          <div className="mt-log-box">
            {trainStatus.log.map((line, i) => (
              <div key={i} className={`mt-log-line ${line.startsWith('[SYSTEM]') ? 'system' : ''}`}>
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {trainStatus.lastResult && !trainStatus.running && (
        <div className={`mt-result ${trainStatus.lastResult.success ? 'success' : 'fail'}`}>
          <h3>{trainStatus.lastResult.success ? '✅ Retrain réussi' : '❌ Retrain échoué'}</h3>
          {trainStatus.lastResult.success &&
            trainStatus.lastResult.steps?.map((s, i) => (
              <div key={i} className="mt-result-step">
                <strong>{s.step}</strong>
                {s.accuracy && <span>Accuracy: {s.accuracy}%</span>}
                {s.logLoss && <span>Log Loss: {s.logLoss}</span>}
                {s.output && <span className="mt-result-out">{s.output}</span>}
              </div>
            ))}
          {!trainStatus.lastResult.success && (
            <p className="mt-result-error">{trainStatus.lastResult.error}</p>
          )}
          {trainStatus.lastResult.finishedAt && (
            <p className="mt-result-time">
              Terminé le {formatDate(trainStatus.lastResult.finishedAt)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
