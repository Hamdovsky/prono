import React from 'react'
import './MatchCard.css'
import { DISABLE_BTTS_DISPLAY, DISABLE_CORNERS_DISPLAY } from '../utils/displayPolicy'

const isGolden = (chipKey, dominant) => dominant && dominant.chip === chipKey

  const domLabelToChip = (label) => {
  if (!label || label === '--') return null
  const m = label.match(/^(OVER|UNDER)\s+([\d.]+)\s+(\d+)%$/)
  if (!m) return null
  const dir = m[1] === 'OVER' ? 'O' : 'U'
  return `${dir}${m[2]} ${m[3]}%`
}

const domLineFromLabel = (label) => {
  if (!label || label === '--') return null
  const m = label.match(/^(OVER|UNDER)\s+([\d.]+)\s+(\d+)%$/)
  if (!m) return null
  return { dir: m[1].toLowerCase(), line: parseFloat(m[2]) }
}

const goldenChip = (chipKey, dominant) => isGolden(chipKey, dominant)
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      border: '1px solid #ffd700',
      boxShadow: '0 0 10px rgba(255,215,0,0.4)',
    }
  : { opacity: 0.35 }

const goldenCell = (cellKey, dominant) => isGolden(cellKey, dominant)
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      border: '1px solid #ffd700',
      boxShadow: '0 0 10px rgba(255,215,0,0.3)',
    }
  : { opacity: 0.35 }

const solidGoldenStyle = (isSolid) => isSolid
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      background: 'linear-gradient(135deg, rgba(255,215,0,0.12) 0%, rgba(10,15,30,0.9) 100%)',
      border: '1px solid #ffd700',
      boxShadow: 'inset 0 0 20px rgba(255,215,0,0.08)',
    }
  : {}

const MatchCard = ({ rawData, style, onClick, timeLabel, compact, reliability, isLive, liveMinute, liveScore, liveStats, goalPrediction }) => {
  const parseRow = (lines) => {
    if (!lines || lines.length < 8) return null
    const domChip = lines[13] || null
    const domPayloadRaw = lines[14] || ''
    let domLabel = '--', domPct = '--', domOdds = '--', domScore = '--'
    if (domPayloadRaw && domPayloadRaw !== '--') {
      const parts = domPayloadRaw.split('|')
      if (parts.length >= 4) {
        domLabel = parts[0]
        domPct = parts[1]
        domOdds = parts[2]
        domScore = parts[3]
      }
    }
    const parseInfoCell = (raw) => {
      if (!raw || raw === '--') return null
      const parts = String(raw).split('|')
      if (parts.length < 3) return null
      return { label: parts[0] || '--', pct: parts[1] || '--', odds: parts[2] || '--' }
    }
    return {
      league: lines[0],
      home: lines[1],
      away: lines[2],
      btts: lines[3],
      ou: lines[4],
      winner: lines[5],
      htGoal: lines[6],
      corners: lines[7],
      score: lines[8] && lines[8] !== '--' ? lines[8] : null,
      solid: lines[9] === '1',
      winnerDc: lines[10],
      ouLines: lines[11],
      cornersExact: lines[12],
      domChip,
      domLabel,
      domPct,
      domOdds,
      domScore,
      htft: parseInfoCell(lines[15]),
      ah: parseInfoCell(lines[16]),
      teamToScore: parseInfoCell(lines[17]),
      htFirstHalf: parseInfoCell(lines[18]),
      bttsAndWin: parseInfoCell(lines[19]),
      bttsAndOu: parseInfoCell(lines[20]),
    }
  }

  const d = parseRow(rawData)
  if (!d) return null
  const dominant = d.domChip ? { chip: d.domChip } : null

  const shortTeam = (name) => {
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length <= 2) return name
    return parts.map((w, i) => (i === 0 ? w : w[0] + '.')).join(' ')
  }

  // ── O/U : priorité aux multi-lignes (OULINES "1.5:76|2.5:56|…") ──
  const ouLines = (d.ouLines || '')
    .split('|')
    .map((chunk) => {
      const [lineStr, pctStr] = chunk.split(':')
      const line = parseFloat(lineStr)
      const pct = parseFloat(pctStr)
      if (!Number.isFinite(line) || !Number.isFinite(pct)) return null
      return { line, pct, dir: pct > 50 ? 'over' : 'under' }
    })
    .filter(Boolean)

  const bestOu =
    ouLines.length > 0
      ? ouLines.reduce((best, l) => (!best || l.pct > best.pct ? l : best), null)
      : null

  const ouNumFromCell = parseFloat(d.ou)
  const hasOuCell = Number.isFinite(ouNumFromCell) && ouNumFromCell > 0
  const hasOu = ouLines.length > 0 || hasOuCell || !!bestOu
  const ouDir = hasOu
    ? bestOu
      ? bestOu.dir
      : ouNumFromCell > 50
        ? 'over'
        : 'under'
    : 'under'
  const ouPrec = hasOu
    ? Math.round(bestOu ? bestOu.pct : ouNumFromCell > 50 ? ouNumFromCell : 100 - ouNumFromCell)
    : 0

  // Verdict binaire (OUI/NON)
  const yesNo = (v) => {
    const s = (v || '').trim().toUpperCase()
    if (s.startsWith('OUI')) return 'yes'
    if (s.startsWith('NON')) return 'no'
    return ''
  }
  const bttsVerdict = DISABLE_BTTS_DISPLAY ? '' : yesNo(d.btts)
  const cornersExactLabel = DISABLE_CORNERS_DISPLAY ? null : d.cornersExact

  // Gagnant : extraire le pick (1/X/2 ou 1X/12/X2) avant la proba
  const winPick = (d.winner || '').split(' ')[0].trim().toUpperCase()
  const winProb = (d.winner || '').split(' ').slice(1).join(' ').trim()
  const winnerTeamName = winPick === '1' ? d.home : winPick === '2' ? d.away : winPick === 'X' ? 'Match nul' : null
  const winnerDisplay = winnerTeamName && winProb ? `${winnerTeamName} ${winProb}` : d.winner
  const pickClass =
    winPick === '1'
      ? 'mc-pick-home'
      : winPick === 'X'
        ? 'mc-pick-draw'
        : winPick === '2'
          ? 'mc-pick-away'
          : ['1X', '12', 'X2'].includes(winPick)
            ? 'mc-pick-dc'
            : ''

  const solidClass = d.solid ? ' mc-solid' : ''
  const solidBadge = d.solid ? ' 🎯' : ''

  // Fiabilité honnête par bracket de confiance (précision réelle du backtest) :
  // n < 20 → insuffisant. Le libellé « réel » distingue la précision MESURÉE
  // de la confiance affichée du pick.
  const relBadge = (() => {
    if (!reliability || !reliability.n) return null
    if (reliability.n < 20)
      return (
        <span className="mc-rel mc-rel-insuf" title="Échantillon trop petit pour être fiable">
          éch. insuffisant
        </span>
      )
    const cls = reliability.pct >= 60 ? 'mc-rel-good' : 'mc-rel-low'
    return (
      <span
        className={`mc-rel ${cls}`}
        title={`Précision réelle du bracket de confiance · ${reliability.correct}/${reliability.n} bons`}
      >
        réel ≈{Math.round(reliability.pct)}% ({reliability.n})
      </span>
    )
  })()

  const hasDc = d.winnerDc && d.winnerDc !== '--'
  const cornersLabel = DISABLE_CORNERS_DISPLAY
    ? '--'
    : cornersExactLabel
      ? `✚ ${cornersExactLabel}`
      : d.corners

  if (compact) {
    return (
      <div className={`match-card mc-compact${solidClass}`} style={{ ...style, ...solidGoldenStyle(d.solid) }} onClick={onClick}>
        <div className="mcc-top">
          <div className="mcc-league">
            <span className="mcc-league-name">{d.league}</span>
            {solidBadge}
            {relBadge}
          </div>
          {timeLabel && <div className="mcc-time">{timeLabel}</div>}
        </div>
        <div className="mcc-teams">
          <span className="mcc-team">{shortTeam(d.home)}</span>
          <span className={`mcc-vs${d.score ? ' has-score' : ''}`}>{d.score ? d.score : 'vs'}</span>
          <span className="mcc-team">{shortTeam(d.away)}</span>
        </div>
        {d.domLabel && d.domLabel !== '--' && (
          <div className="mcc-dominant-banner">
            ⭐ {d.domLabel}{d.domOdds && d.domOdds !== '--' ? ` @${d.domOdds}` : ''}
          </div>
        )}
        <div className="mcc-chips">
          <span className={`mcc-chip mcc-btts ${DISABLE_BTTS_DISPLAY ? '' : bttsVerdict}`} style={goldenChip('btts', dominant)}>
            BTTS {DISABLE_BTTS_DISPLAY ? '--' : d.btts}
          </span>
          <span className={`mcc-chip mcc-ou ${ouDir}`} style={goldenChip('ou', dominant)}>
            {dominant && dominant.chip === 'ou' && domLabelToChip(d.domLabel)
              ? domLabelToChip(d.domLabel)
              : bestOu
                ? `${bestOu.dir === 'over' ? 'O' : 'U'}${bestOu.line.toFixed(1)} ${bestOu.pct}%`
                : hasOuCell
                  ? `O/U ${ouDir.toUpperCase()} ${ouPrec}%`
                  : 'O/U --'}
          </span>
          <span className={`mcc-chip mcc-win ${pickClass}`} style={goldenChip('win', dominant)}>{winnerDisplay}</span>
          {hasDc && <span className="mcc-chip mcc-dc" style={goldenChip('dc', dominant)}>DC {d.winnerDc}</span>}
          <span className={`mcc-chip mcc-ht ${yesNo(d.htGoal)}`} style={goldenChip('ht', dominant)}>1er MT {d.htGoal}</span>
          <span className="mcc-chip mcc-corners" style={goldenChip('corners', dominant)}>{cornersLabel}</span>
          {d.htft && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>HT/FT {d.htft.label}</span>}
          {d.ah && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>AH {d.ah.label}</span>}
          {d.teamToScore && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>QM {d.teamToScore.label}</span>}
          {d.htFirstHalf && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>HT O/U {d.htFirstHalf.label}</span>}
          {d.bttsAndWin && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>BTTS+WIN {d.bttsAndWin.label}</span>}
          {d.bttsAndOu && <span className="mcc-chip mcc-info" style={{opacity:0.45}}>BTTS+O/U {d.bttsAndOu.label}</span>}
        </div>
      </div>
    )
  }

  const relFactor = reliability && reliability.pct ? reliability.pct / 100 : 1
  const dominantLabel = d.domLabel && d.domLabel !== '--' ? d.domLabel : null
  const dominantPct = d.domPct && d.domPct !== '--' ? d.domPct : null
  const dominantOdds = d.domOdds && d.domOdds !== '--' ? d.domOdds : null
  const dominantScore = d.domScore && d.domScore !== '--' ? d.domScore : null
  const displayScore = dominantScore != null && dominantScore !== '--' ? (parseFloat(dominantScore) * relFactor).toFixed(0) : null

  return (
    <div className={`match-card${solidClass}`} style={{ ...style, ...solidGoldenStyle(d.solid) }} onClick={onClick}>
      {dominantLabel && (
        <div className="mc-dominant-banner">
          <span className="mc-dominant-label">MEILLEUR PRONOSTIC ⭐</span>
          <span className="mc-dominant-pick">{dominantLabel}</span>
          {dominantPct && dominantPct !== '--' && (
            <span className="mc-dominant-pct">{dominantPct}%</span>
          )}
          {dominantOdds && dominantOdds !== '--' && (
            <span className="mc-dominant-odds">@{dominantOdds}</span>
          )}
          {displayScore != null && (
            <span className="mc-dominant-score">Score {displayScore}</span>
          )}
        </div>
      )}
      {isLive && (
        <div className="mc-live-banner">
          <span className="mc-live-minute">🔴 {liveMinute}'</span>
          {liveStats?.possession && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">POS <span className="mc-live-stat-val">{liveStats.possession}</span></span>
            </>
          )}
          {liveStats?.corners && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">CK <span className="mc-live-stat-val">{liveStats.corners}</span></span>
            </>
          )}
          {liveStats?.shotsOnTarget && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">S/T <span className="mc-live-stat-val">{liveStats.shotsOnTarget}</span></span>
            </>
          )}
          {liveStats?.xg && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">xG <span className="mc-live-stat-val">{liveStats.xg}</span></span>
            </>
          )}
          {goalPrediction?.next5min > 0 && (
            <>
              <span className="mc-live-sep">|</span>
              <span className="mc-live-stat">PROCH <span className="mc-live-stat-val">{goalPrediction.next5min}'</span></span>
            </>
          )}
        </div>
      )}
      <div className="mc-match-info">
        <div className="mc-league">
          <span className="mc-league-name">{d.league}</span>
          {solidBadge}
          {relBadge}
        </div>
        <div className="mc-teams">
          <span>{shortTeam(d.home)}</span>
          <span className={`mc-vs${isLive ? ' mc-live-score' : ''}`}>
            {liveScore ? liveScore : d.score ? d.score : 'vs'}
          </span>
          <span>{shortTeam(d.away)}</span>
        </div>
        {isLive && liveMinute ? (
          <div className="mc-time" style={{ color: '#ef4444', fontWeight: 900 }}>🔴 {liveMinute}'</div>
        ) : timeLabel ? (
          <div className="mc-time">{timeLabel}</div>
        ) : null}
      </div>

      <div className={`mc-cell mc-btts ${DISABLE_BTTS_DISPLAY ? '' : bttsVerdict}`} style={goldenCell('btts', dominant)}>
        {DISABLE_BTTS_DISPLAY ? '--' : d.btts}
      </div>

      <div className="mc-cell mc-ou-cell" style={goldenCell('ou', dominant)}>
        {ouLines.length > 0 ? (
          <div className="mc-ou-lines">
            {ouLines.map((l) => {
              const dominantLine = dominant && dominant.chip === 'ou' ? domLineFromLabel(d.domLabel) : null
              const isDom = dominantLine && dominantLine.dir === l.dir && dominantLine.line === l.line
              return (
                <span key={l.line} className={`mc-ou-line ${l.dir}${isDom ? ' dominant' : ''}`}>
                  {l.dir === 'over' ? 'O' : 'U'}
                  {l.line.toFixed(1)} {l.pct}%
                </span>
              )
            })}
          </div>
        ) : hasOuCell ? (
          <>
            <div className="mc-ou-bar">
              <div className={`mc-ou-fill ${ouDir}`} style={{ width: `${Math.min(100, ouPrec)}%` }} />
            </div>
            <span className={`mc-ou-label ${ouDir}`}>{ouDir.toUpperCase()}</span>
            <span className={`mc-ou-pct ${ouDir}`}>{ouPrec}%</span>
          </>
        ) : (
          <span className="mc-ou-na">--</span>
        )}
      </div>

      <div className={`mc-cell mc-winner ${pickClass}`} style={goldenCell('win', dominant)}>{winnerDisplay}</div>

      <div className={`mc-cell mc-ht ${yesNo(d.htGoal)}`} style={goldenCell('ht', dominant)}>{d.htGoal}</div>

      <div className="mc-cell mc-corners" style={goldenCell('corners', dominant)}>{cornersLabel}</div>

      <div className="mc-cell mc-info-cell mc-info-htft" style={{opacity:0.45}}>
        {d.htft ? `${d.htft.label} ${d.htft.pct}%` : '--'}
      </div>

      <div className="mc-cell mc-info-cell mc-info-ah" style={{opacity:0.45}}>
        {d.ah ? `${d.ah.label}${d.ah.odds !== '--' ? ` @${d.ah.odds}` : ''}` : '--'}
      </div>

      <div className="mc-cell mc-info-cell mc-info-tts" style={{opacity:0.45}}>
        {d.teamToScore ? `${d.teamToScore.label} ${d.teamToScore.pct}%` : '--'}
      </div>
    </div>
  )
}

// 🧠 [PERF] Mémoïsé : avec rawData (liste stable via WeakMap) et onClick (stable),
// une rangée ne se re-rend que si son contenu change réellement.
export default React.memo(MatchCard)
