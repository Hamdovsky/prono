import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { AreaChartSVG, RadarChartSVG } from './MiniChart'
import { getApiUrl } from '../config/apiConfig'
import './AccuracyDashboard.css'

function getAccColor(pct) {
  if (pct === null || pct === undefined) return '#444'
  if (pct >= 70) return '#10b981'
  if (pct >= 55) return '#f59e0b'
  return '#ef4444'
}

const AUTOPSY_COLORS = {
  XG_WASTE: '#f59e0b',
  GK_WALL: '#3b82f6',
  LATE_GOAL: '#8b5cf6',
  PERSONNEL_DEFICIT_DISRUPTION: '#ef4444',
  SYSTEMIC_DEFENSIVE_FAILURE: '#dc2626',
  BIG_CHANCE_WASTE: '#f97316',
  EARLY_TACTICAL_DISRUPTION: '#06b6d4',
  SET_PIECE_DECIDER: '#10b981',
  SHOT_DOMINANCE: '#a855f7',
  CORNER_DOMINANCE: '#ec4899',
  LOW_INTENSITY_OFFENSE: '#64748b',
  POSSESSION_FAIL: '#84cc16',
  UNKNOWN: '#374151',
}

const SurgicalAutopsy = ({ data }) => {
  if (!data || !data.surgicalStats) return null
  const stats = data.surgicalStats
  const chartData = [
    {
      subject: 'xG',
      A: 100,
      B: Math.min(150, (stats.expectedGoals.home + stats.expectedGoals.away) * 40),
      fullMark: 150,
    },
    {
      subject: 'SoT',
      A: 100,
      B: Math.min(150, (stats.shotsOnTarget.home + stats.shotsOnTarget.away) * 15),
      fullMark: 150,
    },
    {
      subject: 'Poss',
      A: 100,
      B: Math.max(stats.possession.home, stats.possession.away) * 2,
      fullMark: 150,
    },
    {
      subject: 'Corners',
      A: 100,
      B: Math.min(150, (stats.corners.home + stats.corners.away) * 10),
      fullMark: 150,
    },
    {
      subject: 'Chances',
      A: 100,
      B: Math.min(150, (stats.bigChances.home + stats.bigChances.away) * 30),
      fullMark: 150,
    },
  ]
  return (
    <div className="surgical-report animate-in">
      <div className="surgical-grid">
        <div className="surgical-radar">
          <RadarChartSVG data={chartData} height={220} color="#ef4444" />
        </div>
        <div className="surgical-details">
          <h5 className="surgical-title">🔬 Chronologie de l'échec tactique</h5>
          <div className="surgical-timeline">
            {(data.criticalIncidents?.length > 0 ? data.criticalIncidents : []).map((inc, idx) => (
              <div key={idx} className="timeline-item">
                <span className="timeline-time">{inc.time}'</span>
                <span className="timeline-icon">
                  {(inc.type || inc.incidentClass || '').toLowerCase().includes('goal')
                    ? '⚽'
                    : (inc.type || inc.incidentClass || '').toLowerCase().includes('card')
                      ? '🟥'
                      : '🎯'}
                </span>
                <span className="timeline-text">
                  {inc.isHome ? '🏠' : '✈️'} {inc.text || inc.incidentClass}
                </span>
              </div>
            )) || <div className="acc-empty">Aucun incident critique.</div>}
          </div>
        </div>
      </div>
      <div className="surgical-footer">
        <span className="surgical-badge">VERDICT CLINIQUE: {data.autopsy?.type || 'INCONNU'}</span>
        <p className="surgical-tip">
          💡 Ce type d'échec est récurrent dans cette ligue. Envisage un pari Double Chance.
        </p>
      </div>
    </div>
  )
}

const KpiCard = ({ label, value, color }) => (
  <div className="acc-kpi" style={{ '--kpi-color': color || '#6366f1' }}>
    <div className="acc-kpi-value">{value}</div>
    <div className="acc-kpi-label">{label}</div>
  </div>
)

const MiniTable = ({ data, columns, emptyMsg = 'Aucune donnée' }) => {
  if (!data || data.length === 0) return <div className="acc-empty">{emptyMsg}</div>
  return (
    <div className="acc-table-wrap">
      <table className="acc-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: c.align || 'left' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={row.id || i}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  style={{
                    textAlign: c.align || 'left',
                    color: c.color
                      ? typeof c.color === 'function'
                        ? c.color(row)
                        : c.color
                      : undefined,
                    fontWeight: c.bold ? 700 : undefined,
                  }}
                >
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AccuracyDashboard() {
  const [log, setLog] = useState(null)
  const [perf, setPerf] = useState(null)
  const [tracker, setTracker] = useState(null)
  const [autopsyData, setAutopsyData] = useState(null)
  const [honest, setHonest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [expandedMiss, setExpandedMiss] = useState(null)

  const fetchAll = useCallback(async () => {
    try {
      const [accRes, perfRes, trackerRes, autopsyRes, honestRes] = await Promise.all([
        fetch(getApiUrl('/api/accuracy')),
        fetch(getApiUrl('/api/analytics/performance')),
        fetch(getApiUrl('/api/accuracy/tracker')),
        fetch(getApiUrl('/api/autopsy/report')).catch(() => null),
        fetch(getApiUrl('/api/accuracy/report')).catch(() => null),
      ])
      if (accRes.ok) setLog(await accRes.json())
      if (perfRes.ok) setPerf(await perfRes.json())
      if (trackerRes.ok) setTracker(await trackerRes.json())
      if (autopsyRes?.ok) setAutopsyData(await autopsyRes.json())
      if (honestRes?.ok) setHonest(await honestRes.json())
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const runNow = async () => {
    setRunning(true)
    try {
      const res = await fetch(getApiUrl('/api/accuracy/run'), { method: 'POST' })
      const data = await res.json()
      if (data.success) await fetchAll()
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const entries = useMemo(() => log?.entries || [], [log])
  const last30 = useMemo(() => [...entries].slice(0, 30).reverse(), [entries])

  if (loading) return <div className="acc-loader">Chargement...</div>

  const tabs = [
    { id: 'overview', label: "📊 Vue d'ensemble" },
    { id: 'leagues', label: '🏆 Par ligue' },
    { id: 'confidence', label: '🎯 Par confiance' },
    { id: 'markets', label: '📊 Par marché' },
    { id: 'trend', label: '📈 Tendance' },
    { id: 'autopsy', label: '🔬 Autopsie' },
  ]

  return (
    <div className="acc-dashboard">
      <div className="acc-header">
        <div className="acc-header-title">
          <span className="acc-icon">🧪</span>
          <div>
            <h1>Analyse de Précision & Performance</h1>
            <p>Précision des pronostics · {entries.length} jours de données</p>
          </div>
        </div>
        <button
          className={`acc-run-btn ${running ? 'running' : ''}`}
          onClick={runNow}
          disabled={running}
        >
          {running ? 'Analyse...' : '▶ Actualiser'}
        </button>
      </div>

      {error && <div className="acc-error">{error}</div>}

      <div className="acc-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`acc-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {activeTab === 'overview' && (
        <div>
          <div className="acc-kpis">
            <KpiCard label="Matchs réglés" value={perf?.total_settled || 0} color="#94a3b8" />
            <KpiCard label="Gagnés" value={perf?.won || 0} color="#10b981" />
            <KpiCard label="Perdus" value={perf?.lost || 0} color="#ef4444" />
            <KpiCard
              label="Win Rate"
              value={`${perf?.win_rate || 0}%`}
              color={getAccColor(perf?.win_rate)}
            />
            <KpiCard
              label="ROI"
              value={`${perf?.roi_percent >= 0 ? '+' : ''}${perf?.roi_percent || 0}%`}
              color={perf?.roi_percent >= 0 ? '#10b981' : '#ef4444'}
            />
            <KpiCard
              label="Profit"
              value={`${perf?.profit_units >= 0 ? '+' : ''}${perf?.profit_units || 0}u`}
              color={perf?.profit_units >= 0 ? '#10b981' : '#ef4444'}
            />
            <KpiCard
              label="Précision globale"
              value={`${tracker?.winRate || 0}%`}
              color={getAccColor(tracker?.winRate)}
            />
            <KpiCard label="Total analysé" value={tracker?.total || 0} color="#6366f1" />
          </div>

          {/* ── VÉRITÉ TERRAIN (métrique honnête /api/accuracy/report) ── */}
          {honest?.latest && (
            <div className="acc-chart-card">
              <h3>🩸 Vérité terrain — précision réelle sur prédictions réglées</h3>
              <div className="acc-kpis">
                <KpiCard
                  label="Précision réelle"
                  value={`${honest.latest.overall?.accuracy ?? '—'}%`}
                  color={getAccColor(honest.latest.overall?.accuracy)}
                />
                <KpiCard
                  label="Best pick"
                  value={`${honest.latest.overall?.bestPickAccuracy ?? '—'}%`}
                  color={getAccColor(honest.latest.overall?.bestPickAccuracy)}
                />
                <KpiCard
                  label="Edge vs cotes"
                  value={`${honest.latest.overall?.edge ?? '—'}%`}
                  color={(honest.latest.overall?.edge || 0) >= 0 ? '#10b981' : '#ef4444'}
                />
                <KpiCard
                  label="Confiance moyenne"
                  value={`${honest.latest.overall?.avgConfidence ?? '—'}%`}
                  color="#94a3b8"
                />
                <KpiCard
                  label="Matchs évalués"
                  value={honest.latest.totalMatches ?? honest.latest.overall?.matches ?? 0}
                  color="#6366f1"
                />
              </div>
              {honest.latest.bracketAccuracy && (
                <MiniTable
                  data={Object.entries(honest.latest.bracketAccuracy).map(([bracket, v]) => ({
                    bracket,
                    accuracy: v.accuracy,
                    count: v.count,
                  }))}
                  emptyMsg="Aucun bracket."
                  columns={[
                    { key: 'bracket', label: 'Bracket', bold: true },
                    {
                      key: 'accuracy',
                      label: 'Précision réelle',
                      align: 'center',
                      color: (r) => getAccColor(r.accuracy),
                      render: (r) => `${r.accuracy}%`,
                    },
                    { key: 'count', label: 'n', align: 'center', color: '#94a3b8' },
                  ]}
                />
              )}
              <p style={{ fontSize: 10, color: '#64748b', marginTop: 10 }}>
                Source: backtest 72h sur matchs réglés (bracket 90+% = 0% réel → les confiances
                affichées étaient sur-calibrées). La carte isotonique recalibre les nouvelles
                prédictions.
              </p>
            </div>
          )}

          {perf?.confidence_breakdown && (
            <div className="acc-chart-card">
              <h3>⚡ Force du pronostic — Décomposition</h3>
              <div className="acc-breakdown-grid">
                {[
                  { key: 'base_prob', label: 'Probabilité de base', max: 40, icon: '📊' },
                  { key: 'dominance_margin', label: 'Marge de dominance', max: 30, icon: '📏' },
                  { key: 'draw_bias', label: 'Ajustement Nul', max: 5, icon: '⚖️' },
                  { key: 'bsm_quality', label: 'Qualité BSM', max: 15, icon: '🛡️' },
                  { key: 'data_quality', label: 'Qualité données', max: 10, icon: '📡' },
                  { key: 'history_bonus', label: 'Bonus historique', max: 5, icon: '📈' },
                ].map((c) => {
                  const val = perf.confidence_breakdown[c.key] ?? 0
                  const pct = Math.min(100, Math.max(0, (val / c.max) * 100))
                  const barColor =
                    val < 0
                      ? '#fb7185'
                      : val >= c.max * 0.8
                        ? '#10b981'
                        : val >= c.max * 0.5
                          ? '#38bdf8'
                          : '#64748b'
                  return (
                    <div key={c.key} className="acc-breakdown-row">
                      <div className="acc-breakdown-header">
                        <span>
                          {c.icon} {c.label}
                        </span>
                        <span style={{ color: barColor, fontWeight: 700 }}>
                          {val > 0 ? '+' : ''}
                          {val}/{c.max} pts
                        </span>
                      </div>
                      <div className="acc-breakdown-bar-bg">
                        <div
                          className="acc-breakdown-bar"
                          style={{ width: `${Math.max(0, pct)}%`, background: barColor }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {last30.length > 0 && (
            <div className="acc-chart-card">
              <h3>📈 Évolution du ROI cumulé (30 jours)</h3>
              <AreaChartSVG
                data={last30}
                xKey="date"
                yKey="cumulativeRoi"
                height={280}
                color="#10b981"
              />
            </div>
          )}
        </div>
      )}

      {/* ── LEAGUES ── */}
      {activeTab === 'leagues' && (
        <div className="acc-chart-card">
          <h3>🏆 Précision par ligue</h3>
          <MiniTable
            data={tracker?.leagues || []}
            emptyMsg="Aucune donnée ligue disponible."
            columns={[
              { key: 'league', label: 'Ligue', bold: true },
              { key: 'correct', label: 'Correct', align: 'center', color: '#10b981' },
              { key: 'wrong', label: 'Faux', align: 'center', color: '#ef4444' },
              { key: 'total', label: 'Total', align: 'center', color: '#94a3b8' },
              {
                key: 'winRate',
                label: 'Win Rate',
                align: 'center',
                color: (r) => getAccColor(r.winRate),
                render: (r) => `${r.winRate}%`,
              },
            ]}
          />
        </div>
      )}

      {/* ── CONFIDENCE ── */}
      {activeTab === 'confidence' && (
        <div className="acc-chart-card">
          <h3>🎯 Précision par bracket de confiance</h3>
          <MiniTable
            data={
              perf?.by_confidence
                ? Object.entries(perf.by_confidence).map(([k, v]) => ({ bracket: k, ...v }))
                : []
            }
            emptyMsg="Aucune donnée."
            columns={[
              { key: 'bracket', label: 'Confiance', bold: true },
              { key: 'won', label: 'Gagnés', align: 'center', color: '#10b981' },
              { key: 'lost', label: 'Perdus', align: 'center', color: '#ef4444' },
              { key: 'total', label: 'Total', align: 'center' },
              {
                key: 'win_rate',
                label: 'Win Rate',
                align: 'center',
                color: (r) => getAccColor(r.win_rate),
                render: (r) => `${r.win_rate}%`,
              },
            ]}
          />
        </div>
      )}

      {/* ── MARKETS ── */}
      {activeTab === 'markets' && (
        <div className="acc-chart-card">
          <h3>📊 Précision par type de marché</h3>
          <MiniTable
            data={
              perf?.by_market
                ? Object.entries(perf.by_market).map(([k, v]) => ({ market: k, ...v }))
                : []
            }
            emptyMsg="Aucune donnée."
            columns={[
              { key: 'market', label: 'Marché', bold: true },
              { key: 'won', label: 'Gagnés', align: 'center', color: '#10b981' },
              { key: 'lost', label: 'Perdus', align: 'center', color: '#ef4444' },
              { key: 'total', label: 'Total', align: 'center' },
              {
                key: 'win_rate',
                label: 'Win Rate',
                align: 'center',
                color: (r) => getAccColor(r.win_rate),
                render: (r) => `${r.win_rate}%`,
              },
            ]}
          />
        </div>
      )}

      {/* ── TREND ── */}
      {activeTab === 'trend' && (
        <div className="acc-chart-card">
          <h3>📈 Évolution du ROI cumulé</h3>
          <AreaChartSVG
            data={last30}
            xKey="date"
            yKey="cumulativeRoi"
            height={300}
            color="#10b981"
          />
        </div>
      )}

      {/* ── AUTOPSY ── */}
      {activeTab === 'autopsy' && (
        <div className="acc-chart-card">
          <h3>🔬 Distribution des causes d'échec</h3>
          <div className="acc-autopsy-layout">
            <div className="acc-misses-feed" style={{ width: '100%', maxHeight: '500px' }}>
              {(autopsyData?.report || []).slice(0, 30).map((m, i) => (
                <div
                  key={i}
                  className={`acc-miss-entry ${expandedMiss === m.id ? 'expanded' : ''}`}
                  onClick={() => setExpandedMiss(expandedMiss === m.id ? null : m.id)}
                >
                  <div className="acc-miss-main">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        className="acc-autopsy-dot"
                        style={{
                          background: AUTOPSY_COLORS[m.autopsy?.type] || '#6b7280',
                          margin: 0,
                        }}
                      />
                      <span className="acc-miss-teams">
                        {m.homeTeam} × {m.awayTeam}
                      </span>
                    </div>
                    <span className="acc-miss-score">{m.score}</span>
                  </div>
                  <div className="acc-miss-tactical">
                    <span className="acc-miss-icon">{m.autopsy?.icon || '⚠️'}</span>
                    <span className="acc-miss-desc">
                      {m.autopsy?.reason || 'Analyse en cours...'}
                    </span>
                  </div>
                  {expandedMiss === m.id && <SurgicalAutopsy data={m} />}
                  <div className="acc-miss-meta">
                    Confiance: {m.confidence}% · {m.prediction} · Clique pour détails
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
