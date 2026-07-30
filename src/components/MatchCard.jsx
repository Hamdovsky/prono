import React from 'react'
import './MatchCard.css'

const MatchCard = ({ rawData, style, isElite, onClick }) => {
  const parseRow = (lines) => {
    if (!lines || lines.length === 0) return null
    const league = lines[0] || ''
    const home = lines[1] || ''
    const away = lines[2] || ''
    const edgeLine = lines.find((l) => l.startsWith('🎯')) || ''
    const edgeVal = edgeLine.replace('🎯', '').replace('%', '').trim()
    const pcts = lines.filter((l) => l.includes('%') && !l.startsWith('🎯') && !l.startsWith('⚠️'))
    const bttsPct = pcts[0] || '0%'
    const ouPct = pcts[1] || '0%'
    const htPct = pcts[2] || '0%'
    const evLine = lines.find((l) => l.startsWith('EV')) || 'EV 0.00'
    const evVal = evLine.replace('EV', '').trim()
    const riskLine = lines.find(
      (l) =>
        !l.startsWith('🎯') &&
        !l.startsWith('EV') &&
        !l.startsWith('1X2') &&
        !l.startsWith('DVB') &&
        !l.startsWith('BSM') &&
        !l.startsWith('⚠️') &&
        !l.includes('%') &&
        !l.includes(':') &&
        l.length < 20 &&
        !l.includes('LIVE')
    )
    const risk = riskLine || ''
    const pickLine = lines.find((l) => l.startsWith('1X2:')) || '1X2: X'
    const pick = pickLine.replace('1X2:', '').trim()
    const dvbLine = lines.find((l) => l.startsWith('DVB:')) || 'DVB:0'
    const dvb = dvbLine.replace('DVB:', '').trim() === '1'
    const bsmLine = lines.find((l) => l.startsWith('BSM:')) || 'BSM:0'
    const bsm = parseFloat(bsmLine.replace('BSM:', '').trim()) || 0
    const isLive = lines.includes('LIVE')
    return { league, home, away, edgeVal, ouPct, bttsPct, evVal, pick, dvb, bsm, isLive }
  }

  const d = parseRow(rawData)
  if (!d) return null

  const shortTeam = (name) => {
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length <= 2) return name
    return parts.map((w, i) => (i === 0 ? w : w[0] + '.')).join(' ')
  }

  const edgeNum = parseFloat(d.edgeVal) || 0
  const ouNum = parseFloat(d.ouPct) || 0
  const evNum = parseFloat(d.evVal) || 0

  const ouDir = ouNum > 50 ? 'over' : 'under'
  const ouLabel = ouNum > 50 ? 'OVER' : 'UNDER'
  const ouPrec = Math.round(ouNum > 50 ? ouNum : 100 - ouNum)

  const evClass = evNum >= 0.45 ? 'mc-ev-high' : evNum >= 0.35 ? 'mc-ev-med' : 'mc-ev-low'
  const edgeClass =
    edgeNum > 0 ? 'mc-edge-positive' : edgeNum < 0 ? 'mc-edge-negative' : 'mc-edge-zero'

  const pickClass = `mc-pick-${d.pick}`
  const cardClass = `match-card${isElite ? ' elite' : ''}${d.dvb ? ' millionaire' : ''}`

  return (
    <div className={cardClass} style={style} onClick={onClick}>
      {/* Left: League + Teams */}
      <div className="mc-match-info">
        <div className="mc-league">{d.league}</div>
        <div className="mc-teams">
          <span>{shortTeam(d.home)}</span>
          <span className="mc-vs">vs</span>
          <span>{shortTeam(d.away)}</span>
        </div>
        <div className="mc-badges">
          {d.dvb && <span className="mc-badge mc-badge-value">VALUE BET</span>}
          {d.bsm >= 25 && <span className="mc-badge mc-badge-solid">SOLID</span>}
          {d.isLive && <span className="mc-badge mc-badge-live">LIVE</span>}
        </div>
      </div>

      {/* Pick + Edge */}
      <div className="mc-pick-cell">
        <div className={`mc-pick ${pickClass}`}>{d.pick}</div>
        <div className={`mc-edge ${edgeClass}`}>
          {edgeNum > 0 ? '+' : ''}
          {d.edgeVal}%
        </div>
      </div>

      {/* O/U 2.5 */}
      <div className="mc-markets">
        <div className="mc-ou">
          <span className="mc-ou-label">O/U</span>
          <div className="mc-ou-bar">
            <div className={`mc-ou-fill ${ouDir}`} style={{ width: `${Math.min(100, ouPrec)}%` }} />
          </div>
          <span className={`mc-ou-pct ${ouDir}`}>{ouPrec}%</span>
        </div>
      </div>

      {/* EV */}
      <div className="mc-ev-cell">
        <div className={`mc-ev ${evClass}`}>{d.evVal}</div>
        <div className="mc-ev-label">EV</div>
      </div>

      {/* DVB Flash */}
      {d.dvb && <div className="mc-dvb-flash">DVB</div>}
    </div>
  )
}

export default MatchCard
