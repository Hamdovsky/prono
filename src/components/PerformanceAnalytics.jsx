import React, { useMemo, useState, useCallback } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'

const BRACKETS = [
  { min: 75, max: 101, label: '> 75%', color: '#00ffaa' },
  { min: 60, max: 75, label: '60-75%', color: '#38bdf8' },
  { min: 0, max: 60, label: '< 60%', color: '#f87171' },
]

const isFinished = (m) => {
  const s = (m.status || '').toUpperCase()
  if (['NOT_STARTED', 'SCHEDULED', 'NS', ''].includes(s)) return false
  if (['IN_PLAY', 'LIVE', '1H', '2H', 'HT'].includes(s)) return false
  if (['FT', 'FINISHED', 'ENDED'].includes(s)) return true
  const sh = m.scoreHome ?? m.score?.home
  const sa = m.scoreAway ?? m.score?.away
  if (sh == null && sa == null) return false
  return !(Number(sh) === 0 && Number(sa) === 0)
}

const getScore = (m) => {
  const h = Number(m.scoreHome ?? m.score?.home)
  const a = Number(m.scoreAway ?? m.score?.away)
  if (isNaN(h) || isNaN(a)) return null
  return { h, a, total: h + a }
}

const extractPick = (m) => {
  const q = m.quant || m._quant
  if (q?.main_pick) return String(q.main_pick).toLowerCase()
  if (m.predictions?.[0]?.val) return String(m.predictions[0].val).toLowerCase()
  return String(m.prediction || '').toLowerCase()
}

const evaluatePick = (pick, { h, a, total }) => {
  if (['1x', 'dc: 1x', 'dc:1x'].includes(pick)) return h >= a
  if (['x2', 'dc: x2', 'dc:x2'].includes(pick)) return a >= h
  if (['12', 'dc: 12', 'dc:12'].includes(pick)) return h !== a
  if (pick.includes('home') || pick === '1') return h > a
  if (pick.includes('away') || pick === '2') return a > h
  if (pick.includes('draw') || pick === 'x') return h === a
  if (pick.includes('over25') || pick === 'over 2.5') return total > 2.5
  if (pick.includes('under25') || pick === 'under 2.5') return total < 2.5
  if (pick.includes('btts') || pick.includes('oui')) return h > 0 && a > 0
  return false
}

const shorten = (name) => {
  if (!name) return ''
  const parts = name.split(' ')
  return parts.length <= 2
    ? name
    : `${parts[0]} ${parts
        .slice(1)
        .map((w) => w[0] + '.')
        .join(' ')}`
}

// ── Confidence Badge ───────────────────────────────────────────

const ConfBadge = ({ value }) => {
  const v = Math.min(Math.max(value || 0, 0), 100)
  const color = v >= 75 ? '#00ffaa' : v >= 60 ? '#38bdf8' : '#f87171'
  const bg =
    v >= 75 ? 'rgba(0,255,170,0.12)' : v >= 60 ? 'rgba(56,189,248,0.12)' : 'rgba(248,113,113,0.12)'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        background: bg,
        color,
        borderRadius: '20px',
        padding: '2px 10px 2px 8px',
        fontWeight: '800',
        fontSize: '11px',
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '-0.3px',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      {v}%
    </span>
  )
}

// ── Result Dot ─────────────────────────────────────────────────

const ResultDot = ({ won }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      borderRadius: '50%',
      background: won ? 'rgba(0,255,170,0.15)' : 'rgba(248,113,113,0.15)',
      color: won ? '#00ffaa' : '#f87171',
      fontWeight: '900',
      fontSize: '9px',
    }}
  >
    {won ? 'W' : 'L'}
  </span>
)

// ── Main Component ────────────────────────────────────────────

const PerformanceAnalytics = ({ matches, onTrackRecord }) => {
  const [forceOpen, setForceOpen] = useState(false)
  const [forceData, setForceData] = useState(null)
  const [forceLoading, setForceLoading] = useState(false)
  const [forceError, setForceError] = useState(null)

  const fetchForce = useCallback(async () => {
    setForceLoading(true)
    setForceError(null)
    try {
      const r = await fetch('/api/analytics/performance')
      const j = await r.json()
      if (j.success) setForceData(j)
      else setForceError(j.error || 'Erreur')
    } catch (e) {
      setForceError(e.message)
    } finally {
      setForceLoading(false)
    }
  }, [])

  const rows = useMemo(() => {
    return matches
      .filter((m) => isFinished(m))
      .map((m) => {
        const score = getScore(m)
        if (!score) return null
        const pick = extractPick(m)
        if (!pick || ['risky bet', 'skip', 'no bet', 'null', 'undefined', ''].includes(pick))
          return null
        const won = evaluatePick(pick, score)
        const rawConf = m.v22_success_rate ?? m.enriched?.v22_success_rate ?? m.confidence ?? 50
        const conf = rawConf > 1 ? rawConf : rawConf * 100
        return {
          id: m.id,
          home: shorten(m.homeTeam || ''),
          away: shorten(m.awayTeam || ''),
          league: (m.league || '').split(' ').slice(0, 2).join(' '),
          pick: pick.toUpperCase(),
          won,
          conf: Math.round(conf),
          score: `${score.h}-${score.a}`,
        }
      })
      .filter(Boolean)
      .slice(-50)
  }, [matches])

  // aggregate stats for the header bar
  const stats = useMemo(() => {
    const total = rows.length
    const wins = rows.filter((r) => r.won).length
    return {
      total,
      wins,
      losses: total - wins,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
    }
  }, [rows])

  // ── render ──────────────────────────────────────────────────

  return (
    <div style={{ marginBottom: 14 }}>
      {/* ── header bar ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          marginBottom: 10,
          background: 'rgba(15,23,42,0.6)',
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.8px' }}>
            📊 ANALYTICS
          </span>
          {stats.total > 0 && (
            <span style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8' }}>
              {stats.wins}W / {stats.losses}L
              <span
                style={{
                  color:
                    stats.winRate >= 60 ? '#00ffaa' : stats.winRate >= 50 ? '#fbbf24' : '#f87171',
                  marginLeft: 6,
                }}
              >
                ({stats.winRate}%)
              </span>
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {onTrackRecord && (
            <button
              onClick={onTrackRecord}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                border: '1px solid rgba(139,92,246,0.25)',
                background: 'rgba(139,92,246,0.08)',
                color: '#a78bfa',
                fontWeight: 700,
                fontSize: 9,
                cursor: 'pointer',
                letterSpacing: '0.5px',
              }}
            >
              📋 HISTORIQUE
            </button>
          )}
          <button
            onClick={() => {
              setForceOpen(true)
              fetchForce()
            }}
            style={{
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid rgba(249,115,22,0.25)',
              background: 'rgba(249,115,22,0.08)',
              color: '#fb923c',
              fontWeight: 700,
              fontSize: 9,
              cursor: 'pointer',
              letterSpacing: '0.5px',
            }}
          >
            🔬 FORCE ANALYSIS
          </button>
        </div>
      </div>

      {/* ── empty state ── */}
      {rows.length === 0 && (
        <div
          style={{
            padding: '20px 0',
            textAlign: 'center',
            color: '#334155',
            fontSize: 11,
            border: '1px dashed rgba(255,255,255,0.05)',
            borderRadius: 10,
          }}
        >
          En attente de résultats…
        </div>
      )}

      {/* ── match rows ── */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '5px 10px',
                borderRadius: 6,
                background: 'rgba(0,0,0,0.25)',
              }}
            >
              <ResultDot won={r.won} />
              <span
                style={{
                  flex: 1,
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#cbd5e1',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ color: '#64748b', fontWeight: 500 }}>[{r.league}]</span> {r.home} vs{' '}
                {r.away}
              </span>
              <span
                style={{
                  fontWeight: 900,
                  fontSize: 11,
                  color: '#f1f5f9',
                  minWidth: 28,
                  textAlign: 'center',
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: 4,
                  padding: '1px 6px',
                }}
              >
                {r.pick}
              </span>
              <span style={{ minWidth: 40, textAlign: 'right' }}>{r.score}</span>
              <ConfBadge value={r.conf} />
            </div>
          ))}
        </div>
      )}

      {/* ── FORCE ANALYSIS MODAL ── */}
      {forceOpen && (
        <div
          onClick={() => setForceOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 700,
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              background: '#0b1120',
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.06)',
              padding: 20,
              position: 'relative',
            }}
          >
            <button
              onClick={() => setForceOpen(false)}
              style={{
                position: 'absolute',
                top: 12,
                right: 16,
                background: 'none',
                border: 'none',
                color: '#475569',
                fontSize: 18,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>

            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                color: '#2d3f56',
                letterSpacing: '1.5px',
                marginBottom: 14,
              }}
            >
              🔬 FORCE ANALYSIS — RÉSULTATS SERVEUR
            </div>

            {forceLoading && (
              <div style={{ textAlign: 'center', padding: 30, color: '#64748b', fontSize: 12 }}>
                Chargement…
              </div>
            )}
            {forceError && (
              <div style={{ textAlign: 'center', padding: 30, color: '#f87171', fontSize: 12 }}>
                ❌ {forceError}
              </div>
            )}

            {forceData && (
              <>
                {/* KPI cards */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 8,
                    marginBottom: 16,
                  }}
                >
                  {[
                    { label: 'Réglés', value: forceData.total_settled, color: '#94a3b8' },
                    {
                      label: 'Win Rate',
                      value: `${forceData.win_rate}%`,
                      color: forceData.win_rate >= 60 ? '#00ffaa' : '#fbbf24',
                    },
                    {
                      label: 'ROI',
                      value: `${forceData.roi_percent >= 0 ? '+' : ''}${forceData.roi_percent}%`,
                      color: forceData.roi_percent >= 0 ? '#00ffaa' : '#f87171',
                    },
                    {
                      label: 'Profit',
                      value: `${forceData.profit_units >= 0 ? '+' : ''}${forceData.profit_units}u`,
                      color: forceData.profit_units >= 0 ? '#00ffaa' : '#f87171',
                    },
                  ].map((k) => (
                    <div
                      key={k.label}
                      style={{
                        background: 'rgba(0,0,0,0.4)',
                        borderRadius: 10,
                        padding: '10px 8px',
                        textAlign: 'center',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 8,
                          fontWeight: 700,
                          color: '#475569',
                          marginBottom: 3,
                          letterSpacing: '0.5px',
                        }}
                      >
                        {k.label}
                      </div>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 900,
                          color: k.color,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {k.value}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Confidence breakdown (6 components) */}
                {forceData.confidence_breakdown && (
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.3)',
                      borderRadius: 10,
                      padding: '10px 14px',
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        color: '#f59e0b',
                        letterSpacing: '0.8px',
                        marginBottom: 8,
                      }}
                    >
                      ⚡ FORCE DU PRONOSTIC — DÉCOMPOSITION
                    </div>
                    <div
                      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}
                    >
                      {[
                        { key: 'base_prob', label: 'Probabilité de base', max: 40, icon: '📊' },
                        {
                          key: 'dominance_margin',
                          label: 'Marge de dominance',
                          max: 30,
                          icon: '📏',
                        },
                        {
                          key: 'draw_bias',
                          label: 'Ajustement Nul',
                          max: 5,
                          icon: '⚖️',
                          neg: true,
                        },
                        { key: 'bsm_quality', label: 'Qualité BSM', max: 15, icon: '🛡️' },
                        { key: 'data_quality', label: 'Qualité données', max: 10, icon: '📡' },
                        {
                          key: 'history_bonus',
                          label: 'Bonus historique',
                          max: 5,
                          icon: '📈',
                          neg: true,
                        },
                      ].map((c) => {
                        const val = forceData.confidence_breakdown[c.key] ?? 0
                        const pct = Math.min(100, Math.max(0, (val / c.max) * 100))
                        const isNeg = val < 0
                        const barColor = isNeg
                          ? '#fb7185'
                          : val >= c.max * 0.8
                            ? '#00ffaa'
                            : val >= c.max * 0.5
                              ? '#38bdf8'
                              : '#64748b'
                        const textColor = isNeg ? '#fb7185' : '#e2e8f0'
                        return (
                          <div key={c.key} style={{ marginBottom: 2 }}>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: 10,
                                color: '#94a3b8',
                                marginBottom: 1,
                              }}
                            >
                              <span>
                                {c.icon} {c.label}
                              </span>
                              <span
                                style={{
                                  color: textColor,
                                  fontWeight: 700,
                                  fontFamily: "'JetBrains Mono', monospace",
                                }}
                              >
                                {val > 0 ? '+' : ''}
                                {val}/{c.max} pts
                              </span>
                            </div>
                            <div
                              style={{
                                height: 4,
                                background: 'rgba(255,255,255,0.06)',
                                borderRadius: 2,
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{
                                  width: `${Math.max(0, pct)}%`,
                                  height: '100%',
                                  background: barColor,
                                  borderRadius: 2,
                                  transition: 'width 0.3s',
                                }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {/* Anti-overfit badge — triggered when dominance is very low */}
                    {forceData.confidence_breakdown.dominance_margin <= 3 && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 9,
                          color: '#fbbf24',
                          background: 'rgba(251,191,36,0.08)',
                          borderRadius: 4,
                          padding: '2px 8px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        ⚠️ Plafonné à 75% (Edge non clair)
                      </div>
                    )}
                  </div>
                )}

                {/* Confidence brackets */}
                {forceData.by_confidence && (
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.3)',
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        color: '#a855f7',
                        letterSpacing: '0.8px',
                        marginBottom: 6,
                      }}
                    >
                      🎯 PAR CONFIANCE
                    </div>
                    <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr
                          style={{
                            color: '#475569',
                            borderBottom: '1px solid rgba(255,255,255,0.04)',
                          }}
                        >
                          {['Bracket', 'W', 'L', 'Total', 'Win Rate'].map((h) => (
                            <th
                              key={h}
                              style={{
                                textAlign: h === 'Bracket' ? 'left' : 'center',
                                padding: '3px 6px',
                                fontWeight: 700,
                              }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(forceData.by_confidence).map(
                          ([b, d]) =>
                            d.total > 0 && (
                              <tr
                                key={b}
                                style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}
                              >
                                <td style={{ padding: '3px 6px', color: '#e2e8f0' }}>{b}</td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    color: '#00ffaa',
                                  }}
                                >
                                  {d.won}
                                </td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    color: '#f87171',
                                  }}
                                >
                                  {d.lost}
                                </td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    color: '#94a3b8',
                                  }}
                                >
                                  {d.total}
                                </td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    fontWeight: 700,
                                    color:
                                      d.win_rate >= 60
                                        ? '#00ffaa'
                                        : d.win_rate >= 50
                                          ? '#fbbf24'
                                          : '#f87171',
                                  }}
                                >
                                  {d.win_rate}%
                                </td>
                              </tr>
                            )
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* By Market */}
                {forceData.by_market && (
                  <div
                    style={{
                      background: 'rgba(0,0,0,0.3)',
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        color: '#38bdf8',
                        letterSpacing: '0.8px',
                        marginBottom: 6,
                      }}
                    >
                      📊 PAR MARCHÉ
                    </div>
                    <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr
                          style={{
                            color: '#475569',
                            borderBottom: '1px solid rgba(255,255,255,0.04)',
                          }}
                        >
                          {['Marché', 'W', 'L', 'Total', 'Win Rate'].map((h) => (
                            <th
                              key={h}
                              style={{
                                textAlign: h === 'Marché' ? 'left' : 'center',
                                padding: '3px 6px',
                                fontWeight: 700,
                              }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(forceData.by_market).map(
                          ([m, d]) =>
                            d.total > 0 && (
                              <tr
                                key={m}
                                style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}
                              >
                                <td style={{ padding: '3px 6px', color: '#e2e8f0' }}>{m}</td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    color: '#00ffaa',
                                  }}
                                >
                                  {d.won}
                                </td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    color: '#f87171',
                                  }}
                                >
                                  {d.lost}
                                </td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    color: '#94a3b8',
                                  }}
                                >
                                  {d.total}
                                </td>
                                <td
                                  style={{
                                    textAlign: 'center',
                                    padding: '3px 6px',
                                    fontWeight: 700,
                                    color:
                                      d.win_rate >= 60
                                        ? '#00ffaa'
                                        : d.win_rate >= 50
                                          ? '#fbbf24'
                                          : '#f87171',
                                  }}
                                >
                                  {d.win_rate}%
                                </td>
                              </tr>
                            )
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 7-day Recharts trend */}
                {forceData.trend?.length > 0 && (
                  <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 10, padding: 12 }}>
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        color: '#fbbf24',
                        letterSpacing: '0.8px',
                        marginBottom: 8,
                      }}
                    >
                      📈 TENDANCE 7 JOURS
                    </div>
                    <ResponsiveContainer width="100%" height={120}>
                      <LineChart
                        data={forceData.trend.map((d) => ({ ...d, date: d.date.slice(5) }))}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 9, fill: '#475569' }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          domain={[0, 100]}
                          tick={{ fontSize: 9, fill: '#475569' }}
                          axisLine={false}
                          tickLine={false}
                          width={28}
                        />
                        <Tooltip
                          contentStyle={{
                            background: '#0f172a',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 8,
                            fontSize: 11,
                          }}
                          labelStyle={{ color: '#94a3b8' }}
                          formatter={(v) => `${v}%`}
                        />
                        <Line
                          type="monotone"
                          dataKey="win_rate"
                          stroke="#00ffaa"
                          strokeWidth={2}
                          dot={{ r: 3, fill: '#00ffaa' }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default PerformanceAnalytics
