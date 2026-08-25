import React, { useState, useEffect, useCallback } from 'react'
import { getApiUrl } from '../config/apiConfig'
import './TopPicksWidget.css'

const PICK_LABEL = {
  '1X2': { '1': '1', X: 'N', '2': '2' },
  'Over 2.5': { 'Over 2.5': 'O2.5', 'Under 2.5': 'U2.5' },
  BTTS: { Oui: 'OUI', Non: 'NON' },
}

const MARKET_ICON = {
  '1X2': '🎯',
  'Over 2.5': '⚽',
  BTTS: '🤝',
}

function formatTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('fr-FR', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
} catch {
      return ''
    }
}

const TopPicksWidget = () => {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [openId, setOpenId] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    fetch(getApiUrl('/api/top-picks/daily'))
      .then((r) => r.json())
      .then((d) => {
        if (d && d.success) setData(d)
        else setData(null)
      })
      .catch(() => {
        setError(true)
        setData(null)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const toggleInsight = (id) => setOpenId((cur) => (cur === id ? null : id))

  return (
    <div className="tpw-container">
      <header className="tpw-header">
        <div className="tpw-title-row">
          <h2 className="tpw-title">🔥 Top Picks du Jour</h2>
          {data && data.count > 0 && <span className="tpw-count">{data.count} picks</span>}
        </div>
        <p className="tpw-subtitle">
          Sélection stricte : Edge ≥ +5% • EV ≥ +5% • Proba calibrée 55-75% • Guards sécurité
        </p>
      </header>

      {loading && (
        <div className="tpw-state">
          <div className="tpw-loader" />
          <p>Analyse des matchs du jour…</p>
        </div>
      )}

      {!loading && error && (
        <div className="tpw-state tpw-state-error">
          <span className="tpw-state-icon">⚠️</span>
          <p>Connexion au moteur Top Picks interrompue.</p>
          <button className="tpw-retry" onClick={load}>
            Réessayer
          </button>
        </div>
      )}

      {!loading && !error && data && data.count === 0 && (
        <div className="tpw-state tpw-state-empty">
          <span className="tpw-state-icon">🛡️</span>
          <p className="tpw-empty-ar">
            لا توجد قيم عالية (+EV) متطابقة مع شروط الأمان اليوم. نوصي بانتظار المباريات القادمة.
          </p>
          <p className="tpw-empty-fr">
            Aucune valeur (+EV) ne passe les filtres de sécurité aujourd'hui — nous recommandons
            d'attendre les prochaines journées.
          </p>
          <button className="tpw-retry" onClick={load}>
            🔄 Actualiser
          </button>
        </div>
      )}

      {!loading && !error && data && data.count > 0 && (
        <div className="tpw-grid">
          {data.picks.map((pick, i) => {
            const pickLabel = PICK_LABEL[pick.marketType]?.[pick.recommendedPick] ?? pick.recommendedPick
            const icon = MARKET_ICON[pick.marketType] || '🎯'
            const isOpen = openId === i
            return (
              <article key={`${pick.matchId}_${pick.marketType}`} className="tpw-card">
                <div className="tpw-card-top">
                  <span className="tpw-league">
                    {icon} {pick.leagueName}
                  </span>
                  <span className="tpw-time">{formatTime(pick.matchTime)}</span>
                </div>

                <div className="tpw-teams">
                  <div className="tpw-team">
                    <span className="tpw-team-dot home" />
                    <span className="tpw-team-name">{pick.homeTeam}</span>
                  </div>
                  <div className="tpw-vs">VS</div>
                  <div className="tpw-team">
                    <span className="tpw-team-name">{pick.awayTeam}</span>
                    <span className="tpw-team-dot away" />
                  </div>
                </div>

                <div className="tpw-badges">
                  <span className="tpw-badge tpw-badge-pick">
                    🎯 {pickLabel}
                  </span>
                  <span className="tpw-badge tpw-badge-market">{pick.marketType}</span>
                  <span className="tpw-badge tpw-badge-ev">
                    +{Number(pick.edgePct).toFixed(1)}% EV
                  </span>
                </div>

                <div className="tpw-stats">
                  <div className="tpw-stat">
                    <span className="tpw-stat-label">Cote</span>
                    <span className="tpw-stat-value">@{Number(pick.odds).toFixed(2)}</span>
                  </div>
                  <div className="tpw-stat">
                    <span className="tpw-stat-label">Proba modèle</span>
                    <span className="tpw-stat-value">{Number(pick.modelProbability).toFixed(0)}%</span>
                  </div>
                  <div className="tpw-stat">
                    <span className="tpw-stat-label">Mise (Kelly)</span>
                    <span className="tpw-stat-value">{pick.stakeRecommendation}</span>
                  </div>
                </div>

                <button
                  className={`tpw-insight-toggle ${isOpen ? 'open' : ''}`}
                  onClick={() => toggleInsight(i)}
                >
                  {isOpen ? '▾ Masquer le raisonnement' : '▸ 💡 Pourquoi ce pick ?'}
                </button>
                {isOpen && <div className="tpw-insight">{pick.reasoningSummary}</div>}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default TopPicksWidget
