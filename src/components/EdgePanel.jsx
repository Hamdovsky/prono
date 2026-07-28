import React, { useState, useEffect } from 'react'
import { getApiUrl } from '../config/apiConfig'

const VALUE_COLORS = {
  DIAMOND: { bg: 'rgba(99,102,241,0.15)', border: '#6366f1', label: '💎 DIAMOND' },
  FIRE: { bg: 'rgba(239,68,68,0.15)', border: '#ef4444', label: '🔥 FIRE' },
  VALUE: { bg: 'rgba(34,197,94,0.15)', border: '#22c55e', label: '💰 VALUE' },
  NEUTRAL: { bg: 'rgba(148,163,184,0.1)', border: '#64748b', label: '➖ NEUTRAL' },
}

function getValueTier(pct) {
  if (pct >= 15) return 'DIAMOND'
  if (pct >= 9) return 'FIRE'
  if (pct >= 5) return 'VALUE'
  return 'NEUTRAL'
}

const EdgePanel = () => {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('value')
  const [mktTab, setMktTab] = useState('overUnder')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(getApiUrl('/api/edge'))
        const json = await res.json()
        setData(json)
      } catch (err) {
        console.error('[EDGE] Load error:', err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
        Analyse des marchés en cours...
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: '#ef4444' }}>
        Erreur de chargement
      </div>
    )
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <TabBtn active={tab === 'value'} onClick={() => setTab('value')} color="#22c55e">
          💰 VALUE ({data.totalValueBets})
        </TabBtn>
        <TabBtn active={tab === 'alerts'} onClick={() => setTab('alerts')} color="#f59e0b">
          🚨 SMART MONEY ({data.totalAlerts})
        </TabBtn>
        <TabBtn active={tab === 'suspicious'} onClick={() => setTab('suspicious')} color="#ef4444">
          🔍 SUSPECT ({data.totalSuspicious})
        </TabBtn>
        <TabBtn active={tab === 'ah'} onClick={() => setTab('ah')} color="#a855f7">
          🏟️ AH ({data.totalAsianHandicaps})
        </TabBtn>
        <TabBtn active={tab === 'markets'} onClick={() => setTab('markets')} color="#3b82f6">
          🎯 MARKETS ({Object.values(data.totalMarkets || {}).reduce((a, b) => a + b, 0)})
        </TabBtn>
      </div>

      {tab === 'value' && (
        <div>
          {data.valueBets.length === 0 ? (
            <p style={{ color: '#64748b' }}>Aucun value bet détecté aujourd'hui</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {data.valueBets.map((vb, i) => {
                const tier = getValueTier(vb.valuePercent)
                const c = VALUE_COLORS[tier]
                return (
                  <div
                    key={`${vb.id}-${vb.outcome}`}
                    style={{
                      background: c.bg,
                      border: `1px solid ${c.border}`,
                      borderRadius: '10px',
                      padding: '0.75rem 1rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.25rem',
                      }}
                    >
                      <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.9rem' }}>
                        {vb.homeTeam} vs {vb.awayTeam}
                      </span>
                      <span style={{ color: c.border, fontWeight: 800, fontSize: '0.8rem' }}>
                        {c.label}
                      </span>
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                      {vb.league} · {vb.outcome} @ {vb.marketOdds}
                      <span style={{ color: '#22c55e', marginLeft: '0.5rem' }}>
                        (fair: {vb.fairOdds}) · Value: +{vb.valuePercent}%
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'alerts' && (
        <div>
          {data.alerts.length === 0 ? (
            <p style={{ color: '#64748b' }}>Aucun mouvement suspect détecté</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {data.alerts.map((a, i) => (
                <div
                  key={i}
                  style={{
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid #f59e0b',
                    borderRadius: '10px',
                    padding: '0.75rem 1rem',
                  }}
                >
                  <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.9rem' }}>
                    {a.homeTeam} vs {a.awayTeam}
                  </div>
                  <div style={{ color: '#f59e0b', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    {a.steamHome && `⬆️ HOME odds movement`}
                    {a.steamAway && `⬆️ AWAY odds movement`}
                    {a.steamDraw && `⬆️ DRAW odds movement`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'suspicious' && (
        <div>
          {data.suspicious.length === 0 ? (
            <p style={{ color: '#64748b' }}>Aucun match suspect détecté</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {data.suspicious.map((s, i) => (
                <div
                  key={i}
                  style={{
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid #ef4444',
                    borderRadius: '10px',
                    padding: '0.75rem 1rem',
                  }}
                >
                  <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.9rem' }}>
                    {s.homeTeam} vs {s.awayTeam}
                  </div>
                  <div style={{ color: '#ef4444', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    Risque: {s.score}/10 · {s.risks.map((r) => r.tag).join(', ')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'ah' && (
        <div>
          {data.asianHandicaps.length === 0 ? (
            <p style={{ color: '#64748b' }}>Aucune opportunité Asian Handicap aujourd'hui</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {data.asianHandicaps.map((ah, i) => (
                <div
                  key={i}
                  style={{
                    background: 'rgba(168,85,247,0.08)',
                    border: '1px solid #a855f7',
                    borderRadius: '10px',
                    padding: '0.75rem 1rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.25rem',
                    }}
                  >
                    <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.9rem' }}>
                      {ah.homeTeam} vs {ah.awayTeam}
                    </span>
                    <span
                      style={{
                        color: '#a855f7',
                        fontWeight: 800,
                        fontSize: '0.75rem',
                        background: 'rgba(168,85,247,0.15)',
                        padding: '2px 8px',
                        borderRadius: '4px',
                      }}
                    >
                      {ah.league}
                    </span>
                  </div>
                  <div
                    style={{
                      color: '#94a3b8',
                      fontSize: '0.8rem',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '1rem',
                    }}
                  >
                    <span>
                      Marché:{' '}
                      <strong style={{ color: '#cbd5e1' }}>
                        {ah.marketLine > 0 ? '+' : ''}
                        {ah.marketLine}
                      </strong>
                    </span>
                    <span>
                      Modèle:{' '}
                      <strong style={{ color: '#22c55e' }}>
                        {ah.modelLine > 0 ? '+' : ''}
                        {ah.modelLine}
                      </strong>
                    </span>
                    <span>
                      Écart: <strong style={{ color: '#f59e0b' }}>{ah.lineDisagreement}</strong>
                    </span>
                    <span>
                      Confiance:{' '}
                      <strong
                        style={{
                          color:
                            ah.modelConfidence === 'HIGH'
                              ? '#22c55e'
                              : ah.modelConfidence === 'MED'
                                ? '#f59e0b'
                                : '#ef4444',
                        }}
                      >
                        {ah.modelConfidence}
                      </strong>
                    </span>
                  </div>
                  <div
                    style={{
                      color: '#64748b',
                      fontSize: '0.75rem',
                      marginTop: '0.25rem',
                      display: 'flex',
                      gap: '1rem',
                    }}
                  >
                    {ah.homeAHodds && <span>Home AH @ {ah.homeAHodds}</span>}
                    {ah.awayAHodds && <span>Away AH @ {ah.awayAHodds}</span>}
                    {ah.steam && (
                      <span style={{ color: '#f59e0b' }}>
                        🚨 Steam: {ah.steam.direction} ({ah.steam.shift})
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'markets' && (
        <div>
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <MktTabBtn
              active={mktTab === 'overUnder'}
              onClick={() => setMktTab('overUnder')}
              label="O/U"
              n={data.totalMarkets?.overUnder}
            />
            <MktTabBtn
              active={mktTab === 'btts'}
              onClick={() => setMktTab('btts')}
              label="BTTS"
              n={data.totalMarkets?.btts}
            />
            <MktTabBtn
              active={mktTab === 'doubleChance'}
              onClick={() => setMktTab('doubleChance')}
              label="DC"
              n={data.totalMarkets?.doubleChance}
            />
            <MktTabBtn
              active={mktTab === 'htFt'}
              onClick={() => setMktTab('htFt')}
              label="HT/FT"
              n={data.totalMarkets?.htFt}
            />
            <MktTabBtn
              active={mktTab === 'corners'}
              onClick={() => setMktTab('corners')}
              label="CORNERS"
              n={data.totalMarkets?.corners}
            />
            <MktTabBtn
              active={mktTab === 'cards'}
              onClick={() => setMktTab('cards')}
              label="CARDS"
              n={data.totalMarkets?.cards}
            />
            <MktTabBtn
              active={mktTab === 'playerProps'}
              onClick={() => setMktTab('playerProps')}
              label="PROPS"
              n={data.totalMarkets?.playerProps}
            />
          </div>

          {mktTab === 'overUnder' && <OUView items={data.markets?.overUnder || []} />}
          {mktTab === 'btts' && <BTTSView items={data.markets?.btts || []} />}
          {mktTab === 'doubleChance' && <DCView items={data.markets?.doubleChance || []} />}
          {mktTab === 'htFt' && <HTFTView items={data.markets?.htFt || []} />}
          {mktTab === 'corners' && <CornersView items={data.markets?.corners || []} />}
          {mktTab === 'cards' && <CardsView items={data.markets?.cards || []} />}
          {mktTab === 'playerProps' && <PropsView items={data.markets?.playerProps || []} />}
        </div>
      )}
    </div>
  )
}

function MktTabBtn({ active, onClick, label, n }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.03)',
        color: active ? '#60a5fa' : '#64748b',
        border: `1px solid ${active ? '#3b82f6' : '#334155'}`,
        padding: '4px 10px',
        borderRadius: '6px',
        fontWeight: active ? 800 : 600,
        cursor: 'pointer',
        fontSize: '0.7rem',
        transition: 'all 0.2s',
      }}
    >
      {label} {n > 0 && <span style={{ color: '#22c55e' }}>({n})</span>}
    </button>
  )
}

function OUView({ items }) {
  if (!items.length) return <p style={{ color: '#64748b' }}>Aucun Over/Under disponible</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((m, i) => (
        <div
          key={i}
          style={{
            background: 'rgba(59,130,246,0.06)',
            border: '1px solid #3b82f6',
            borderRadius: '8px',
            padding: '0.6rem 0.8rem',
          }}
        >
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>
            {m.homeTeam} vs {m.awayTeam}
          </div>
          <div
            style={{
              color: '#94a3b8',
              fontSize: '0.75rem',
              display: 'flex',
              gap: '0.8rem',
              flexWrap: 'wrap',
              marginTop: '0.2rem',
            }}
          >
            <span>
              Ligne: <strong style={{ color: '#60a5fa' }}>{m.line}</strong>
            </span>
            <span>
              Over: <strong style={{ color: '#22c55e' }}>{m.fairOver}</strong>
            </span>
            <span>
              Under: <strong style={{ color: '#f59e0b' }}>{m.fairUnder}</strong>
            </span>
            <span>
              Prob Over: <strong>{(m.overProb * 100).toFixed(0)}%</strong>
            </span>
            <span style={{ color: '#64748b' }}>{m.league}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function BTTSView({ items }) {
  if (!items.length) return <p style={{ color: '#64748b' }}>Aucun BTTS disponible</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((m, i) => (
        <div
          key={i}
          style={{
            background: 'rgba(34,197,94,0.06)',
            border: '1px solid #22c55e',
            borderRadius: '8px',
            padding: '0.6rem 0.8rem',
          }}
        >
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>
            {m.homeTeam} vs {m.awayTeam}
          </div>
          <div
            style={{
              color: '#94a3b8',
              fontSize: '0.75rem',
              display: 'flex',
              gap: '0.8rem',
              marginTop: '0.2rem',
            }}
          >
            <span>
              BTTS: <strong style={{ color: '#22c55e' }}>{(m.bttsProb * 100).toFixed(0)}%</strong>
            </span>
            <span>
              Fair Odds: <strong>{m.fairBttsOdds}</strong>
            </span>
            <span style={{ color: '#64748b' }}>{m.league}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function DCView({ items }) {
  if (!items.length) return <p style={{ color: '#64748b' }}>Aucun Double Chance disponible</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((m, i) => {
        const opts = Object.values(m.options || {})
        return (
          <div
            key={i}
            style={{
              background: 'rgba(168,85,247,0.06)',
              border: '1px solid #a855f7',
              borderRadius: '8px',
              padding: '0.6rem 0.8rem',
            }}
          >
            <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>
              {m.homeTeam} vs {m.awayTeam}
            </div>
            <div
              style={{
                color: '#94a3b8',
                fontSize: '0.75rem',
                display: 'flex',
                gap: '0.5rem',
                flexWrap: 'wrap',
                marginTop: '0.2rem',
              }}
            >
              {opts.map((o) => (
                <span
                  key={o.outcome}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                  }}
                >
                  {o.outcome}: <strong style={{ color: '#22c55e' }}>{o.fairOdds}</strong>
                </span>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function HTFTView({ items }) {
  if (!items.length) return <p style={{ color: '#64748b' }}>Aucun HT/FT disponible</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((m, i) => (
        <div
          key={i}
          style={{
            background: 'rgba(245,158,11,0.06)',
            border: '1px solid #f59e0b',
            borderRadius: '8px',
            padding: '0.6rem 0.8rem',
          }}
        >
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>
            {m.homeTeam} vs {m.awayTeam}
          </div>
          <div
            style={{
              color: '#94a3b8',
              fontSize: '0.75rem',
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginTop: '0.2rem',
            }}
          >
            {m.topPicks?.map((p) => (
              <span
                key={p.outcome}
                style={{
                  background: 'rgba(245,158,11,0.1)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                }}
              >
                {p.outcome}: <strong>{(p.prob * 100).toFixed(0)}%</strong> @ {p.fairOdds}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function CornersView({ items }) {
  if (!items.length) return <p style={{ color: '#64748b' }}>Aucun Corners disponible</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((m, i) => (
        <div
          key={i}
          style={{
            background: 'rgba(59,130,246,0.06)',
            border: '1px solid #3b82f6',
            borderRadius: '8px',
            padding: '0.6rem 0.8rem',
          }}
        >
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>
            {m.homeTeam} vs {m.awayTeam}
          </div>
          <div
            style={{
              color: '#94a3b8',
              fontSize: '0.75rem',
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginTop: '0.2rem',
            }}
          >
            {m.lines?.slice(0, 3).map((l) => (
              <span
                key={l.line}
                style={{
                  background: 'rgba(59,130,246,0.08)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                }}
              >
                {'>'}
                {l.line} @ <strong>{l.fairOver}</strong> ({(l.overProb * 100).toFixed(0)}%)
              </span>
            ))}
            <span style={{ color: '#64748b' }}>Exp: {m.lines?.[0]?.expectedTotal}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function CardsView({ items }) {
  if (!items.length) return <p style={{ color: '#64748b' }}>Aucun Cards disponible</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((m, i) => (
        <div
          key={i}
          style={{
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid #ef4444',
            borderRadius: '8px',
            padding: '0.6rem 0.8rem',
          }}
        >
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>
            {m.homeTeam} vs {m.awayTeam}
          </div>
          <div
            style={{
              color: '#94a3b8',
              fontSize: '0.75rem',
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginTop: '0.2rem',
            }}
          >
            {m.lines?.slice(0, 3).map((l) => (
              <span
                key={l.line}
                style={{
                  background: 'rgba(239,68,68,0.08)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                }}
              >
                {'>'}
                {l.line} @ <strong>{l.fairOver}</strong> ({(l.overProb * 100).toFixed(0)}%)
              </span>
            ))}
            <span style={{ color: '#64748b' }}>Exp: {m.lines?.[0]?.expectedTotal}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function PropsView({ items }) {
  if (!items.length) return <p style={{ color: '#64748b' }}>Aucun Player Prop disponible</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {items.map((m, i) => (
        <div
          key={i}
          style={{
            background: 'rgba(236,72,153,0.06)',
            border: '1px solid #ec4899',
            borderRadius: '8px',
            padding: '0.6rem 0.8rem',
          }}
        >
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.85rem' }}>
            {m.homeTeam} vs {m.awayTeam}
          </div>
          <div
            style={{
              color: '#94a3b8',
              fontSize: '0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.2rem',
              marginTop: '0.2rem',
            }}
          >
            {m.props?.map((p) => (
              <span
                key={p.player}
                style={{
                  background: 'rgba(236,72,153,0.08)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                }}
              >
                {p.player} ({p.position}) — Score:{' '}
                <strong style={{ color: '#22c55e' }}>{(p.goalProb * 100).toFixed(0)}%</strong> @{' '}
                {p.fairOdds}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TabBtn({ active, onClick, color, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? color : 'rgba(255,255,255,0.05)',
        color: active ? '#000' : '#94a3b8',
        border: `1px solid ${color}`,
        padding: '8px 16px',
        borderRadius: '8px',
        fontWeight: 700,
        cursor: 'pointer',
        fontSize: '0.8rem',
        transition: 'all 0.2s',
      }}
    >
      {children}
    </button>
  )
}

export default EdgePanel
