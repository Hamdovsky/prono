import React, { useEffect } from 'react'
import './UltimateMatchCenter.css'
import PlayerProps from '../PlayerProps/PlayerProps'

const UltimateMatchCenter = ({ match, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!match) return null

  const parseProb = (val) => {
    if (!val) return 0
    const num = parseFloat(String(val).replace('%', ''))
    if (isNaN(num)) return 0
    return num <= 1 ? Math.round(num * 100) : Math.round(num)
  }

  const ts = match.startTimestamp ? match.startTimestamp * 1000 : match.startTime
  const statusUpper = (match.status || '').toUpperCase()
  const isLive =
    statusUpper === 'LIVE' ||
    (match.minute && match.minute !== '0' && statusUpper !== 'FINISHED' && statusUpper !== 'FT')
  const isFinished = statusUpper === 'FT' || statusUpper === 'FINISHED'

  const homeWinP = parseProb(match.home_win_probability || match.winProb || 0)
  const awayWinP = parseProb(match.away_win_probability || 0)
  const dnbHome =
    homeWinP + awayWinP > 0 ? Math.round((homeWinP / (homeWinP + awayWinP)) * 100) : '--'
  const dnbAway =
    homeWinP + awayWinP > 0 ? Math.round((awayWinP / (homeWinP + awayWinP)) * 100) : '--'

  return (
    <div className="umc-overlay" onClick={onClose}>
      <div
        className="umc-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="umc-close-btn" onClick={onClose}>
          ×
        </button>

        {/* ── HEADER ── */}
        <div className="umc-header">
          <div className="umc-league-badge">
            {match.tournament_name || match.league || 'COMPETITION'}
          </div>
          <div className="umc-teams-score">
            <div
              className="umc-team home"
              style={{ textAlign: 'right', flex: 1, fontSize: '1.5rem', fontWeight: 800 }}
            >
              {match.homeTeam}
            </div>
            <div
              className="umc-score-box"
              style={{
                background: 'rgba(0,0,0,0.4)',
                padding: '10px 24px',
                borderRadius: 12,
                minWidth: 100,
                fontSize: '2rem',
                fontWeight: 900,
              }}
            >
              {match.homeScore ?? '-'} - {match.awayScore ?? '-'}
            </div>
            <div
              className="umc-team away"
              style={{ textAlign: 'left', flex: 1, fontSize: '1.5rem', fontWeight: 800 }}
            >
              {match.awayTeam}
            </div>
          </div>
        </div>

        <div
          className="umc-body"
          style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 20 }}
        >
          {/* Player Props */}
          {match.player_props && Object.keys(match.player_props).length > 0 && (
            <div className="col-span-12">
              <PlayerProps propsData={match.player_props} />
            </div>
          )}

          {/* DNB / DC Summary */}
          <div className="col-span-12" style={{ display: 'flex', gap: 15 }}>
            <div
              style={{
                flex: 1,
                background: 'rgba(30,41,59,0.3)',
                padding: 15,
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <div
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  color: '#94a3b8',
                  textAlign: 'center',
                  marginBottom: 10,
                }}
              >
                DRAW NO BET (DNB)
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 20 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.6rem', color: '#64748b' }}>{match.homeTeam}</div>
                  <div style={{ fontWeight: 800, color: '#38bdf8' }}>{dnbHome}%</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.6rem', color: '#64748b' }}>{match.awayTeam}</div>
                  <div style={{ fontWeight: 800, color: '#38bdf8' }}>{dnbAway}%</div>
                </div>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                background: 'rgba(30,41,59,0.3)',
                padding: 15,
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <div
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  color: '#94a3b8',
                  textAlign: 'center',
                  marginBottom: 10,
                }}
              >
                CHANCE DOUBLE
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 20 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.6rem', color: '#64748b' }}>1X</div>
                  <div style={{ fontWeight: 800, color: '#38bdf8' }}>
                    {homeWinP + parseProb(match.draw_probability)}%
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.6rem', color: '#64748b' }}>X2</div>
                  <div style={{ fontWeight: 800, color: '#38bdf8' }}>
                    {awayWinP + parseProb(match.draw_probability)}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default UltimateMatchCenter
