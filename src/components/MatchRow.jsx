import React, { useEffect } from 'react'

const goldenPulse = `
@keyframes goldenPulse {
  0%, 100% { box-shadow: 0 0 5px rgba(255,215,0,0.2); }
  50% { box-shadow: 0 0 18px rgba(255,215,0,0.6), 0 0 8px rgba(255,215,0,0.1); }
}
`

const G = (p) => ({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: p.bg || 'rgba(255,255,255,0.03)',
  border: p.border || '1px solid rgba(255,255,255,0.06)',
  borderRadius: '8px',
  padding: p.pad || '6px 4px',
  minHeight: p.h || '56px',
  gap: p.gap || '2px',
  ...(p.sx || {}),
})

const L = ({ c, s, w }) => (
  <span
    style={{
      fontSize: s || '8px',
      fontWeight: w || '700',
      color: c || '#64748b',
      letterSpacing: '0.3px',
      textTransform: 'uppercase',
      lineHeight: 1.2,
    }}
  >
    {c}
  </span>
)
const V = ({ c, s, w }) => (
  <span
    style={{
      fontSize: s || '16px',
      fontWeight: w || '900',
      color: c || '#f8fafc',
      fontFamily: "'JetBrains Mono', monospace",
      lineHeight: 1.2,
    }}
  >
    {c}
  </span>
)
const normalizePct = (v) => {
  const n = Number(v || 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1 ? n : n * 100
}

const marketScoreOf = (pct, odds) => {
  if (!pct || pct <= 0) return 0
  const prob = pct / 100
  const implied = odds ? 1 / odds : prob
  const valueRatio = odds ? prob / implied : 1
  return prob * 100 * valueRatio
}

const dominantBoxOf = (hPct, dPct, aPct, ou25Pct, bttsPct, htGoalPct, oddsHome, oddsAway, oddsDraw, oddsOver25, oddsBtts) => {
  const markets = [
    {
      box: 1,
      pct: Math.max(hPct, dPct, aPct),
      odds: (hPct >= dPct && hPct >= aPct) ? oddsHome : (aPct >= hPct && aPct >= dPct) ? oddsAway : oddsDraw,
      label: '1X2',
    },
    {
      box: 3,
      pct: bttsPct,
      odds: oddsBtts,
      label: 'BTTS',
    },
    {
      box: 4,
      pct: ou25Pct,
      odds: oddsOver25,
      label: 'O/U 2.5',
    },
    {
      box: 5,
      pct: htGoalPct,
      odds: null,
      label: 'HT +0.5',
    },
  ]
    .map(m => ({ ...m, score: marketScoreOf(m.pct, m.odds) }))
    .filter(m => m.score > 0)

  if (markets.length === 0) return null
  return markets.reduce((a, b) => b.score > a.score ? b : a, markets[0])
}

const MatchRow = ({ match, isElite, onClick, style, now }) => {
  const enriched = match.enriched || {}
  const hPct = parseFloat(match.home_win_probability || enriched.home_win_probability || 0)
  const aPct = parseFloat(match.away_win_probability || enriched.away_win_probability || 0)
  const dPct = parseFloat(match.draw_probability || enriched.draw_probability || 0)
  const pOU25 = Number(match.ou_25_prob || enriched?.ou_25_prob || 0)
  const pBTTS = Number(match.btts_prob || enriched?.btts_prob || 0)
  const quantObj = match.quant || enriched?.quant
  const mainPick = (quantObj?.main_pick || '').toString().trim().toUpperCase()
  const bttsPct = Math.round(normalizePct(quantObj?.probs?.btts || pBTTS))
  const over25Pct = Math.round(normalizePct(quantObj?.probs?.over25 || pOU25))
  const htGoalPct = Math.min(89, Math.round(normalizePct(quantObj?.probs?.ht_goal ?? enriched?.ht_goal_prob ?? match.ht_goal_prob ?? 0)))
  const oddsHome = parseFloat(match.odds_home || enriched?.odds_home) || null
  const oddsAway = parseFloat(match.odds_away || enriched?.odds_away) || null
  const oddsDraw = parseFloat(match.odds_draw || enriched?.odds_draw) || null
  const oddsOver25 = parseFloat(match.odds_over25 || enriched?.odds_over25) || null
  const oddsBtts = parseFloat(match.odds_btts_yes || enriched?.odds_btts_yes) || null
  const dominant = dominantBoxOf(hPct, dPct, aPct, over25Pct, bttsPct, htGoalPct, oddsHome, oddsAway, oddsDraw, oddsOver25, oddsBtts)
  const goldenBox = dominant ? dominant.box : null

  const getCS = () => {
    const qs = match.quant?.expected_score || enriched?.quant?.expected_score
    if (qs && qs.includes('-')) return qs
    if (match.v22_cs_prediction) {
      const p = match.v22_cs_prediction.split(' - ')[0]
      if (p?.includes('-')) return p
    }
    if (match.cs_predictions?.length > 0) return match.cs_predictions[0].score
    const es = match.expected_score || enriched.expected_score
    if (es?.includes('-')) {
      const [h, a] = es.split('-').map((v) => parseInt(v.trim()))
      if (!isNaN(h) && !isNaN(a) && h + a > 0) return es
    }
    const hAF = parseFloat(enriched.home_avg_scored || match.home_avg_scored || 0)
    const aAF = parseFloat(enriched.away_avg_scored || match.away_avg_scored || 0)
    const hAC = parseFloat(enriched.home_avg_conceded || match.home_avg_conceded || 0)
    const aAC = parseFloat(enriched.away_avg_conceded || match.away_avg_conceded || 0)
    if (hAF > 0 && aAF > 0) return `${Math.round((hAF + aAC) / 2)} - ${Math.round((aAF + hAC) / 2)}`
    const hi = over25Pct > 60 || bttsPct > 62
    if (hPct > 0 || aPct > 0) {
      if (hPct > aPct + 25) return hi ? '2 - 1' : '1 - 0'
      if (aPct > hPct + 25) return hi ? '1 - 2' : '0 - 1'
      if (hPct > aPct + 12) return hi ? '2 - 1' : '1 - 0'
      if (aPct > hPct + 12) return hi ? '1 - 2' : '0 - 1'
      return bttsPct > 58 ? '1 - 1' : hPct >= aPct ? '1 - 0' : '0 - 1'
    }
    return '1 - 1'
  }

  const rawCS = getCS()
  const alignCS = (s, pick) => {
    if (!s?.includes('-')) return s
    const p = s.split('-').map((v) => parseInt(v.trim()))
    if (p.length !== 2 || isNaN(p[0]) || isNaN(p[1])) return s
    const [h, a] = p
    const hi = over25Pct > 60 || bttsPct > 62
    const wH = pick === '1' || pick.includes('HOME')
    const wA = pick === '2' || pick.includes('AWAY')
    const wD = pick === 'X' || pick.includes('DRAW') || pick === 'NUL'
    if (wH && h <= a) return hi ? `${a + 1} - ${a}` : `${Math.max(1, a)} - ${Math.max(0, a - 1)}`
    if (wA && a <= h) return hi ? `${h} - ${h + 1}` : `${Math.max(0, h - 1)} - ${Math.max(1, h)}`
    if (wD && h !== a) {
      const dg = Math.round((h + a) / 2)
      return `${dg} - ${dg}`
    }
    return s
  }
  const cs = alignCS(rawCS, mainPick)

  const rawAcc = match.v22_success_rate || match.enriched?.v22_success_rate || match.confidence
  const pOU25_pct = pOU25 > 1 ? pOU25 : pOU25 * 100
  let acc
  if (rawAcc && rawAcc > 0) {
    let base = rawAcc > 1 ? rawAcc : Math.round(rawAcc * 100)
    const bestMktProb = Math.max(hPct, aPct, dPct, pBTTS)
    if (base === 50 && bestMktProb > 55) base = Math.round(bestMktProb)
    if (bestMktProb > base + 15 && bestMktProb > 60) base = Math.round(bestMktProb)
    if (pBTTS > 70 && pOU25_pct > 70) base = Math.min(97, base + 3)
    if (match.insufficient_data === 1) base = Math.min(base, 64)
    acc = Math.round(base)
  } else {
    const bestProb = Math.max(hPct, aPct, dPct)
    acc = bestProb > 1 ? Math.round(bestProb) : Math.round(bestProb * 100)
    if (pBTTS > 65 && pOU25_pct > 65) acc = Math.min(97, acc + 4)
    if (match.insufficient_data === 1) acc = Math.min(acc, 64)
    if (acc === 0) acc = 50
  }
  acc = Math.max(1, Math.min(99, acc))

  const evNum = parseFloat(quantObj?.ev_score) || 0
  const valueScore = ((evNum * acc) / 100).toFixed(1)

  const altHunter = match.alt_market_hunter || enriched?.alt_market_hunter || null
  const domProb = Math.max(hPct, aPct)
  const hasOdds = !!(match.odds_home && match.odds_away)
  const hasForm = !!(match.home_form_pts || match.away_form_pts)
  const hasStats = !!(match.ou_25_prob || match.btts_prob)
  const dataBonus = (hasOdds ? 2 : 0) + (hasForm ? 2 : 0) + (hasStats ? 2 : 0)
  const hasRealProbs = hPct + aPct > 5
  const isNoData = !hasRealProbs && !hasOdds && !hasStats
  const isBalanced = hasRealProbs && domProb >= 33 && domProb < 52

  let ms, msColor, msDesc
  if (isNoData) {
    ms = null
    msColor = '#475569'
    msDesc = '⏳'
  } else if (match.insufficient_data === 1) {
    ms = Math.max(1, 2 + Math.floor(dataBonus / 3))
    msColor = '#f59e0b'
    msDesc = '⚠️ Faible'
  } else if (isBalanced) {
    ms = Math.min(8, 4 + Math.floor(dataBonus / 2))
    msColor = '#38bdf8'
    msDesc = '🔵 Balance'
  } else if (domProb >= 70) {
    ms = Math.min(10, 7 + Math.floor(dataBonus / 2))
    msColor = '#00ffaa'
    msDesc = '🟢 Haute'
  } else if (domProb >= 55) {
    ms = Math.min(9, 5 + Math.floor(dataBonus / 2))
    msColor = '#fbbf24'
    msDesc = '🟡 Modéré'
  } else {
    ms = Math.min(7, 3 + Math.floor(dataBonus / 2))
    msColor = '#f97316'
    msDesc = '🟠 Spéculatif'
  }

  const homeName = (match.homeTeam || 'N/A').toUpperCase()
  const awayName = (match.awayTeam || 'N/A').toUpperCase()
  let formattedTime = ''
  if (match.startTimestamp) {
    const d = new Date(
      match.startTimestamp > 1e11 ? match.startTimestamp : match.startTimestamp * 1000
    )
    formattedTime = d.toLocaleTimeString('fr-TN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Africa/Tunis',
    })
  }
  let countdownStr = ''
  const matchTime = match.startTimestamp
    ? match.startTimestamp > 1e11
      ? match.startTimestamp
      : match.startTimestamp * 1000
    : 0
  if (now && matchTime > 0) {
    const diff = matchTime - now
    if (diff > 0) {
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      if (h > 24) countdownStr = `${Math.floor(h / 24)}j ${h % 24}h`
      else if (h > 0) countdownStr = `${h}h ${m}m`
      else if (m > 0) countdownStr = `${m}m ${s}s`
      else countdownStr = `${s}s`
    } else if (diff > -7200000) countdownStr = '🔴 EN COURS'
  }

  const hForm = match.home_form_rating || match.enriched?.home_form_rating || 0
  const aForm = match.away_form_rating || match.enriched?.away_form_rating || 0

  let actualScoreDisplay = null
  const status = (match.status || '').toLowerCase()
  if (
    (status === 'finished' || status === 'ft' || status === 'ended') &&
    match.scoreHome !== null &&
    match.scoreAway !== null
  ) {
    actualScoreDisplay = `${match.scoreHome} - ${match.scoreAway}`
  }

  useEffect(() => {
    if (goldenBox) {
      const styleEl = document.getElementById('matchrow-golden-pulse')
      if (!styleEl) {
        const el = document.createElement('style')
        el.id = 'matchrow-golden-pulse'
        el.textContent = goldenPulse
        document.head.appendChild(el)
      }
    }
  }, [goldenBox])

  return (
    <div
      style={{
        ...style,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        background: isElite ? 'linear-gradient(135deg, rgba(0,255,170,0.06), #030712)' : '#080c14',
        border: `1px solid ${isElite ? 'rgba(0,255,170,0.2)' : 'rgba(255,255,255,0.06)'}`,
        borderRadius: '10px',
        padding: '8px 10px',
        cursor: 'pointer',
      }}
      onClick={() => onClick(match)}
    >
      {/* HEADER: Match + League + Time */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
          minHeight: '20px',
        }}
      >
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: countdownStr.includes('EN COURS') ? '#ef4444' : '#22c55e',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: '9px',
            fontWeight: '800',
            color: '#fbbf24',
            fontFamily: "'JetBrains Mono', monospace",
            background: 'rgba(251,191,36,0.1)',
            padding: '1px 4px',
            borderRadius: '3px',
          }}
        >
          {formattedTime}
        </span>
        {countdownStr && !countdownStr.includes('EN COURS') && (
          <span
            style={{
              fontSize: '8px',
              fontWeight: '700',
              color: '#38bdf8',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            -{countdownStr}
          </span>
        )}
        {countdownStr.includes('EN COURS') && (
          <span
            style={{
              fontSize: '8px',
              fontWeight: '900',
              color: '#ef4444',
              animation: 'pulse 1.5s infinite',
            }}
          >
            🔴 LIVE
          </span>
        )}
        <span
          style={{
            fontSize: '9px',
            fontWeight: '700',
            color: '#94a3b8',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {match.league || 'N/A'}
        </span>
        <span style={{ fontSize: '11px', fontWeight: '900', color: '#f8fafc' }}>{homeName}</span>
        <span style={{ fontSize: '9px', color: '#64748b' }}>VS</span>
        <span style={{ fontSize: '11px', fontWeight: '900', color: '#f8fafc' }}>{awayName}</span>
        {hForm > 0 && (
          <span
            style={{
              fontSize: '8px',
              fontWeight: '900',
              color: hForm >= 70 ? '#00ffaa' : '#fbbf24',
            }}
          >
            {Math.round(hForm)}
          </span>
        )}
        {aForm > 0 && (
          <span
            style={{
              fontSize: '8px',
              fontWeight: '900',
              color: aForm >= 70 ? '#00ffaa' : '#fbbf24',
            }}
          >
            {Math.round(aForm)}
          </span>
        )}
        {actualScoreDisplay && (
          <span
            style={{
              fontSize: '12px',
              fontWeight: '900',
              color: '#f8fafc',
              fontFamily: "'JetBrains Mono', monospace",
              marginLeft: 'auto',
            }}
          >
            {actualScoreDisplay}
          </span>
        )}
      </div>

      {/* GRID: 1 marché dominant doré + Score IA + RISK */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>

        {/* MARCHÉ DOMINANT — LE SEUL PRONOSTIC */}
        {dominant && (
          <div
            style={{
              ...G({
                bg: 'rgba(255,215,0,0.08)',
                border: '1px solid #ffd700',
                gap: '4px',
              }),
              animation: 'goldenPulse 2s ease-in-out infinite',
              boxShadow: '0 0 20px rgba(255,215,0,0.3), inset 0 0 15px rgba(255,215,0,0.06)',
              gridColumn: 'span 3',
              padding: '10px 8px',
            }}
          >
            <L c="#ffd700" s="8px" w="900">MEILLEUR PRONOSTIC ⭐</L>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <V c="#ffd700" s="20px">{dominant?.label || '--'}</V>
              <V c="#ffd700" s="14px">{dominant?.pct ? `${dominant.pct}%` : '--'}</V>
              {dominant?.odds && (
                <V c="#fbbf24" s="14px">@{dominant.odds.toFixed(2)}</V>
              )}
              <span style={{ fontSize: '9px', color: '#94a3b8', fontWeight: '700' }}>
                {dominant?.score != null ? `Score ${dominant.score.toFixed(0)}` : ''}
              </span>
            </div>
          </div>
        )}

        {/* BOX 2: AI SCORE */}
        <div
          style={{ ...G({
            bg: match.insufficient_data === 1 ? 'rgba(245,158,11,0.06)' : 'rgba(0,255,170,0.04)',
            border: `1px solid ${match.insufficient_data === 1 ? 'rgba(245,158,11,0.15)' : 'rgba(0,255,170,0.1)'}`,
          }) }}
        >
          <L c={match.insufficient_data === 1 ? '#f59e0b' : '#00ffaa'} s="7px" w="900">
            SCORE IA
          </L>
          <V c={match.insufficient_data === 1 ? '#f59e0b' : '#00ffaa'} s="18px">
            {match.insufficient_data === 1 ? '⏳' : cs}
          </V>
        </div>

        {/* BOX 3: RISK / EV / FORCE */}
        <div
          style={{ ...G({ bg: 'rgba(148,163,184,0.04)', border: `1px solid ${msColor}33`, gap: '2px' }) }}
        >
          <L c="#64748b" s="7px" w="900">
            RISK / EV
          </L>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span
              style={{
                fontSize: '13px',
                fontWeight: '900',
                color: msColor || '#64748b',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {msDesc}
            </span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: '800',
                color: evNum > 0 ? '#10b981' : evNum < 0 ? '#ef4444' : '#94a3b8',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              EV {quantObj?.ev_score || '0.00'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {ms && (
              <div
                style={{
                  width: '40px',
                  height: '3px',
                  background: 'rgba(148,163,184,0.1)',
                  borderRadius: '3px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${ms * 10}%`,
                    height: '100%',
                    background: msColor,
                    borderRadius: '3px',
                  }}
                />
              </div>
            )}
            <span
              style={{
                fontSize: '9px',
                fontWeight: '900',
                color:
                  parseFloat(valueScore) >= 5
                    ? '#00ffaa'
                    : parseFloat(valueScore) >= 2
                      ? '#fbbf24'
                      : '#64748b',
              }}
            >
              🏆{valueScore}
            </span>
          </div>
        </div>
      </div>

      {/* Alternative Market Hunter */}
      {altHunter && altHunter.best_alternative && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '5px 10px',
            borderRadius: '6px',
            background: 'linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.04))',
            border: '1px solid rgba(245,158,11,0.25)',
            marginTop: '2px',
          }}
        >
          <span style={{ fontSize: '12px' }}>🎯</span>
          <span
            style={{ fontSize: '9px', fontWeight: '800', color: '#fbbf24', letterSpacing: '0.3px' }}
          >
            MARCHÉ ALTERNATIF
          </span>
          <span
            style={{
              fontSize: '10px',
              fontWeight: '900',
              color: '#f8fafc',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {altHunter.best_alternative.label}
          </span>
          <span style={{ fontSize: '9px', color: '#94a3b8' }}>
            @{altHunter.best_alternative.odds} · EV {altHunter.best_alternative.ev >= 0 ? '+' : ''}
            {altHunter.best_alternative.ev}
          </span>
          <span style={{ fontSize: '9px', color: '#64748b', marginLeft: 'auto' }}>
            xG {altHunter.xG_total}
          </span>
        </div>
      )}
    </div>
  )
}

export default React.memo(MatchRow)
