import React, { useState, useMemo } from 'react'

const fmtPct = (v) => Math.round(parseFloat(v || 0))
const fmtOdds = (v) => (v ? parseFloat(v).toFixed(2) : '-')
const fmtEv = (v) => {
  const n = parseFloat(v)
  if (isNaN(n)) return { val: '-', cls: 'neutral' }
  if (n > 0.1) return { val: `+${n.toFixed(2)}`, cls: 'green' }
  if (n > 0) return { val: `+${n.toFixed(2)}`, cls: 'yellow' }
  return { val: n.toFixed(2), cls: 'red' }
}

const MarketBar = ({ prob }) => {
  const p = Math.min(100, Math.max(0, fmtPct(prob)))
  const color = p >= 65 ? '#00ffaa' : p >= 45 ? '#fbbf24' : '#ef4444'
  return (
    <div
      style={{
        width: '100%',
        height: 3,
        background: 'rgba(148,163,184,0.15)',
        borderRadius: 2,
        marginTop: 2,
      }}
    >
      <div style={{ width: `${p}%`, height: '100%', background: color, borderRadius: 2 }} />
    </div>
  )
}

const EvBadge = ({ ev }) => {
  const { val, cls } = fmtEv(ev)
  const color =
    cls === 'green'
      ? '#00ffaa'
      : cls === 'yellow'
        ? '#fbbf24'
        : cls === 'red'
          ? '#ef4444'
          : '#64748b'
  return (
    <span
      style={{ fontSize: 9, fontWeight: 900, color, fontFamily: "'JetBrains Mono', monospace" }}
    >
      {val}
    </span>
  )
}

const MarketCell = ({ label, prob, odds, ev, invert }) => {
  const p = invert ? 100 - fmtPct(prob) : fmtPct(prob)
  const color = p >= 65 ? '#00ffaa' : p >= 45 ? '#fbbf24' : '#ef4444'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: '2px 4px',
        borderRadius: 3,
        background: 'rgba(0,0,0,0.15)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8' }}>{label}</span>
        <span
          style={{ fontSize: 9, fontWeight: 900, color, fontFamily: "'JetBrains Mono', monospace" }}
        >
          {p}%
        </span>
      </div>
      <MarketBar prob={p} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 8, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>
          @{fmtOdds(odds)}
        </span>
        <EvBadge ev={ev} />
      </div>
    </div>
  )
}

const GroupCell = ({ markets, prefix }) => {
  return (
    <div style={{ display: 'flex', gap: 3, flexDirection: 'column' }}>
      {Object.entries(markets || {}).map(([key, m]) => (
        <MarketCell
          key={key}
          label={prefix ? `${prefix} ${key}` : key}
          prob={m.prob}
          odds={m.odds}
          ev={m.ev}
        />
      ))}
    </div>
  )
}

const MatchCard = ({ m, compact }) => {
  const quant = m.quant || {}
  const mkts = quant.markets || {}
  const isInsufficient = m.insufficient_data === 1
  const status = (m.status || '').toLowerCase()
  const isLive = status === 'live' || m.isLive

  return (
    <div
      style={{
        background: isLive ? 'rgba(239, 68, 68, 0.05)' : 'rgba(0,0,0,0.2)',
        border: `1px solid ${isLive ? 'rgba(239, 68, 68, 0.2)' : isInsufficient ? 'rgba(245, 158, 11, 0.2)' : 'rgba(148,163,184,0.1)'}`,
        borderRadius: 8,
        padding: '8px 10px',
        borderLeft: `3px solid ${isLive ? '#ef4444' : isInsufficient ? '#f59e0b' : m.confidence >= 70 ? '#00ffaa' : m.confidence >= 55 ? '#fbbf24' : '#64748b'}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              color: '#f8fafc',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {m.homeTeam} vs {m.awayTeam}
          </div>
          <div style={{ fontSize: 9, color: '#64748b' }}>{m.league || m.tournament_name || ''}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {isLive && (
            <span style={{ fontSize: 8, color: '#ef4444', fontWeight: 900 }}>🔴 LIVE</span>
          )}
          {isInsufficient && (
            <span style={{ fontSize: 8, color: '#f59e0b', fontWeight: 900 }}>⚠️ ATTENTE</span>
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 900,
              color: m.confidence >= 70 ? '#00ffaa' : m.confidence >= 55 ? '#fbbf24' : '#64748b',
            }}
          >
            {m.confidence || 0}%
          </span>
        </div>
      </div>

      {isInsufficient ? (
        <div style={{ fontSize: 10, color: '#f59e0b', textAlign: 'center', padding: '12px 0' }}>
          ⏳ PRÉDICTION EN ATTENTE — Données insuffisantes
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {/* 1X2 */}
          <div style={{ flex: '1 1 120px', minWidth: 100 }}>
            <div
              style={{
                fontSize: 8,
                fontWeight: 900,
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              1X2
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {['1', 'X', '2'].map((k) => {
                const mkt = mkts.match_result?.[k]
                const pct = fmtPct(mkt?.prob)
                return (
                  <div
                    key={k}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      padding: '2px 0',
                      borderRadius: 3,
                      background:
                        k === (quant.main_pick || '').replace(/[^1X2]/g, '')
                          ? 'rgba(0,255,170,0.12)'
                          : 'rgba(0,0,0,0.15)',
                      border:
                        k === (quant.main_pick || '').replace(/[^1X2]/g, '')
                          ? '1px solid rgba(0,255,170,0.3)'
                          : '1px solid transparent',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 900,
                        color: pct >= 65 ? '#00ffaa' : pct >= 45 ? '#fbbf24' : '#ef4444',
                      }}
                    >
                      {pct}%
                    </div>
                    <div style={{ fontSize: 8, color: '#64748b' }}>@{fmtOdds(mkt?.odds)}</div>
                    <EvBadge ev={mkt?.ev} />
                  </div>
                )
              })}
            </div>
          </div>

          {/* BTTS */}
          <div style={{ flex: '0 0 auto', minWidth: 70 }}>
            <div
              style={{
                fontSize: 8,
                fontWeight: 900,
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              BTTS
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {['YES', 'NO'].map((k) => {
                const mkt = mkts.btts?.[k]
                const pct = fmtPct(mkt?.prob)
                return (
                  <div
                    key={k}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      padding: '2px 4px',
                      borderRadius: 3,
                      background: 'rgba(0,0,0,0.15)',
                      minWidth: 30,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 900,
                        color: pct >= 60 ? '#00ffaa' : '#ef4444',
                      }}
                    >
                      {k === 'YES' ? 'O' : 'N'}
                    </div>
                    <div style={{ fontSize: 8, color: '#64748b' }}>{pct}%</div>
                    <EvBadge ev={mkt?.ev} />
                  </div>
                )
              })}
            </div>
          </div>

          {/* O/U 2.5 */}
          <div style={{ flex: '0 0 auto', minWidth: 70 }}>
            <div
              style={{
                fontSize: 8,
                fontWeight: 900,
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              O/U 2.5
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {[
                ['O2.5', 'O'],
                ['U2.5', 'U'],
              ].map(([k, l]) => {
                const mkt = mkts.over_under?.[k]
                const pct = fmtPct(mkt?.prob)
                return (
                  <div
                    key={k}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      padding: '2px 4px',
                      borderRadius: 3,
                      background: 'rgba(0,0,0,0.15)',
                      minWidth: 30,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 900,
                        color: pct >= 60 ? '#00ffaa' : '#ef4444',
                      }}
                    >
                      {l}
                    </div>
                    <div style={{ fontSize: 8, color: '#64748b' }}>{pct}%</div>
                    <EvBadge ev={mkt?.ev} />
                  </div>
                )
              })}
            </div>
          </div>

          {/* DC */}
          <div style={{ flex: '0 0 auto', minWidth: 80 }}>
            <div
              style={{
                fontSize: 8,
                fontWeight: 900,
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              DC
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {['1X', '12', 'X2'].map((k) => {
                const mkt = mkts.double_chance?.[k]
                const pct = fmtPct(mkt?.prob)
                return (
                  <div
                    key={k}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      padding: '2px 2px',
                      borderRadius: 3,
                      background: 'rgba(0,0,0,0.15)',
                      minWidth: 24,
                    }}
                  >
                    <div style={{ fontSize: 7, fontWeight: 900, color: '#94a3b8' }}>{k}</div>
                    <div
                      style={{
                        fontSize: 8,
                        color: pct >= 70 ? '#00ffaa' : '#64748b',
                        fontWeight: 700,
                      }}
                    >
                      {pct}%
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* HT */}
          <div style={{ flex: '0 0 auto', minWidth: 60 }}>
            <div
              style={{
                fontSize: 8,
                fontWeight: 900,
                color: '#64748b',
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              HT
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {['O0.5'].map((k) => {
                const mkt = mkts.first_half?.[k]
                const pct = fmtPct(mkt?.prob)
                return (
                  <div
                    key={k}
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      padding: '2px 4px',
                      borderRadius: 3,
                      background: 'rgba(0,0,0,0.15)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 900,
                        color: pct >= 65 ? '#00ffaa' : '#fbbf24',
                      }}
                    >
                      {pct}%
                    </div>
                    <EvBadge ev={mkt?.ev} />
                  </div>
                )
              })}
            </div>
          </div>

          {/* CS */}
          <div
            style={{
              flex: '0 0 auto',
              minWidth: 50,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{ fontSize: 8, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' }}
            >
              CS
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 900,
                color: '#00ffaa',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {quant.expected_score || m.expected_score || '-'}
            </div>
          </div>

          {/* EV */}
          <div
            style={{
              flex: '0 0 auto',
              minWidth: 50,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{ fontSize: 8, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' }}
            >
              EV
            </div>
            <EvBadge ev={quant.ev_score} />
          </div>
        </div>
      )}
    </div>
  )
}

const MatchTableRow = ({ m }) => {
  const quant = m.quant || {}
  const mkts = quant.markets || {}
  const isInsufficient = m.insufficient_data === 1
  const mainPick = (quant.main_pick || '').replace(/[^1X2]/g, '')

  const EvNum = ({ ev }) => {
    const { val, cls } = fmtEv(ev)
    const color =
      cls === 'green'
        ? '#00ffaa'
        : cls === 'yellow'
          ? '#fbbf24'
          : cls === 'red'
            ? '#ef4444'
            : '#64748b'
    return (
      <span
        style={{ fontSize: 10, fontWeight: 900, color, fontFamily: "'JetBrains Mono', monospace" }}
      >
        {val}
      </span>
    )
  }

  const MktMini = ({ label, prob, odds, ev, isMain }) => {
    const p = fmtPct(prob)
    return (
      <div
        style={{
          textAlign: 'center',
          padding: '3px 4px',
          borderRadius: 4,
          background: isMain ? 'rgba(0,255,170,0.08)' : 'transparent',
          border: isMain ? '1px solid rgba(0,255,170,0.2)' : '1px solid transparent',
          minWidth: 48,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 900,
            color: p >= 60 ? '#00ffaa' : p >= 45 ? '#fbbf24' : '#64748b',
          }}
        >
          {p}%
        </div>
        <div style={{ fontSize: 8, color: '#64748b' }}>@{fmtOdds(odds)}</div>
        <EvNum ev={ev} />
      </div>
    )
  }

  const confColor = m.confidence >= 70 ? '#00ffaa' : m.confidence >= 55 ? '#fbbf24' : '#64748b'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderBottom: '1px solid rgba(148,163,184,0.08)',
        background: isInsufficient ? 'rgba(245,158,11,0.03)' : 'transparent',
        fontSize: 11,
        minWidth: 'fit-content',
      }}
    >
      {/* Match */}
      <div style={{ minWidth: 180, flex: '0 0 180px' }}>
        <div
          style={{
            fontWeight: 800,
            color: '#f8fafc',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {m.homeTeam} vs {m.awayTeam}
        </div>
        <div style={{ fontSize: 9, color: '#64748b' }}>{m.league || ''}</div>
      </div>

      {/* 1X2 */}
      <div style={{ display: 'flex', gap: 2, flex: '0 0 150px' }}>
        {['1', 'X', '2'].map((k) => {
          const mkt = mkts.match_result?.[k]
          return (
            <MktMini
              key={k}
              label={k}
              prob={mkt?.prob}
              odds={mkt?.odds}
              ev={mkt?.ev}
              isMain={k === mainPick}
            />
          )
        })}
      </div>

      {/* BTTS */}
      <div style={{ display: 'flex', gap: 2, flex: '0 0 100px' }}>
        {[
          ['YES', 'O'],
          ['NO', 'N'],
        ].map(([k, l]) => {
          const mkt = mkts.btts?.[k]
          return <MktMini key={k} label={l} prob={mkt?.prob} odds={mkt?.odds} ev={mkt?.ev} />
        })}
      </div>

      {/* O/U */}
      <div style={{ display: 'flex', gap: 2, flex: '0 0 100px' }}>
        {[
          ['O2.5', 'O'],
          ['U2.5', 'U'],
        ].map(([k, l]) => {
          const mkt = mkts.over_under?.[k]
          return <MktMini key={k} label={l} prob={mkt?.prob} odds={mkt?.odds} ev={mkt?.ev} />
        })}
      </div>

      {/* DC */}
      <div style={{ display: 'flex', gap: 2, flex: '0 0 120px' }}>
        {['1X', '12', 'X2'].map((k) => {
          const mkt = mkts.double_chance?.[k]
          const p = fmtPct(mkt?.prob)
          return (
            <div key={k} style={{ textAlign: 'center', padding: '3px 2px', minWidth: 36 }}>
              <div style={{ fontSize: 8, fontWeight: 900, color: '#94a3b8' }}>{k}</div>
              <div
                style={{ fontSize: 10, fontWeight: 900, color: p >= 75 ? '#00ffaa' : '#64748b' }}
              >
                {p}%
              </div>
            </div>
          )
        })}
      </div>

      {/* CS + EV */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 100px' }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 900,
            color: '#00ffaa',
            fontFamily: "'JetBrains Mono', monospace",
            minWidth: 40,
          }}
        >
          {quant.expected_score || m.expected_score || '-'}
        </div>
        <EvNum ev={quant.ev_score} />
      </div>

      {/* Conf */}
      <div style={{ flex: '0 0 40px', textAlign: 'center' }}>
        <span style={{ fontWeight: 900, color: confColor }}>{m.confidence || 0}</span>
      </div>

      {/* Insufficient badge */}
      {isInsufficient && (
        <div style={{ flex: '0 0 80px', textAlign: 'center' }}>
          <span style={{ fontSize: 8, color: '#f59e0b', fontWeight: 900 }}>⚠️ ATTENTE</span>
        </div>
      )}
    </div>
  )
}

const MarketTerminal = ({ matches }) => {
  const [viewMode, setViewMode] = useState('table')

  const liveMatches = useMemo(
    () => matches.filter((m) => m.status === 'live' || m.isLive),
    [matches]
  )
  const scheduledMatches = useMemo(
    () => matches.filter((m) => m.status !== 'live' && !m.isLive),
    [matches]
  )

  const stats = useMemo(() => {
    const withEv = matches.filter((m) => {
      const ev = parseFloat(m.quant?.ev_score)
      return !isNaN(ev)
    })
    const avgEv =
      withEv.length > 0
        ? withEv.reduce((s, m) => s + parseFloat(m.quant.ev_score || 0), 0) / withEv.length
        : 0
    const bestEv = withEv.sort(
      (a, b) => parseFloat(b.quant?.ev_score || 0) - parseFloat(a.quant?.ev_score || 0)
    )[0]
    return { total: matches.length, live: liveMatches.length, avgEv, bestEv }
  }, [matches, liveMatches])

  return (
    <div style={{ padding: '8px 12px' }}>
      {/* Stats bar */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          marginBottom: 10,
          padding: '8px 12px',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: 8,
          fontSize: 10,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: '#64748b' }}>
          📊 <b style={{ color: '#f8fafc' }}>{stats.total}</b> matchs
        </span>
        {stats.live > 0 && (
          <span style={{ color: '#ef4444' }}>
            🔴 <b>{stats.live}</b> live
          </span>
        )}
        <span style={{ color: '#64748b' }}>
          EV moyen:{' '}
          <b style={{ color: stats.avgEv > 0 ? '#00ffaa' : '#ef4444' }}>
            {stats.avgEv > 0 ? '+' : ''}
            {stats.avgEv.toFixed(3)}
          </b>
        </span>
        {stats.bestEv && (
          <span style={{ color: '#64748b' }}>
            🏆 Meilleur EV:{' '}
            <b style={{ color: '#fbbf24' }}>
              {stats.bestEv.homeTeam} vs {stats.bestEv.awayTeam}
            </b>
            <span style={{ color: '#00ffaa', fontFamily: "'JetBrains Mono', monospace" }}>
              {' '}
              +{parseFloat(stats.bestEv.quant?.ev_score || 0).toFixed(2)}
            </span>
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {['table', 'grid'].map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              style={{
                padding: '3px 10px',
                fontSize: 9,
                fontWeight: 900,
                background: viewMode === m ? 'rgba(0,255,170,0.15)' : 'rgba(148,163,184,0.08)',
                border: viewMode === m ? '1px solid rgba(0,255,170,0.3)' : '1px solid transparent',
                color: viewMode === m ? '#00ffaa' : '#64748b',
                borderRadius: 4,
                cursor: 'pointer',
                textTransform: 'uppercase',
              }}
            >
              {m === 'table' ? '📋 Tableau' : '📇 Grille'}
            </button>
          ))}
        </div>
      </div>

      {/* Live matches - always shown as cards */}
      {liveMatches.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 900,
              color: '#ef4444',
              textTransform: 'uppercase',
              marginBottom: 6,
              letterSpacing: 1,
            }}
          >
            🔴 MATCHS EN DIRECT ({liveMatches.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {liveMatches.map((m) => (
              <MatchCard key={m.id} m={m} />
            ))}
          </div>
        </div>
      )}

      {/* Scheduled matches */}
      {scheduledMatches.length > 0 && (
        <>
          <div
            style={{
              fontSize: 10,
              fontWeight: 900,
              color: '#94a3b8',
              textTransform: 'uppercase',
              marginBottom: 6,
              letterSpacing: 1,
            }}
          >
            📅 MATCHS PROGRAMMÉS ({scheduledMatches.length})
          </div>
          {viewMode === 'table' ? (
            /* Table view */
            <div
              style={{
                overflowX: 'auto',
                borderRadius: 6,
                border: '1px solid rgba(148,163,184,0.1)',
              }}
            >
              {/* Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  background: 'rgba(0,0,0,0.3)',
                  borderBottom: '1px solid rgba(148,163,184,0.15)',
                  fontSize: 8,
                  fontWeight: 900,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                <div style={{ minWidth: 180, flex: '0 0 180px' }}>Match</div>
                <div style={{ flex: '0 0 150px', textAlign: 'center' }}>1X2</div>
                <div style={{ flex: '0 0 100px', textAlign: 'center' }}>BTTS</div>
                <div style={{ flex: '0 0 100px', textAlign: 'center' }}>O/U 2.5</div>
                <div style={{ flex: '0 0 120px', textAlign: 'center' }}>DC</div>
                <div style={{ flex: '0 0 100px', textAlign: 'center' }}>CS / EV</div>
                <div style={{ flex: '0 0 40px', textAlign: 'center' }}>Conf</div>
                <div style={{ flex: '0 0 80px', textAlign: 'center' }}>Status</div>
              </div>
              {scheduledMatches.map((m) => (
                <MatchTableRow key={m.id} m={m} />
              ))}
              {scheduledMatches.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: '#64748b', fontSize: 11 }}>
                  Aucun match programmé pour cette période
                </div>
              )}
            </div>
          ) : (
            /* Grid view */
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
                gap: 6,
              }}
            >
              {scheduledMatches.map((m) => (
                <MatchCard key={m.id} m={m} />
              ))}
            </div>
          )}
        </>
      )}

      {matches.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
          ⏳ Aucun match disponible — les données sont en cours de chargement
        </div>
      )}
    </div>
  )
}

export default React.memo(MarketTerminal)
