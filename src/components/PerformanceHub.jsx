import React, { useMemo } from 'react'

const PerformanceHub = ({ matches }) => {
  const stats = useMemo(() => {
    const finished = matches.filter((m) => {
      const st = (m.status || '').toUpperCase()
      if (st === 'NOT_STARTED' || st === 'SCHEDULED' || st === '' || st === 'NS') return false
      if (st === 'IN_PLAY' || st === 'LIVE' || st === '1H' || st === '2H' || st === 'HT')
        return false
      if (st !== 'FT' && st !== 'FINISHED' && st !== 'ENDED') {
        const sh = m.scoreHome ?? m.score?.home
        const sa = m.scoreAway ?? m.score?.away
        if ((sh === null || sh === undefined) && (sa === null || sa === undefined)) return false
        if (Number(sh) === 0 && Number(sa) === 0) return false
      }
      return true
    })

    if (finished.length === 0) return null

    let wins = 0
    let totalProfit = 0
    const leagueStats = {}
    let verifiableCount = 0

    finished.forEach((m) => {
      const hRaw = m.scoreHome !== undefined ? m.scoreHome : m.score?.home
      const aRaw = m.scoreAway !== undefined ? m.scoreAway : m.score?.away
      if (hRaw === null || hRaw === undefined || aRaw === null || aRaw === undefined) return
      const h = Number(hRaw)
      const a = Number(aRaw)
      if (isNaN(h) || isNaN(a)) return
      const total = h + a

      let pick = ''
      const q = m.quant || m._quant
      if (q && q.main_pick) {
        pick = String(q.main_pick).toLowerCase()
      } else if (m.predictions && m.predictions[0] && m.predictions[0].val) {
        pick = String(m.predictions[0].val).toLowerCase()
      } else {
        pick = String(m.prediction || '').toLowerCase()
      }
      let isVerifiable = true
      let isWin = false

      if (
        pick.includes('risky bet') ||
        pick.includes('skip') ||
        pick.includes('no bet') ||
        pick.includes('البطاقات') ||
        pick.includes('cards') ||
        pick.includes('corner') ||
        pick === 'null' ||
        pick === 'undefined' ||
        pick === ''
      ) {
        const extractProb = (val) => {
          if (!val) return 0
          if (typeof val === 'number') return val
          const parsed = parseFloat(String(val).replace('%', ''))
          return isNaN(parsed) ? 0 : parsed
        }
        let enriched = m.enriched
        if (typeof enriched === 'string') {
          try {
            enriched = JSON.parse(enriched)
          } catch (e) {
            enriched = {}
          }
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
        else isVerifiable = false
      }

      if (isVerifiable) {
        if (
          pick.includes('ht:') ||
          pick.includes('first_half') ||
          pick === 'ht: o0.5' ||
          pick === 'ht: o1.5'
        ) {
          isVerifiable = false // Pas de score MT disponible pour vérifier
        } else if (pick === '1x' || pick === 'dc: 1x' || pick === 'dc:1x') isWin = h >= a
        else if (pick === 'x2' || pick === 'dc: x2' || pick === 'dc:x2') isWin = a >= h
        else if (pick === '12' || pick === 'dc: 12' || pick === 'dc:12') isWin = h !== a
        else if (
          pick.includes('home') ||
          pick.includes('dom') ||
          pick === '1' ||
          pick.includes(' 1 ')
        )
          isWin = h > a
        else if (
          pick.includes('away') ||
          pick.includes('ext') ||
          pick === '2' ||
          pick.includes(' 2 ')
        )
          isWin = a > h
        else if (
          pick.includes('draw') ||
          pick.includes('nul') ||
          pick === 'x' ||
          pick.includes(' x ')
        )
          isWin = h === a
        else if (pick.includes('+1.5') || pick.includes('over 1.5')) isWin = total > 1.5
        else if (pick.includes('-1.5') || pick.includes('under 1.5')) isWin = total < 1.5
        else if (pick.includes('+2.5') || pick.includes('over 2.5') || pick === 'over25')
          isWin = total > 2.5
        else if (pick.includes('-2.5') || pick.includes('under 2.5') || pick === 'under25')
          isWin = total < 2.5
        else if (pick.includes('+3.5') || pick.includes('over 3.5')) isWin = total > 3.5
        else if (pick.includes('-3.5') || pick.includes('under 3.5')) isWin = total < 3.5
        else if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui'))
          isWin = h > 0 && a > 0
        else isVerifiable = false
      }

      if (isVerifiable) {
        verifiableCount++
        if (isWin) {
          wins++
          totalProfit += 0.85
        } else {
          totalProfit -= 1
        }
        const league = m.league || 'Unknown'
        if (!leagueStats[league]) leagueStats[league] = { total: 0, wins: 0 }
        leagueStats[league].total++
        if (isWin) leagueStats[league].wins++
      }
    })

    const winRate = verifiableCount > 0 ? Math.round((wins / verifiableCount) * 100) : 0
    const roi = verifiableCount > 0 ? Math.round((totalProfit / verifiableCount) * 100) : 0
    const bestLeague = Object.entries(leagueStats).sort(
      (a, b) => b[1].wins / b[1].total - a[1].wins / a[1].total
    )[0]

    return {
      total: verifiableCount,
      wins,
      winRate,
      roi,
      bestLeague: bestLeague ? bestLeague[0] : 'N/A',
      profitUnits: totalProfit.toFixed(2),
    }
  }, [matches])

  if (!stats)
    return (
      <div
        style={{
          padding: '14px 20px',
          background: 'rgba(15, 23, 42, 0.5)',
          borderRadius: '12px',
          border: '1px dashed rgba(255,255,255,0.07)',
          textAlign: 'center',
          marginBottom: '16px',
          backdropFilter: 'blur(4px)',
        }}
      >
        <span
          style={{
            color: '#334155',
            fontSize: '11px',
            letterSpacing: '1.2px',
            textTransform: 'uppercase',
          }}
        >
          📊 HUB DE PERFORMANCE — En attente de résultats...
        </span>
      </div>
    )

  const isPositive = stats.roi >= 0

  // Shared card base
  const cardBase = {
    background: 'linear-gradient(145deg, rgba(8, 14, 28, 0.97) 0%, rgba(13, 20, 38, 0.92) 100%)',
    padding: '16px 18px 14px',
    borderRadius: '12px',
    position: 'relative',
    overflow: 'hidden',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    transition: 'transform 0.25s ease, box-shadow 0.25s ease',
  }

  // Reusable helpers
  const accentLine = (color) => ({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '2px',
    background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
    boxShadow: `0 0 10px ${color}`,
  })
  const cardLabel = {
    fontSize: '9px',
    fontWeight: '900',
    letterSpacing: '1.8px',
    textTransform: 'uppercase',
    color: '#2d3f56',
    display: 'block',
    marginBottom: '8px',
  }
  const bigNumber = (color) => ({
    fontSize: '30px',
    fontWeight: '900',
    color,
    lineHeight: 1,
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '-1px',
  })
  const subText = { fontSize: '10px', color: '#475569', marginTop: '6px', letterSpacing: '0.2px' }

  const winRatePct = Math.min(stats.winRate, 100)
  const avgConf = Math.round(
    matches.reduce((acc, m) => acc + (m.v22_success_rate || m.confidence || 0), 0) /
      (matches.length || 1)
  )

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
        gap: '12px',
        marginBottom: '18px',
      }}
    >
      {/* ── ROI / PROFIT ── */}
      <div
        className="onyx-stat-card"
        style={{
          ...cardBase,
          border: `1px solid ${isPositive ? 'rgba(0,255,170,0.18)' : 'rgba(239,68,68,0.18)'}`,
        }}
      >
        <div style={accentLine(isPositive ? '#00ffaa' : '#ef4444')} />
        <span style={cardLabel}>Profit Net / ROI</span>
        <div style={bigNumber(isPositive ? '#00ffaa' : '#ef4444')}>
          {isPositive ? '+' : ''}
          {stats.roi}%
        </div>
        <div style={subText}>
          <span
            style={{
              color: isPositive ? 'rgba(0,255,170,0.6)' : 'rgba(239,68,68,0.6)',
              marginRight: 4,
            }}
          >
            {isPositive ? '▲' : '▼'}
          </span>
          {stats.profitUnits} unités nettes
        </div>
      </div>

      {/* ── WIN RATE ── */}
      <div
        className="onyx-stat-card"
        style={{ ...cardBase, border: '1px solid rgba(251,191,36,0.18)' }}
      >
        <div style={accentLine('#fbbf24')} />
        <span style={cardLabel}>Taux de Réussite</span>
        <div style={bigNumber('#fbbf24')}>{stats.winRate}%</div>
        {/* Mini progress bar */}
        <div
          style={{
            height: '3px',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '2px',
            margin: '8px 0 0',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${winRatePct}%`,
              height: '100%',
              borderRadius: '2px',
              background:
                winRatePct >= 60
                  ? 'linear-gradient(90deg, #d97706, #fbbf24)'
                  : 'linear-gradient(90deg, #92400e, #d97706)',
              boxShadow: '0 0 6px rgba(251,191,36,0.4)',
              transition: 'width 1.2s cubic-bezier(0.4,0,0.2,1)',
            }}
          />
        </div>
        <div style={subText}>
          {stats.wins} gagnés / {stats.total} vérifiés
        </div>
      </div>

      {/* ── BEST LEAGUE ── */}
      <div
        className="onyx-stat-card"
        style={{ ...cardBase, border: '1px solid rgba(56,189,248,0.18)' }}
      >
        <div style={accentLine('#38bdf8')} />
        <span style={cardLabel}>Meilleur Championnat</span>
        <div
          style={{
            fontSize: '12.5px',
            fontWeight: '800',
            color: '#38bdf8',
            marginTop: '8px',
            lineHeight: 1.35,
            textTransform: 'uppercase',
            letterSpacing: '0.3px',
          }}
        >
          🏆 {stats.bestLeague.length > 22 ? stats.bestLeague.slice(0, 22) + '…' : stats.bestLeague}
        </div>
        <div style={subText}>Performance maximale détectée</div>
      </div>

      {/* ── AI CONFIDENCE ── */}
      <div
        className="onyx-stat-card"
        style={{ ...cardBase, border: '1px solid rgba(168,85,247,0.18)' }}
      >
        <div style={accentLine('#a855f7')} />
        <span style={cardLabel}>Confiance IA Moyenne</span>
        <div style={bigNumber('#a855f7')}>{avgConf}%</div>
        <div style={subText}>
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              background: '#a855f7',
              borderRadius: '50%',
              marginRight: 5,
              verticalAlign: 'middle',
              boxShadow: '0 0 6px #a855f7',
              animation: 'onyx-pulse-dot 2s ease-in-out infinite',
            }}
          />
          Moteur Neural-X actif
        </div>
      </div>
    </div>
  )
}

export default PerformanceHub
