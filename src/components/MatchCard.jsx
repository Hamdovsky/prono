import React from 'react'
import './MatchCard.css'

const MatchCard = ({ rawData, style, onClick }) => {
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
      htGoal: lines[7],
      score: lines[8] && lines[8] !== '--' ? lines[8] : null,
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

  const ouNum = parseFloat(d.ou) || 0
  const ouDir = ouNum > 50 ? 'over' : 'under'
  const ouPrec = Math.round(ouNum > 50 ? ouNum : 100 - ouNum)

  const pickClass = d.winner === '1' ? 'mc-pick-home' : d.winner === 'X' ? 'mc-pick-draw' : d.winner === '2' ? 'mc-pick-away' : ''

  return (
    <div className="match-card" style={style} onClick={onClick}>
      <div className="mc-match-info">
        <div className="mc-league">{d.league}</div>
        <div className="mc-teams">
          <span>{shortTeam(d.home)}</span>
          <span className="mc-vs">{d.score ? d.score : 'vs'}</span>
          <span>{shortTeam(d.away)}</span>
        </div>
      </div>

      <div className="mc-cell mc-btts">{d.btts}</div>

      <div className="mc-cell mc-ou-cell">
        <div className="mc-ou-bar">
          <div className={`mc-ou-fill ${ouDir}`} style={{ width: `${Math.min(100, ouPrec)}%` }} />
        </div>
        <span className={`mc-ou-pct ${ouDir}`}>{ouPrec}%</span>
      </div>

      <div className={`mc-cell mc-winner ${pickClass}`}>{d.winner}</div>

      <div className="mc-cell mc-handicap">{d.handicap}</div>

      <div className="mc-cell mc-htgoal">{d.htGoal}</div>
    </div>
  )
}

export default MatchCard
