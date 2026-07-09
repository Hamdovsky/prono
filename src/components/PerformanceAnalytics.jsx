import React, { useMemo, useState, useEffect, useCallback } from 'react'

const MARKET_LABELS = {
  '1X2': { icon: '⚽', label: '1X2' },
  'BTTS': { icon: '⚡', label: 'BTTS' },
  'OU': { icon: '📊', label: 'O/U' },
  'HT': { icon: '⏱', label: 'HT' },
  'HCP': { icon: '🛡️', label: 'HCP' },
  'DC': { icon: '🔄', label: 'DC' },
}

const isFinished = (m) => {
  const st = (m.status || '').toUpperCase()
  if (st === 'NOT_STARTED' || st === 'SCHEDULED' || st === '' || st === 'NS') return false
  if (st === 'IN_PLAY' || st === 'LIVE' || st === '1H' || st === '2H' || st === 'HT') return false
  if (st !== 'FT' && st !== 'FINISHED' && st !== 'ENDED') {
    const sh = m.scoreHome ?? m.score?.home
    const sa = m.scoreAway ?? m.score?.away
    if ((sh === null || sh === undefined) && (sa === null || sa === undefined)) return false
    if (Number(sh) === 0 && Number(sa) === 0) return false
  }
  return true
}

const getScore = (m) => {
  const hRaw = m.scoreHome !== undefined ? m.scoreHome : m.score?.home
  const aRaw = m.scoreAway !== undefined ? m.scoreAway : m.score?.away
  if (hRaw === null || hRaw === undefined || aRaw === null || aRaw === undefined) return null
  const h = Number(hRaw)
  const a = Number(aRaw)
  if (isNaN(h) || isNaN(a)) return null
  return { h, a, total: h + a }
}

const extractPick = (m) => {
  let pick = ''
  const q = m.quant || m._quant
  if (q && q.main_pick) {
    pick = String(q.main_pick).toLowerCase()
  } else if (m.predictions && m.predictions[0] && m.predictions[0].val) {
    pick = String(m.predictions[0].val).toLowerCase()
  } else {
    pick = String(m.prediction || '').toLowerCase()
  }
  return pick
}

const classifyMarket = (pick) => {
  if (pick.includes('ht:') || pick.includes('first_half') || pick === 'ht: o0.5' || pick === 'ht: o1.5') return 'HT'
  if (pick === '1x' || pick === 'dc: 1x' || pick === 'dc:1x') return 'DC'
  if (pick === 'x2' || pick === 'dc: x2' || pick === 'dc:x2') return 'DC'
  if (pick === '12' || pick === 'dc: 12' || pick === 'dc:12') return 'DC'
  if (pick.includes('home') || pick.includes('dom') || pick === '1' || pick.includes(' 1 ')) return '1X2'
  if (pick.includes('away') || pick.includes('ext') || pick === '2' || pick.includes(' 2 ')) return '1X2'
  if (pick.includes('draw') || pick.includes('nul') || pick === 'x' || pick.includes(' x ')) return '1X2'
  if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui')) return 'BTTS'
  if (pick.includes('+1.5') || pick.includes('-1.5') || pick.includes('+2.5') || pick.includes('-2.5') || pick.includes('+3.5') || pick.includes('-3.5')) return 'OU'
  if (pick.includes('over25') || pick.includes('under25')) return 'OU'
  if (pick.includes('+0.5') || pick.includes('-0.5') || pick.includes('handicap') || pick.includes('hcp')) return 'HCP'
  return null
}

const evaluatePick = (pick, score) => {
  const { h, a, total } = score
  if (pick === '1x' || pick === 'dc: 1x' || pick === 'dc:1x') return h >= a
  if (pick === 'x2' || pick === 'dc: x2' || pick === 'dc:x2') return a >= h
  if (pick === '12' || pick === 'dc: 12' || pick === 'dc:12') return h !== a
  if (pick.includes('home') || pick.includes('dom') || pick === '1' || pick.includes(' 1 ')) return h > a
  if (pick.includes('away') || pick.includes('ext') || pick === '2' || pick.includes(' 2 ')) return a > h
  if (pick.includes('draw') || pick.includes('nul') || pick === 'x' || pick.includes(' x ')) return h === a
  if (pick.includes('+1.5') || pick.includes('over 1.5')) return total > 1.5
  if (pick.includes('-1.5') || pick.includes('under 1.5')) return total < 1.5
  if (pick.includes('+2.5') || pick.includes('over 2.5') || pick === 'over25') return total > 2.5
  if (pick.includes('-2.5') || pick.includes('under 2.5') || pick === 'under25') return total < 2.5
  if (pick.includes('+3.5') || pick.includes('over 3.5')) return total > 3.5
  if (pick.includes('-3.5') || pick.includes('under 3.5')) return total < 3.5
  if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui')) return h > 0 && a > 0
  return false
}

const isNonStandard = (pick) => {
  return pick.includes('risky bet') || pick.includes('skip') || pick.includes('no bet') ||
    pick.includes('البطاقات') || pick.includes('cards') || pick.includes('corner') ||
    pick === 'null' || pick === 'undefined' || pick === ''
}

const CONFIDENCE_BRACKETS = [
  { min: 0, max: 50, label: '< 50%' },
  { min: 50, max: 60, label: '50-60%' },
  { min: 60, max: 70, label: '60-70%' },
  { min: 70, max: 80, label: '70-80%' },
  { min: 80, max: 101, label: '80%+' },
]

const PerformanceAnalytics = ({ matches, onTrackRecord }) => {
  const [expanded, setExpanded] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)
  const [forceData, setForceData] = useState(null)
  const [forceLoading, setForceLoading] = useState(false)
  const [forceError, setForceError] = useState(null)

  const fetchForceAnalysis = useCallback(async () => {
    setForceLoading(true)
    setForceError(null)
    try {
      const resp = await fetch('/api/analytics/performance')
      const json = await resp.json()
      if (json.success) {
        setForceData(json)
      } else {
        setForceError(json.error || 'Unknown error')
      }
    } catch (e) {
      setForceError(e.message)
    } finally {
      setForceLoading(false)
    }
  }, [])

  const stats = useMemo(() => {
    const finished = matches.filter(m => isFinished(m))
    if (finished.length === 0) return null

    const overall = { total: 0, wins: 0, profit: 0, verifiable: 0 }
    const byMarket = {}
    const byConfidence = {}
    const byLeague = {}
    const trendResults = []
    const marketPicks = {}

    CONFIDENCE_BRACKETS.forEach(b => { byConfidence[b.label] = { total: 0, wins: 0, profit: 0 } })

    finished.forEach(m => {
      const score = getScore(m)
      if (!score) return

      let pick = extractPick(m)
      const rawConf = m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0
      const conf = rawConf > 1 ? rawConf : rawConf * 100

      if (isNonStandard(pick)) {
        const extractProb = (val) => {
          if (!val) return 0
          if (typeof val === 'number') return val
          const parsed = parseFloat(String(val).replace('%', ''))
          return isNaN(parsed) ? 0 : parsed
        }
        let enriched = m.enriched
        if (typeof enriched === 'string') {
          try { enriched = JSON.parse(enriched) } catch (e) { enriched = {} }
        }
        const hPct = extractProb(m.home_win_probability || enriched?.winnerProbability || 0)
        const aPct = extractProb(m.away_win_probability || 0)
        const pBTTS = extractProb(m.btts_prob || enriched?.btts_prob || 0)
        const pOU25 = extractProb(m.ou_25_prob || enriched?.ou_25_prob || 0)

        if (pOU25 > 65) pick = 'over25'
        else if (pBTTS > 65) pick = 'btts'
        else if (hPct > aPct && hPct > 50) pick = 'home'
        else if (aPct > hPct && aPct > 50) pick = 'away'
        else if (pOU25 <= 40 && pBTTS <= 40) pick = 'under25'
        else return
      }

      const market = classifyMarket(pick)
      if (!market) return

      const isWin = evaluatePick(pick, score)
      const profit = isWin ? 0.85 : -1

      overall.verifiable++
      if (isWin) { overall.wins++; overall.profit += 0.85 } else { overall.profit -= 1 }

      if (!byMarket[market]) byMarket[market] = { total: 0, wins: 0, profit: 0 }
      byMarket[market].total++
      if (isWin) byMarket[market].wins++
      byMarket[market].profit += profit

      const bracket = CONFIDENCE_BRACKETS.find(b => conf >= b.min && conf < b.max)
      if (bracket) {
        byConfidence[bracket.label].total++
        if (isWin) byConfidence[bracket.label].wins++
        byConfidence[bracket.label].profit += profit
      }

      const league = m.league || 'Unknown'
      if (!byLeague[league]) byLeague[league] = { total: 0, wins: 0, profit: 0 }
      byLeague[league].total++
      if (isWin) byLeague[league].wins++
      byLeague[league].profit += profit

      if (!marketPicks[market]) marketPicks[market] = []
      marketPicks[market].push({ isWin, label: `${m.homeTeam || ''} vs ${m.awayTeam || ''}`, pick, score: `${score.h}-${score.a}` })

      trendResults.push(isWin ? 1 : 0)
    })

    const winRate = overall.verifiable > 0 ? Math.round((overall.wins / overall.verifiable) * 100) : 0
    const roi = overall.verifiable > 0 ? Math.round((overall.profit / overall.verifiable) * 100) : 0

    const marketStats = Object.entries(byMarket).map(([key, data]) => ({
      market: key,
      icon: MARKET_LABELS[key]?.icon || '📌',
      label: MARKET_LABELS[key]?.label || key,
      total: data.total,
      wins: data.wins,
      winRate: Math.round((data.wins / data.total) * 100),
      profit: Math.round(data.profit * 100) / 100,
      roi: Math.round((data.profit / data.total) * 100),
    })).sort((a, b) => b.winRate - a.winRate)

    const confStats = Object.entries(byConfidence).map(([label, data]) => ({
      label,
      total: data.total,
      wins: data.wins,
      winRate: data.total > 0 ? Math.round((data.wins / data.total) * 100) : 0,
      profit: Math.round(data.profit * 100) / 100,
    }))

    const leagueRanking = Object.entries(byLeague)
      .map(([league, data]) => ({
        league,
        total: data.total,
        wins: data.wins,
        winRate: Math.round((data.wins / data.total) * 100),
        profit: Math.round(data.profit * 100) / 100,
      }))
      .sort((a, b) => b.winRate - a.winRate)

    const avgConf = Math.round(
      finished.reduce((acc, m) => {
        const rawConf = m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0
        return acc + (rawConf > 1 ? rawConf : rawConf * 100)
      }, 0) / (finished.length || 1)
    )

    return {
      total: overall.verifiable,
      wins: overall.wins,
      winRate,
      profit: Math.round(overall.profit * 100) / 100,
      roi,
      avgConf,
      marketStats,
      confStats,
      leagueRanking,
      trendResults: trendResults.slice(-30),
      bestLeague: leagueRanking[0]?.league || 'N/A',
    }
  }, [matches])

  if (!stats) {
    return (
      <div style={{
        padding: '14px 20px', background: 'rgba(15, 23, 42, 0.5)',
        borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.07)',
        textAlign: 'center', marginBottom: '16px', backdropFilter: 'blur(4px)',
      }}>
        <span style={{ color: '#334155', fontSize: '11px', letterSpacing: '1.2px', textTransform: 'uppercase' }}>
          📊 ANALYTICS DE PERFORMANCE — En attente de résultats...
        </span>
      </div>
    )
  }

  const isPositive = stats.roi >= 0

  const cardBase = {
    background: 'linear-gradient(145deg, rgba(8, 14, 28, 0.97) 0%, rgba(13, 20, 38, 0.92) 100%)',
    padding: '16px 18px 14px', borderRadius: '12px', position: 'relative', overflow: 'hidden',
    backdropFilter: 'blur(8px)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  }
  const accentLine = (color) => ({
    position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
    background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
    boxShadow: `0 0 10px ${color}`,
  })
  const cardLabel = {
    fontSize: '9px', fontWeight: '900', letterSpacing: '1.8px',
    textTransform: 'uppercase', color: '#2d3f56', marginBottom: '8px',
  }
  const bigNumber = (color) => ({
    fontSize: '30px', fontWeight: '900', color, lineHeight: 1,
    fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-1px',
  })
  const subText = { fontSize: '10px', color: '#475569', marginTop: '6px', letterSpacing: '0.2px' }

  const winRatePct = Math.min(stats.winRate, 100)

  const trendColor = stats.roi >= 0 ? '#00ffaa' : '#ef4444'

  return (
    <div style={{ marginBottom: '18px' }}>
      {/* Top row: Overall stats */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
        gap: '12px', marginBottom: '12px',
      }}>
        <div className="onyx-stat-card" style={{ ...cardBase, border: `1px solid ${isPositive ? 'rgba(0,255,170,0.18)' : 'rgba(239,68,68,0.18)'}` }}>
          <div style={accentLine(isPositive ? '#00ffaa' : '#ef4444')} />
          <span style={cardLabel}>Profit Net / ROI</span>
          <div style={bigNumber(isPositive ? '#00ffaa' : '#ef4444')}>
            {isPositive ? '+' : ''}{stats.roi}%
          </div>
          <div style={subText}>
            <span style={{ color: isPositive ? 'rgba(0,255,170,0.6)' : 'rgba(239,68,68,0.6)', marginRight: 4 }}>
              {isPositive ? '▲' : '▼'}
            </span>
            {stats.profit} unités ({stats.total} pronos)
          </div>
        </div>

        <div className="onyx-stat-card" style={{ ...cardBase, border: '1px solid rgba(251,191,36,0.18)' }}>
          <div style={accentLine('#fbbf24')} />
          <span style={cardLabel}>Taux de Réussite</span>
          <div style={bigNumber('#fbbf24')}>{stats.winRate}%</div>
          <div style={{ height: '3px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', margin: '8px 0 0', overflow: 'hidden' }}>
            <div style={{
              width: `${winRatePct}%`, height: '100%', borderRadius: '2px',
              background: winRatePct >= 60 ? 'linear-gradient(90deg, #d97706, #fbbf24)' : 'linear-gradient(90deg, #92400e, #d97706)',
              boxShadow: '0 0 6px rgba(251,191,36,0.4)',
              transition: 'width 1.2s cubic-bezier(0.4,0,0.2,1)',
            }} />
          </div>
          <div style={subText}>{stats.wins} gagnés / {stats.total} vérifiés</div>
        </div>

        <div className="onyx-stat-card" style={{ ...cardBase, border: '1px solid rgba(56,189,248,0.18)' }}>
          <div style={accentLine('#38bdf8')} />
          <span style={cardLabel}>Meilleur Championnat</span>
          <div style={{ fontSize: '12.5px', fontWeight: '800', color: '#38bdf8', marginTop: '8px', lineHeight: 1.35, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            🏆 {stats.bestLeague.length > 22 ? stats.bestLeague.slice(0, 22) + '…' : stats.bestLeague}
          </div>
          <div style={subText}>Performance maximale détectée</div>
        </div>

        <div className="onyx-stat-card" style={{ ...cardBase, border: '1px solid rgba(168,85,247,0.18)' }}>
          <div style={accentLine('#a855f7')} />
          <span style={cardLabel}>Confiance IA Moyenne</span>
          <div style={bigNumber('#a855f7')}>{stats.avgConf}%</div>
          <div style={subText}>
            <span style={{ display: 'inline-block', width: 6, height: 6, background: '#a855f7', borderRadius: '50%', marginRight: 5, verticalAlign: 'middle', boxShadow: '0 0 6px #a855f7', animation: 'onyx-pulse-dot 2s ease-in-out infinite' }} />
            Moteur Neural-X actif
          </div>
        </div>
      </div>

      {/* Trend sparkline */}
      {stats.trendResults.length > 0 && (
        <div style={{ ...cardBase, border: `1px solid rgba(${trendColor === '#00ffaa' ? '0,255,170' : '239,68,68'},0.15)`, padding: '10px 18px', marginBottom: '12px' }}>
          <div style={{ ...cardLabel, marginBottom: '4px' }}>📈 Tendance ({stats.trendResults.length} derniers)</div>
          <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '24px' }}>
            {stats.trendResults.map((r, i) => (
              <div key={i} style={{
                flex: 1, height: r ? '24px' : '8px',
                background: r ? 'rgba(0,255,170,0.4)' : 'rgba(239,68,68,0.4)',
                borderRadius: '1px', transition: 'height 0.3s, background 0.3s',
                minWidth: '2px',
              }} title={r ? '✅ Gagné' : '❌ Perdu'} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
            <span style={{ ...subText, marginTop: 0, fontSize: '8px' }}>🟢 {stats.trendResults.filter(r => r).length}W</span>
            <span style={{ ...subText, marginTop: 0, fontSize: '8px' }}>🔴 {stats.trendResults.filter(r => !r).length}L</span>
            <span style={{ ...subText, marginTop: 0, fontSize: '8px' }}>
              {Math.round((stats.trendResults.filter(r => r).length / stats.trendResults.length) * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* Expandable: Market breakdown + confidence brackets */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
        <button onClick={() => setExpanded(!expanded)} style={{
          padding: '6px 14px', borderRadius: '6px', border: `1px solid ${expanded ? '#38bdf8' : '#334155'}`,
          background: expanded ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.04)',
          color: expanded ? '#38bdf8' : '#94a3b8', fontWeight: '700', fontSize: '10px',
          cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.5px',
        }}>
          {expanded ? '▼' : '▶'} ANALYSE DÉTAILLÉE PAR MARCHÉ
        </button>
        {onTrackRecord && (
          <button onClick={onTrackRecord} style={{
            padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(139,92,246,0.3)',
            background: 'rgba(139,92,246,0.08)', color: '#a78bfa', fontWeight: '700', fontSize: '10px',
            cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.5px',
          }}>
            📋 HISTORIQUE COMPLET
          </button>
        )}
        <button onClick={() => { setForceOpen(true); fetchForceAnalysis() }} style={{
          padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(249,115,22,0.3)',
          background: 'rgba(249,115,22,0.08)', color: '#fb923c', fontWeight: '700', fontSize: '10px',
          cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.5px',
        }}>
          🔬 FORCE ANALYSIS
        </button>
      </div>

      {expanded && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          {/* Market breakdown */}
          <div style={{ ...cardBase, border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={accentLine('#38bdf8')} />
            <span style={cardLabel}>📊 Performance par Marché</span>
            {stats.marketStats.length === 0 ? (
              <div style={{ ...subText, textAlign: 'center', padding: '12px 0' }}>Aucun marché vérifié</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {stats.marketStats.map(m => {
                  const pct = Math.min(m.winRate, 100)
                  const mIsPositive = m.roi >= 0
                  return (
                    <div key={m.market} style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '8px 10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: '800', color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          {m.icon} {m.label}
                        </span>
                        <span style={{
                          fontSize: '11px', fontWeight: '900', fontFamily: "'JetBrains Mono', monospace",
                          color: mIsPositive ? '#00ffaa' : '#ef4444',
                        }}>
                          {mIsPositive ? '+' : ''}{m.roi}% ROI
                        </span>
                      </div>
                      <div style={{ height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginBottom: '3px' }}>
                        <div style={{
                          width: `${pct}%`, height: '100%', borderRadius: '2px',
                          background: pct >= 60 ? 'linear-gradient(90deg, #059669, #00ffaa)' :
                                       pct >= 50 ? 'linear-gradient(90deg, #d97706, #fbbf24)' :
                                       'linear-gradient(90deg, #991b1b, #ef4444)',
                        }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#64748b' }}>
                        <span>{m.winRate}% ({m.wins}/{m.total})</span>
                        <span>{m.profit > 0 ? '+' : ''}{m.profit}u</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Confidence bracket breakdown */}
          <div style={{ ...cardBase, border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={accentLine('#a855f7')} />
            <span style={cardLabel}>🎯 Performance par Confiance</span>
            {stats.confStats.filter(c => c.total > 0).length === 0 ? (
              <div style={{ ...subText, textAlign: 'center', padding: '12px 0' }}>Aucune donnée de confiance</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {stats.confStats.filter(c => c.total > 0).map(c => {
                  const pct = Math.min(c.winRate, 100)
                  const cPos = c.roi >= 0
                  return (
                    <div key={c.label} style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '8px 10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: '800', color: '#e2e8f0' }}>
                          {c.label}
                        </span>
                        <span style={{
                          fontSize: '11px', fontWeight: '900', fontFamily: "'JetBrains Mono', monospace",
                          color: cPos ? '#00ffaa' : '#ef4444',
                        }}>
                          {c.profit > 0 ? '+' : ''}{c.profit}u
                        </span>
                      </div>
                      <div style={{ height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginBottom: '3px' }}>
                        <div style={{
                          width: `${pct}%`, height: '100%', borderRadius: '2px',
                          background: pct >= 60 ? 'linear-gradient(90deg, #059669, #00ffaa)' :
                                       pct >= 50 ? 'linear-gradient(90deg, #d97706, #fbbf24)' :
                                       'linear-gradient(90deg, #991b1b, #ef4444)',
                        }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#64748b' }}>
                        <span>{c.winRate}% ({c.wins}/{c.total})</span>
                        <span>{c.total} pronos</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* League ranking */}
          <div style={{ ...cardBase, border: '1px solid rgba(255,255,255,0.06)', gridColumn: '1 / -1' }}>
            <div style={accentLine('#fbbf24')} />
            <span style={cardLabel}>🏆 Classement des Championnats</span>
            {stats.leagueRanking.length === 0 ? (
              <div style={{ ...subText, textAlign: 'center', padding: '12px 0' }}>Aucune ligue vérifiée</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                {/* Top 5 */}
                <div>
                  <span style={{ fontSize: '9px', fontWeight: '700', color: '#00ffaa', display: 'block', marginBottom: '4px' }}>
                    🟢 TOP 5
                  </span>
                  {stats.leagueRanking.slice(0, 5).map((l, i) => (
                    <div key={l.league} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '3px 8px', borderRadius: '4px', fontSize: '9px',
                      background: i % 2 === 0 ? 'rgba(0,0,0,0.2)' : 'transparent',
                    }}>
                      <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {i + 1}. {l.league.split(' ').slice(0, 3).join(' ')}
                      </span>
                      <span style={{
                        fontWeight: '800', fontFamily: "'JetBrains Mono', monospace",
                        color: l.profit >= 0 ? '#00ffaa' : '#ef4444', marginLeft: '8px',
                      }}>
                        {l.profit > 0 ? '+' : ''}{l.profit}u
                      </span>
                      <span style={{ fontWeight: '700', color: '#94a3b8', marginLeft: '6px', minWidth: '35px', textAlign: 'right' }}>
                        {l.winRate}%
                      </span>
                    </div>
                  ))}
                </div>
                {/* Bottom 5 */}
                <div>
                  <span style={{ fontSize: '9px', fontWeight: '700', color: '#f87171', display: 'block', marginBottom: '4px' }}>
                    🔴 BOTTOM 5
                  </span>
                  {stats.leagueRanking.slice(-5).reverse().map((l, i) => (
                    <div key={l.league} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '3px 8px', borderRadius: '4px', fontSize: '9px',
                      background: i % 2 === 0 ? 'rgba(0,0,0,0.2)' : 'transparent',
                    }}>
                      <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {stats.leagueRanking.length - 4 + i}. {l.league.split(' ').slice(0, 3).join(' ')}
                      </span>
                      <span style={{
                        fontWeight: '800', fontFamily: "'JetBrains Mono', monospace",
                        color: l.profit >= 0 ? '#00ffaa' : '#ef4444', marginLeft: '8px',
                      }}>
                        {l.profit > 0 ? '+' : ''}{l.profit}u
                      </span>
                      <span style={{ fontWeight: '700', color: '#94a3b8', marginLeft: '6px', minWidth: '35px', textAlign: 'right' }}>
                        {l.winRate}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Force Analysis Modal */}
      {forceOpen && (
        <div onClick={() => setForceOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 99999,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '20px',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            maxWidth: '680px', width: '100%', maxHeight: '90vh', overflow: 'auto',
            background: 'linear-gradient(145deg, rgba(8,14,28,0.99) 0%, rgba(13,20,38,0.96) 100%)',
            borderRadius: '16px', border: '1px solid rgba(255,255,255,0.08)',
            padding: '24px', position: 'relative',
          }}>
            <button onClick={() => setForceOpen(false)} style={{
              position: 'absolute', top: 12, right: 16,
              background: 'none', border: 'none', color: '#64748b', fontSize: '20px',
              cursor: 'pointer', fontFamily: 'inherit',
            }}>✕</button>

            <span style={{
              fontSize: '10px', fontWeight: '900', letterSpacing: '2px',
              textTransform: 'uppercase', color: '#2d3f56', marginBottom: '12px', display: 'block',
            }}>🔬 FORCE ANALYSIS — Résultats Serveur</span>

            {forceLoading && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b', fontSize: '12px' }}>
                Chargement...
              </div>
            )}

            {forceError && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#ef4444', fontSize: '12px' }}>
                ❌ {forceError}
              </div>
            )}

            {forceData && (
              <>
                {/* KPI row */}
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                  gap: '10px', marginBottom: '16px',
                }}>
                  {[
                    { label: 'Réglés', value: forceData.total_settled, color: '#94a3b8' },
                    { label: 'Gagnés', value: forceData.won, color: '#00ffaa' },
                    { label: 'Perdus', value: forceData.lost, color: '#ef4444' },
                    { label: 'Win Rate', value: `${forceData.win_rate}%`, color: forceData.win_rate >= 60 ? '#00ffaa' : '#fbbf24' },
                    { label: 'ROI', value: `${forceData.roi_percent >= 0 ? '+' : ''}${forceData.roi_percent}%`, color: forceData.roi_percent >= 0 ? '#00ffaa' : '#ef4444' },
                    { label: 'Profit', value: `${forceData.profit_units >= 0 ? '+' : ''}${forceData.profit_units}u`, color: forceData.profit_units >= 0 ? '#00ffaa' : '#ef4444' },
                  ].map(kpi => (
                    <div key={kpi.label} style={{
                      background: 'rgba(0,0,0,0.4)', borderRadius: '10px',
                      padding: '10px 12px', textAlign: 'center',
                    }}>
                      <div style={{ fontSize: '9px', fontWeight: '700', color: '#475569', marginBottom: '4px', letterSpacing: '0.5px' }}>{kpi.label}</div>
                      <div style={{ fontSize: '20px', fontWeight: '900', color: kpi.color, fontFamily: "'JetBrains Mono', monospace" }}>{kpi.value}</div>
                    </div>
                  ))}
                </div>

                {/* By Confidence */}
                {forceData.by_confidence && (
                  <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '12px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '9px', fontWeight: '800', color: '#a855f7', letterSpacing: '1px', marginBottom: '6px', display: 'block' }}>
                      🎯 PAR CONFIANCE
                    </span>
                    <table style={{ width: '100%', fontSize: '10px', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ color: '#475569', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: '700' }}>Bracket</th>
                          <th style={{ textAlign: 'center', padding: '4px 6px', fontWeight: '700' }}>W</th>
                          <th style={{ textAlign: 'center', padding: '4px 6px', fontWeight: '700' }}>L</th>
                          <th style={{ textAlign: 'center', padding: '4px 6px', fontWeight: '700' }}>Total</th>
                          <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: '700' }}>Win Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(forceData.by_confidence).map(([bracket, data]) => (
                          data.total > 0 && (
                            <tr key={bracket} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                              <td style={{ padding: '4px 6px', color: '#e2e8f0' }}>{bracket}</td>
                              <td style={{ textAlign: 'center', padding: '4px 6px', color: '#00ffaa' }}>{data.won}</td>
                              <td style={{ textAlign: 'center', padding: '4px 6px', color: '#ef4444' }}>{data.lost}</td>
                              <td style={{ textAlign: 'center', padding: '4px 6px', color: '#94a3b8' }}>{data.total}</td>
                              <td style={{ textAlign: 'right', padding: '4px 6px', fontWeight: '700', color: data.win_rate >= 60 ? '#00ffaa' : data.win_rate >= 50 ? '#fbbf24' : '#ef4444' }}>{data.win_rate}%</td>
                            </tr>
                          )
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* By Market */}
                {forceData.by_market && (
                  <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '12px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '9px', fontWeight: '800', color: '#38bdf8', letterSpacing: '1px', marginBottom: '6px', display: 'block' }}>
                      📊 PAR MARCHÉ
                    </span>
                    <table style={{ width: '100%', fontSize: '10px', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ color: '#475569', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: '700' }}>Marché</th>
                          <th style={{ textAlign: 'center', padding: '4px 6px', fontWeight: '700' }}>W</th>
                          <th style={{ textAlign: 'center', padding: '4px 6px', fontWeight: '700' }}>L</th>
                          <th style={{ textAlign: 'center', padding: '4px 6px', fontWeight: '700' }}>Total</th>
                          <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: '700' }}>Win Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(forceData.by_market).map(([market, data]) => (
                          data.total > 0 && (
                            <tr key={market} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                              <td style={{ padding: '4px 6px', color: '#e2e8f0' }}>{market}</td>
                              <td style={{ textAlign: 'center', padding: '4px 6px', color: '#00ffaa' }}>{data.won}</td>
                              <td style={{ textAlign: 'center', padding: '4px 6px', color: '#ef4444' }}>{data.lost}</td>
                              <td style={{ textAlign: 'center', padding: '4px 6px', color: '#94a3b8' }}>{data.total}</td>
                              <td style={{ textAlign: 'right', padding: '4px 6px', fontWeight: '700', color: data.win_rate >= 60 ? '#00ffaa' : data.win_rate >= 50 ? '#fbbf24' : '#ef4444' }}>{data.win_rate}%</td>
                            </tr>
                          )
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Weekly trend */}
                {forceData.trend && forceData.trend.length > 0 && (
                  <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '12px' }}>
                    <span style={{ fontSize: '9px', fontWeight: '800', color: '#fbbf24', letterSpacing: '1px', marginBottom: '6px', display: 'block' }}>
                      📈 TENDANCE 7 JOURS
                    </span>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end', height: '30px', marginBottom: '4px' }}>
                      {forceData.trend.map((d, i) => {
                        const maxTotal = Math.max(...forceData.trend.map(x => x.total), 1)
                        const h = Math.max(4, (d.total / maxTotal) * 30)
                        return (
                          <div key={d.date} style={{
                            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', justifyContent: 'flex-end',
                          }}>
                            <div style={{
                              width: '100%', height: `${h}px`, borderRadius: '2px',
                              background: d.win_rate >= 60 ? 'rgba(0,255,170,0.5)' : d.win_rate >= 50 ? 'rgba(251,191,36,0.5)' : 'rgba(239,68,68,0.5)',
                              minWidth: '8px',
                            }} title={`${d.date}: ${d.win_rate}% (${d.won}W ${d.lost}L)`} />
                          </div>
                        )
                      })}
                    </div>
                    <div style={{ fontSize: '8px', color: '#475569', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{forceData.trend[0]?.date || ''}</span>
                      <span>{forceData.trend[forceData.trend.length - 1]?.date || ''}</span>
                    </div>
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
