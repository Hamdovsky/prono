import React from 'react'
import './MatchCard.css'

const MatchCard = ({ rawData, style, onClick }) => {
  const parseRow = (lines) => {
    if (!lines || lines.length === 0) return null
    const league = lines[0] || ''
    const home = lines[1] || ''
    const away = lines[2] || ''
    const pcts = lines.filter((l) => l.includes('%') && !l.startsWith('🎯') && !l.startsWith('⚠️'))
    const bttsPct = pcts[0] || '0%'
    const ouPct = pcts[1] || '0%'
    const htPct = pcts[2] || '0%'
    return { league, home, away, ouPct, bttsPct, htPct }
  }

  const d = parseRow(rawData)
  if (!d) return null

  const shortTeam = (name) => {
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length <= 2) return name
    return parts.map((w, i) => (i === 0 ? w : w[0] + '.')).join(' ')
  }

  const ouNum = parseFloat(d.ouPct) || 0
  const ouDir = ouNum > 50 ? 'over' : 'under'
  const ouPrec = Math.round(ouNum > 50 ? ouNum : 100 - ouNum)

  return (
    <div className="match-card" style={style} onClick={onClick}>
      <div className="mc-match-info">
        <div className="mc-league">{d.league}</div>
        <div className="mc-teams">
          <span>{shortTeam(d.home)}</span>
          <span className="mc-vs">vs</span>
          <span>{shortTeam(d.away)}</span>
        </div>
      </div>

      <div className="mc-ou">
        <div className="mc-ou-bar">
          <div className={`mc-ou-fill ${ouDir}`} style={{ width: `${Math.min(100, ouPrec)}%` }} />
        </div>
        <span className={`mc-ou-pct ${ouDir}`}>{ouPrec}%</span>
      </div>

      <div className="mc-btts">{d.bttsPct}</div>

      <div className="mc-handicap">{d.htPct}</div>
    </div>
  )
}

export default MatchCard
