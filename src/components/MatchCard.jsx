import React from 'react'
import './MatchCard.css'

const MatchCard = ({ rawData, style, onClick, timeLabel, compact }) => {
  const parseRow = (lines) => {
    if (!lines || lines.length < 8) return null
    return {
      league: lines[0],
      home: lines[1],
      away: lines[2],
      btts: lines[3],
      ou: lines[4],
      winner: lines[5],
      handicap: lines[6],
      corners: lines[7],
      score: lines[8] && lines[8] !== '--' ? lines[8] : null,
      solid: lines[9] === '1',
    }
  }

  const d = parseRow(rawData)
  if (!d) return null

  const shortTeam = (name) => {
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length <= 2) return name
    return parts.map((w, i) => (i === 0 ? w : w[0] + '.')).join(' ')
  }

  const ouNum = parseFloat(d.ou)
  const hasOu = Number.isFinite(ouNum) && ouNum > 0
  const ouDir = hasOu && ouNum > 50 ? 'over' : 'under'
  const ouPrec = hasOu ? Math.round(ouNum > 50 ? ouNum : 100 - ouNum) : 0

  // Verdict binaire (OUI/NON)
  const yesNo = (v) => {
    const s = (v || '').trim().toUpperCase()
    if (s.startsWith('OUI')) return 'yes'
    if (s.startsWith('NON')) return 'no'
    return ''
  }
  const bttsVerdict = yesNo(d.btts)
  const cornersVerdict = yesNo(d.corners)

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

  if (compact) {
    return (
      <div className={`match-card mc-compact${solidClass}`} style={style} onClick={onClick}>
        <div className="mcc-top">
          <div className="mcc-league">
            {d.league}
            {solidBadge}
          </div>
          {timeLabel && <div className="mcc-time">{timeLabel}</div>}
        </div>
        <div className="mcc-teams">
          <span className="mcc-team">{shortTeam(d.home)}</span>
          <span className={`mcc-vs${d.score ? ' has-score' : ''}`}>{d.score ? d.score : 'vs'}</span>
          <span className="mcc-team">{shortTeam(d.away)}</span>
        </div>
        <div className="mcc-chips">
          <span className={`mcc-chip mcc-btts ${bttsVerdict}`}>BTTS {d.btts}</span>
          <span className={`mcc-chip mcc-ou ${ouDir}`}>
            {hasOu ? `O/U ${ouDir.toUpperCase()} ${ouPrec}%` : 'O/U --'}
          </span>
          <span className={`mcc-chip mcc-win ${pickClass}`}>{d.winner}</span>
          <span className="mcc-chip mcc-hcp">H {d.handicap}</span>
          <span className={`mcc-chip mcc-corners ${cornersVerdict}`}>✚ {d.corners}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`match-card${solidClass}`} style={style} onClick={onClick}>
      <div className="mc-match-info">
        <div className="mc-league">
          {d.league}
          {solidBadge}
        </div>
        <div className="mc-teams">
          <span>{shortTeam(d.home)}</span>
          <span className="mc-vs">{d.score ? d.score : 'vs'}</span>
          <span>{shortTeam(d.away)}</span>
        </div>
        {timeLabel && <div className="mc-time">{timeLabel}</div>}
      </div>

      <div className={`mc-cell mc-btts ${bttsVerdict}`}>{d.btts}</div>

      <div className="mc-cell mc-ou-cell">
        {hasOu ? (
          <>
            <div className="mc-ou-bar">
              <div
                className={`mc-ou-fill ${ouDir}`}
                style={{ width: `${Math.min(100, ouPrec)}%` }}
              />
            </div>
            <span className={`mc-ou-label ${ouDir}`}>{ouDir.toUpperCase()}</span>
            <span className={`mc-ou-pct ${ouDir}`}>{ouPrec}%</span>
          </>
        ) : (
          <span className="mc-ou-na">--</span>
        )}
      </div>

      <div className={`mc-cell mc-winner ${pickClass}`}>{d.winner}</div>

      <div className="mc-cell mc-handicap">{d.handicap}</div>

      <div className={`mc-cell mc-corners ${cornersVerdict}`}>{d.corners}</div>
    </div>
  )
}

// 🧠 [PERF] Mémoïsé : avec rawData (liste stable via WeakMap) et onClick (stable),
// une rangée ne se re-rend que si son contenu change réellement.
export default React.memo(MatchCard)
