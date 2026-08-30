import React from 'react'
import './MatchCard.css'
import { DISABLE_BTTS_DISPLAY, DISABLE_CORNERS_DISPLAY } from '../utils/displayPolicy'

const isGolden = (chipKey, dominant) => dominant === chipKey

const goldenChip = (chipKey, dominant) => isGolden(chipKey, dominant)
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      border: '1px solid #ffd700',
      boxShadow: '0 0 10px rgba(255,215,0,0.4)',
    }
  : {}

const goldenCell = (cellKey, dominant) => isGolden(cellKey, dominant)
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      border: '1px solid #ffd700',
      boxShadow: '0 0 10px rgba(255,215,0,0.3)',
    }
  : {}

const solidGoldenStyle = (isSolid) => isSolid
  ? {
      animation: 'goldenPulse 2s ease-in-out infinite',
      background: 'linear-gradient(135deg, rgba(255,215,0,0.12) 0%, rgba(10,15,30,0.9) 100%)',
      border: '1px solid #ffd700',
      boxShadow: 'inset 0 0 20px rgba(255,215,0,0.08)',
    }
  : {}
// Dominant market basé sur la plus haute probabilité affichée (pas market_scope)
const dominantChipOf = (d) => {
  const parsePct = (s) => {
    if (!s || s === '--') return 0
    const m = String(s).match(/(\d+)/)
    return m ? parseInt(m[1], 10) : 0
  }
  const probs = [
    { chip: 'btts', pct: parsePct(d.btts) },
    { chip: 'ou', pct: parsePct(d.ou) },
    { chip: 'win', pct: parsePct(d.winner) },
    { chip: 'dc', pct: parsePct(d.winnerDc) },
    { chip: 'ht', pct: parsePct(d.htGoal) },
    { chip: 'corners', pct: parsePct(d.corners) },
  ]
  return probs.reduce((best, c) => c.pct > best.pct ? c : best, { chip: 'win', pct: 0 }).chip
}

const MatchCard = ({ rawData, style, onClick, timeLabel, compact, reliability }) => {
  const parseRow = (lines) => {
    if (!lines || lines.length < 8) return null
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
    }
  }

  const d = parseRow(rawData)
  if (!d) return null
  const dominant = dominantChipOf(d)

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
  const bttsDisplay = DISABLE_BTTS_DISPLAY ? '--' : d.btts
  const bttsVerdict = DISABLE_BTTS_DISPLAY ? '' : yesNo(d.btts)
  // Corners masqués si VITE_DISABLE_CORNERS_DISPLAY (audit C8 : pas d'edge moderne)
  const cornersDisplay = DISABLE_CORNERS_DISPLAY ? '--' : d.corners
  const cornersVerdict = DISABLE_CORNERS_DISPLAY ? '' : yesNo(d.corners)
  const cornersExactLabel = DISABLE_CORNERS_DISPLAY ? null : d.cornersExact

  // Gagnant : extraire le pick (1/X/2 ou 1X/12/X2) avant la proba
  const winPick = (d.winner || '').split(' ')[0].trim().toUpperCase()
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
        <div className="mcc-chips">
          <span className={`mcc-chip mcc-btts ${DISABLE_BTTS_DISPLAY ? '' : bttsVerdict}`} style={goldenChip('btts', dominant)}>
            BTTS {DISABLE_BTTS_DISPLAY ? '--' : d.btts}
          </span>
          <span className={`mcc-chip mcc-ou ${ouDir}`} style={goldenChip('ou', dominant)}>
            {bestOu
              ? `${bestOu.dir === 'over' ? 'O' : 'U'}${bestOu.line.toFixed(1)} ${bestOu.pct}%`
              : hasOuCell
                ? `O/U ${ouDir.toUpperCase()} ${ouPrec}%`
                : 'O/U --'}
          </span>
          <span className={`mcc-chip mcc-win ${pickClass}`} style={goldenChip('win', dominant)}>{d.winner}</span>
          {hasDc && <span className="mcc-chip mcc-dc" style={goldenChip('dc', dominant)}>DC {d.winnerDc}</span>}
          <span className={`mcc-chip mcc-ht ${yesNo(d.htGoal)}`} style={goldenChip('ht', dominant)}>1er MT {d.htGoal}</span>
          <span className="mcc-chip mcc-corners" style={goldenChip('corners', dominant)}>{cornersLabel}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`match-card${solidClass}`} style={{ ...style, ...solidGoldenStyle(d.solid) }} onClick={onClick}>
      <div className="mc-match-info">
        <div className="mc-league">
          <span className="mc-league-name">{d.league}</span>
          {solidBadge}
          {relBadge}
        </div>
        <div className="mc-teams">
          <span>{shortTeam(d.home)}</span>
          <span className="mc-vs">{d.score ? d.score : 'vs'}</span>
          <span>{shortTeam(d.away)}</span>
        </div>
        {timeLabel && <div className="mc-time">{timeLabel}</div>}
      </div>

      <div className={`mc-cell mc-btts ${DISABLE_BTTS_DISPLAY ? '' : bttsVerdict}`} style={goldenCell('btts', dominant)}>
        {DISABLE_BTTS_DISPLAY ? '--' : d.btts}
      </div>

      <div className="mc-cell mc-ou-cell" style={goldenCell('ou', dominant)}>
        {ouLines.length > 0 ? (
          <div className="mc-ou-lines">
            {ouLines.map((l) => (
              <span key={l.line} className={`mc-ou-line ${l.dir}`}>
                {l.dir === 'over' ? 'O' : 'U'}
                {l.line.toFixed(1)} {l.pct}%
              </span>
            ))}
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

      <div className={`mc-cell mc-winner ${pickClass}`} style={goldenCell('win', dominant)}>{d.winner}</div>

      <div className={`mc-cell mc-ht ${yesNo(d.htGoal)}`} style={goldenCell('ht', dominant)}>{d.htGoal}</div>

      <div className="mc-cell mc-corners" style={goldenCell('corners', dominant)}>{cornersLabel}</div>
    </div>
  )
}

// 🧠 [PERF] Mémoïsé : avec rawData (liste stable via WeakMap) et onClick (stable),
// une rangée ne se re-rend que si son contenu change réellement.
export default React.memo(MatchCard)
