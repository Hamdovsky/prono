import React, { useEffect } from 'react'
import { DISABLE_BTTS_DISPLAY } from '../utils/displayPolicy'

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
const Pct = ({ v, c }) => (
  <span
    style={{
      fontSize: '11px',
      fontWeight: '800',
      color: c || '#94a3b8',
      fontFamily: "'JetBrains Mono', monospace",
    }}
  >
    {v}%
  </span>
)

const normalizePct = (v) => {
  const n = Number(v || 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1 ? n : n * 100
}

const toScore = (s) => {
  if (!s || !String(s).includes('-')) return null
  const [h, a] = String(s)
    .split('-')
    .map((v) => parseInt(v.trim()))
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null
  return { home: h, away: a, total: h + a }
}

const ACC_COLORS = {
  high: '#00ffaa',
  med: '#fbbf24',
  low: '#f87171',
}
const accColor = (v) => (v >= 70 ? ACC_COLORS.high : v >= 55 ? ACC_COLORS.med : ACC_COLORS.low)

const dominantBoxOf = (hPct, dPct, aPct, ou25Pct, bttsPct, htGoalPct) => {
  const probs = [
    { box: 1, pct: Math.max(hPct, dPct, aPct) },
    { box: 3, pct: bttsPct },
    { box: 4, pct: ou25Pct },
    { box: 5, pct: htGoalPct },
  ]
  const best = probs.reduce((a, b) => b.pct > a.pct ? b : a, probs[0])
  return best.pct > 0 ? best.box : null
}

const goldenStyle = (boxIdx, goldenBox) => goldenBox === boxIdx ? {
  boxShadow: '0 0 15px rgba(255,215,0,0.5), inset 0 0 10px rgba(255,215,0,0.08)',
  border: '1px solid #ffd700',
  animation: 'goldenPulse 2s ease-in-out infinite',
} : {}

const MatchRow = ({ match, isElite, onClick, style, now }) => {
  const enriched = match.enriched || {}
  const hPct = parseFloat(match.home_win_probability || enriched.home_win_probability || 0)
  const aPct = parseFloat(match.away_win_probability || enriched.away_win_probability || 0)
  const dPct = parseFloat(match.draw_probability || enriched.draw_probability || 0)
  const pOU25 = Number(match.ou_25_prob || enriched?.ou_25_prob || 0)
  const pBTTS = Number(match.btts_prob || enriched?.btts_prob || 0)
  const quantObj = match.quant || enriched?.quant
  const mainPick = (quantObj?.main_pick || '').toString().trim().toUpperCase()
  const marketAnalysis = match.marketAnalysis || {}
  const dcOdds = marketAnalysis.doubleChance || null
  const bttsPct = Math.round(normalizePct(quantObj?.probs?.btts || pBTTS))
  const over25Pct = Math.round(normalizePct(quantObj?.probs?.over25 || pOU25))
  const htGoalPct = Math.min(89, Math.round(normalizePct(quantObj?.probs?.ht_goal ?? enriched?.ht_goal_prob ?? match.ht_goal_prob ?? 0)))
  const goldenBox = dominantBoxOf(hPct, dPct, aPct, over25Pct, bttsPct, htGoalPct)

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
  const parsedCS = toScore(cs)
  const scoreTotal = parsedCS ? parsedCS.total : 0
  const scoreBtts = parsedCS ? parsedCS.home > 0 && parsedCS.away > 0 : false

  const displayOddsH = match.display_odds_home || match.best_odds_home || match.odds_home
  const displayOddsA = match.display_odds_away || match.best_odds_away || match.odds_away
  const getOdds = (pick) => {
    const p = (pick || '').trim().toUpperCase()
    if (p === '1' || p === 'HOME') return displayOddsH
    if (p === '2' || p === 'AWAY') return displayOddsA
    if (p === 'X' || p === 'N' || p === 'DRAW') return match.odds_draw
    if (dcOdds && dcOdds[p]) return parseFloat(dcOdds[p])
    return null
  }
  const mainOdds = getOdds(quantObj?.main_pick)
  const mainPickClean = (quantObj?.main_pick || '')
    .replace(/🛡️|⚽|⚡|🔥|🏠|✈️|AH_|EH_|COMBOS: |SMART VALUE: /g, '')
    .trim()

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

  const mainPickProb = (() => {
    const p = (quantObj?.main_pick || '').toString().trim().toUpperCase()
    if (p === '1' || p === 'HOME') return hPct / 100
    if (p === '2' || p === 'AWAY') return aPct / 100
    if (p === 'X' || p === 'N' || p === 'DRAW') return dPct / 100
    if (p === '12') return (hPct + aPct) / 100
    if (p === '1X') return (hPct + dPct) / 100
    if (p === 'X2') return (aPct + dPct) / 100
    return acc / 100
  })()
  const mainPickEdge = mainOdds ? mainPickProb - 1 / mainOdds : 0
  const mainPickEdgePct = (mainPickEdge * 100).toFixed(1)

  const evNum = parseFloat(quantObj?.ev_score) || 0
  const valueScore = ((evNum * acc) / 100).toFixed(1)

  const altHunter = match.alt_market_hunter || enriched?.alt_market_hunter || null
  const domProb = Math.max(hPct, aPct)
  const hasOdds = !!(displayOddsH && displayOddsA)
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

  const bttsBadgeColor = scoreBtts ? '#00ffaa' : '#f87171'
  const ouColor = over25Pct >= 60 ? '#10b981' : '#94a3b8'
  const htColor = htGoalPct >= 65 ? '#00ffaa' : htGoalPct >= 50 ? '#fbbf24' : '#f87171'

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

      {/* GRID: 6 independent boxes (3 cols desktop, 2 cols mobile) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
        {/* BOX 1: BASE 1X2 + Confidence */}
        <div
          style={{ ...G({
            bg: 'rgba(0,255,170,0.05)',
            border: '1px solid rgba(0,255,170,0.12)',
            gap: '2px',
          }), ...goldenStyle(1) }}
        >
          <L c="#00ffaa" s="7px" w="900">
            BASE 1X2{goldenBox === 1 ? ' ⭐' : ''}
          </L>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
            <V c="#f8fafc" s="18px">
              {mainPickClean}
            </V>
            <V c={accColor(acc)} s="14px">
              {acc}%
            </V>
          </div>
          <div
            style={{
              width: '100%',
              height: '2px',
              background: 'rgba(148,163,184,0.1)',
              borderRadius: '2px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.max(5, acc)}%`,
                height: '100%',
                background: accColor(acc),
                borderRadius: '2px',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {mainOdds && (
              <span
                style={{
                  fontSize: '9px',
                  color: '#fbbf24',
                  fontWeight: '700',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                @{mainOdds.toFixed(2)}
              </span>
            )}
            <span
              style={{
                fontSize: '8px',
                color: mainPickEdge > 0 ? '#fbbf24' : '#f87171',
                fontWeight: '800',
              }}
            >
              {mainPickEdge > 0 ? `🎯+${mainPickEdgePct}%` : `⚠️${mainPickEdgePct}%`}
            </span>
          </div>
        </div>

        {/* BOX 2: AI SCORE */}
        <div
          style={{ ...G({
            bg: match.insufficient_data === 1 ? 'rgba(245,158,11,0.06)' : 'rgba(0,255,170,0.04)',
            border: `1px solid ${match.insufficient_data === 1 ? 'rgba(245,158,11,0.15)' : 'rgba(0,255,170,0.1)'}`,
          }), ...goldenStyle(2) }}
        >
          <L c={match.insufficient_data === 1 ? '#f59e0b' : '#00ffaa'} s="7px" w="900">
            SCORE IA
          </L>
          <V c={match.insufficient_data === 1 ? '#f59e0b' : '#00ffaa'} s="18px">
            {match.insufficient_data === 1 ? '⏳' : cs}
          </V>
        </div>

        {/* BOX 3: BTTS — masqué si VITE_DISABLE_BTTS_DISPLAY (audit BT3 :
            signal 50-53% ~ hasard, voir CHANGELOG_AUDIT.md « Marché BTTS ») */}
        <div
          style={{ ...G({
            bg: 'rgba(239,68,68,0.04)',
            border: `1px solid ${DISABLE_BTTS_DISPLAY ? 'rgba(100,116,139,0.15)' : scoreBtts ? 'rgba(0,255,170,0.12)' : 'rgba(239,68,68,0.15)'}`,
          }), ...goldenStyle(3) }}
        >
          <L c={DISABLE_BTTS_DISPLAY ? '#64748b' : scoreBtts ? '#00ffaa' : '#f87171'} s="7px" w="900">
            BTTS{goldenBox === 3 ? ' ⭐' : ''}
          </L>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
            <V c={DISABLE_BTTS_DISPLAY ? '#64748b' : scoreBtts ? '#00ffaa' : '#f87171'} s="18px">
              {DISABLE_BTTS_DISPLAY ? '--' : scoreBtts ? 'OUI' : 'NON'}
            </V>
            {!DISABLE_BTTS_DISPLAY && (
              <Pct v={scoreBtts ? bttsPct : 100 - bttsPct} c={scoreBtts ? '#00ffaa' : '#f87171'} />
            )}
          </div>
        </div>

        {/* BOX 4: O/U 2.5 */}
        <div
          style={{ ...G({
            bg: over25Pct > 50 ? 'rgba(16,185,129,0.04)' : 'rgba(239,68,68,0.04)',
            border: `1px solid ${over25Pct > 50 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}`,
          }), ...goldenStyle(4) }}
        >
          <L c={over25Pct > 50 ? '#10b981' : '#ef4444'} s="7px" w="900">
            O/U 2.5{goldenBox === 4 ? ' ⭐' : ''}
          </L>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
            <V c={over25Pct > 50 ? '#10b981' : '#ef4444'} s="18px">
              {over25Pct > 50 ? 'OVER' : 'UNDER'}
            </V>
            <Pct
              v={over25Pct > 50 ? over25Pct : 100 - over25Pct}
              c={over25Pct > 50 ? '#10b981' : '#ef4444'}
            />
          </div>
        </div>

        {/* BOX 5: HT +0.5 */}
        <div
          style={{ ...G({
            bg: 'rgba(251,191,36,0.04)',
            border: `1px solid ${htGoalPct >= 65 ? 'rgba(0,255,170,0.12)' : htGoalPct >= 50 ? 'rgba(251,191,36,0.15)' : 'rgba(239,68,68,0.12)'}`,
          }), ...goldenStyle(5) }}
        >
          <L
            c={htGoalPct >= 65 ? '#00ffaa' : htGoalPct >= 50 ? '#fbbf24' : '#f87171'}
            s="7px"
            w="900"
          >
            HT +0.5{goldenBox === 5 ? ' ⭐' : ''}
          </L>
          <V c={htGoalPct >= 65 ? '#00ffaa' : htGoalPct >= 50 ? '#fbbf24' : '#f87171'} s="18px">
            {htGoalPct}%
          </V>
        </div>

        {/* BOX 6: RISK / EV / FORCE */}
        <div
          style={{ ...G({ bg: 'rgba(148,163,184,0.04)', border: `1px solid ${msColor}33`, gap: '2px' }), ...goldenStyle(6) }}
        >
          <L c="#64748b" s="7px" w="900">
            RISK / EV / FORCE
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
