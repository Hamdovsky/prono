import React, { useState, useEffect, useCallback } from 'react'
import { getApiUrl } from '../config/apiConfig'
import './ProPlanWidget.css'

const PICK_LABEL = { '1': '1', X: 'N', '2': '2' }

function fmtDt(v) {
  return `${Number(v || 0).toFixed(2)} DT`
}

function fmtTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

const ProPlanWidget = () => {
  const [summary, setSummary] = useState(null)
  const [daily, setDaily] = useState(null)
  const [secondary, setSecondary] = useState(null)
  const [stables, setStables] = useState(null)
  const [history, setHistory] = useState(null)
  const [tab, setTab] = useState('1X2')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [flash, setFlash] = useState(null)
  const [settlingId, setSettlingId] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    return Promise.all([
      fetch(getApiUrl('/api/plan-pro/summary')).then((r) => r.json()),
      fetch(getApiUrl('/api/plan-pro/1x2/daily')).then((r) => r.json()),
      fetch(getApiUrl('/api/plan-pro/secondary')).then((r) => r.json()),
      fetch(getApiUrl('/api/plan-pro/stables')).then((r) => r.json()),
      fetch(getApiUrl('/api/plan-pro/1x2/history')).then((r) => r.json()),
    ])
      .then(([s, d, sec, stb, h]) => {
        setSummary(s.success ? s : null)
        setDaily(d.success ? d : null)
        setSecondary(sec.success ? sec : null)
        setStables(stb.success ? stb : null)
        setHistory(h.success ? h : null)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const settle = (pick, result) => {
    setSettlingId(`${pick.matchId}_${result}`)
    fetch(getApiUrl('/api/plan-pro/1x2/settle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchId: pick.matchId,
        home: pick.homeTeam,
        away: pick.awayTeam,
        league: pick.leagueName,
        pick: pick.recommendedPick,
        odds: pick.odds,
        prob: pick.modelProbability,
        edge: pick.edgePct,
        result,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.success) {
          setFlash({
            msg: `${result === 'WON' ? '✅ Gagné' : result === 'LOST' ? '❌ Perdu' : '➖ Nul'} → bankroll ${fmtDt(d.bankroll)}`,
            type: result === 'WON' ? 'win' : result === 'LOST' ? 'loss' : 'push',
          })
          load()
        } else {
          setFlash({ msg: d?.error || 'Erreur lors du règlement', type: 'error' })
        }
      })
      .catch(() => setFlash({ msg: 'Échec réseau du règlement', type: 'error' }))
      .finally(() => setSettlingId(null))
  }

  const st = summary?.state
  const tier = summary?.tier
  const pct = Math.round((summary?.progression || 0) * 100)
  const remaining = summary?.remainingToTarget

  const renderBankroll = (
    <section className="ppw-bankroll">
      <div className="ppw-br-head">
        <div>
          <h3 className="ppw-br-title">💰 Plan Pro 1X2</h3>
          <span className="ppw-br-sub">Objectif : 100 DT → 400 DT (x4)</span>
        </div>
        <div className="ppw-br-value">
          <span className="ppw-br-amount">{st ? fmtDt(st.bankroll) : '—'}</span>
          <span className={`ppw-br-tier tier-${tier?.label || 'na'}`}>{tier?.label || '…'}</span>
        </div>
      </div>
      <div className="ppw-gauge">
        <div className="ppw-gauge-track">
          <div className="ppw-gauge-fill" style={{ width: `${pct}%` }} />
          <span className="ppw-gauge-mark start">100 DT</span>
          <span className="ppw-gauge-mark end">400 DT</span>
        </div>
        <div className="ppw-gauge-meta">
          <span>{pct}% vers l'objectif</span>
          <span>reste {remaining != null ? fmtDt(Math.max(remaining, 0)) : '—'}</span>
        </div>
      </div>
      {st?.paused && (
        <div className="ppw-pause">
          ⏸️ Pause de sécurité : stop-loss atteint (≤ 80 DT). Reprise le{' '}
          {st.pausedUntil ? fmtTime(st.pausedUntil) : ''}.
        </div>
      )}
      {st && st.bankroll >= summary.target && (
        <div className="ppw-target">
          🎯 Objectif atteint ! Retirez 300 DT et repartez de 100 DT.
        </div>
      )}
      <div className="ppw-stats">
        <div className="ppw-stat">
          <span className="ppw-stat-label">Parlays</span>
          <span className="ppw-stat-value">{history?.count ?? 0}</span>
        </div>
        <div className="ppw-stat">
          <span className="ppw-stat-label">Victoires</span>
          <span className="ppw-stat-value">{summary?.stats?.wins ?? 0}</span>
        </div>
        <div className="ppw-stat">
          <span className="ppw-stat-label">Défaites</span>
          <span className="ppw-stat-value">{summary?.stats?.losses ?? 0}</span>
        </div>
        <div className="ppw-stat">
          <span className="ppw-stat-label">P&L</span>
          <span className="ppw-stat-value">{summary?.stats?.totalPnl != null ? fmtDt(summary.stats.totalPnl) : '—'}</span>
        </div>
        <div className="ppw-stat">
          <span className="ppw-stat-label">ROI</span>
          <span className="ppw-stat-value">
            {summary?.stats?.roi != null ? `${summary.stats.roi.toFixed(1)}%` : '—'}
          </span>
        </div>
      </div>
      <div className="ppw-rules">
        <span>🛡️ Quarter-Kelly ×0.25, plafonné au palier</span>
        <span>🚫 stop-loss ≤ 80 DT → pause 7 j</span>
        <span>📈 paliers 1% / 2% / 3% / 4%</span>
      </div>
    </section>
  )

  const renderTabs = (
    <div className="ppw-tabs">
      <button className={`ppw-tab ${tab === '1X2' ? 'active' : ''}`} onClick={() => setTab('1X2')}>
        🎯 1X2 (pur)
      </button>
      <button className={`ppw-tab ${tab === 'Over 2.5' ? 'active' : ''}`} onClick={() => setTab('Over 2.5')}>
        ⚽ O/U 2.5
      </button>
      <button className={`ppw-tab ${tab === 'BTTS' ? 'active' : ''}`} onClick={() => setTab('BTTS')}>
        🤝 BTTS
      </button>
      <button className={`ppw-tab ${tab === 'Stables' ? 'active' : ''}`} onClick={() => setTab('Stables')}>
        🛡️ Stables (DC)
      </button>
    </div>
  )

  const renderPicks = (picks) => {
    if (!picks || picks.length === 0) {
      return (
        <div className="ppw-empty">
          🛡️ Aucun pick ne passe la discipline aujourd'hui — attendre les prochaines journées.
        </div>
      )
    }
    return (
      <div className="ppw-picks">
        {picks.map((pick, i) => (
          <article key={`${pick.matchId}_${pick.marketType || pick.recommendedPick}_${i}`} className="ppw-card">
            <div className="ppw-card-top">
              <span className="ppw-league">{pick.leagueName}</span>
              <span className="ppw-time">{fmtTime(pick.matchTime)}</span>
            </div>
            <div className="ppw-teams">
              <span className="ppw-team">{pick.homeTeam}</span>
              <span className="ppw-vs">VS</span>
              <span className="ppw-team">{pick.awayTeam}</span>
            </div>
            <div className="ppw-badges">
              <span className="ppw-badge ppw-badge-pick">🎯 {PICK_LABEL[pick.recommendedPick] || pick.recommendedPick}</span>
              <span className="ppw-badge ppw-badge-market">{pick.marketType}</span>
              <span className="ppw-badge ppw-badge-ev">+{Number(pick.edgePct).toFixed(1)}% EV</span>
            </div>
            <div className="ppw-card-stats">
              <span>@{Number(pick.odds).toFixed(2)}</span>
              <span>{Number(pick.modelProbability).toFixed(0)}%</span>
              <span className="ppw-stake">mise {fmtDt(pick.stakeDt)}</span>
            </div>
            {tab === '1X2' && (
              <div className="ppw-actions">
                <button
                  className="ppw-btn win"
                  disabled={!!settlingId}
                  onClick={() => settle(pick, 'WON')}
                >
                  Gagné
                </button>
                <button
                  className="ppw-btn push"
                  disabled={!!settlingId}
                  onClick={() => settle(pick, 'PUSH')}
                >
                  Nul
                </button>
                <button
                  className="ppw-btn loss"
                  disabled={!!settlingId}
                  onClick={() => settle(pick, 'LOST')}
                >
                  Perdu
                </button>
              </div>
            )}
            {tab === 'Stables' && (
              <div className="ppw-actions">
                <button
                  className="ppw-btn win"
                  disabled={!!settlingId}
                  onClick={() => settle(pick, 'WON')}
                >
                  Gagné
                </button>
                <button
                  className="ppw-btn loss"
                  disabled={!!settlingId}
                  onClick={() => settle(pick, 'LOST')}
                >
                  Perdu
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    )
  }

  const renderBody = () => {
    if (tab === '1X2') return renderPicks(daily?.picks)
    if (tab === 'Over 2.5') return renderPicks(secondary?.grouped?.['Over 2.5'])
    if (tab === 'BTTS') return renderPicks(secondary?.grouped?.BTTS)
    return renderPicks(stables?.picks)
  }

  const renderHistory = (
    <section className="ppw-history">
      <h4 className="ppw-history-title">🧾 Historique du plan</h4>
      {!history || history.bets.length === 0 ? (
        <p className="ppw-empty">Aucun règlement pour l'instant.</p>
      ) : (
        <div className="ppw-history-list">
          {history.bets.slice(0, 12).map((b) => (
            <div key={b.id} className="ppw-hrow">
              <span className={`ppw-hresult ${String(b.result).toLowerCase()}`}>{b.result}</span>
              <span className="ppw-hpick">
                {b.home} vs {b.away}
              </span>
              <span className="ppw-hmeta">
                {PICK_LABEL[b.pick] || b.pick} @{Number(b.odds).toFixed(2)}
              </span>
              <span className="ppw-hpnl">
                {Number(b.pnl_dt) >= 0 ? '+' : ''}
                {fmtDt(b.pnl_dt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )

  return (
    <div className="ppw-container">
      {flash && (
        <div className={`ppw-flash ${flash.type}`} onClick={() => setFlash(null)}>
          {flash.msg}
        </div>
      )}

      {loading && (
        <div className="ppw-state">
          <div className="ppw-loader" />
          <p>Chargement du Plan Pro…</p>
        </div>
      )}

      {!loading && error && (
        <div className="ppw-state ppw-state-error">
          <span>⚠️</span>
          <p>Connexion au Plan Pro interrompue.</p>
          <button className="ppw-retry" onClick={load}>
            Réessayer
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          {renderBankroll}
          {renderTabs}
          {renderBody()}
          {renderHistory}
          <button className="ppw-refresh" onClick={load}>
            🔄 Actualiser
          </button>
        </>
      )}
    </div>
  )
}

export default ProPlanWidget
