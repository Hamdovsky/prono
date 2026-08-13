import React, { useState, useEffect, useMemo } from 'react'
import './UltimateMatchCenter.css'
import { calculateEV, analyzeValue } from '../../services/InsightEngine'
import PlayerProps from '../PlayerProps/PlayerProps'
import { analyzeMatch } from '../../utils/matchAnalysis'

const UltimateMatchCenter = ({ match, onClose }) => {
  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const analysis = useMemo(() => analyzeMatch(match), [match])

  const valueAnalysis = useMemo(() => {
    if (!analysis?.hasRealOdds) return null
    return analyzeValue({
      modelHome: analysis.probs.home,
      modelDraw: analysis.probs.draw,
      modelAway: analysis.probs.away,
      homeOdds: analysis.odds.home,
      drawOdds: analysis.odds.draw,
      awayOdds: analysis.odds.away,
    })
  }, [analysis])

  if (!match) return null

  const ts = match.startTimestamp ? match.startTimestamp * 1000 : match.startTime
  const kickoff = ts
    ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—'
  const statusUpper = (match.status || '').toUpperCase()
  const isLive =
    statusUpper === 'LIVE' ||
    (match.minute && match.minute !== '0' && statusUpper !== 'FINISHED' && statusUpper !== 'FT')
  const isFinished = statusUpper === 'FT' || statusUpper === 'FINISHED' || analysis?.finished

  const scoreLabel =
    isFinished && match.homeScore != null && match.awayScore != null
      ? `${match.homeScore} - ${match.awayScore}`
      : null
  const statusLabel = isFinished
    ? `TERMINÉ ${scoreLabel ? '· ' + scoreLabel : ''}`
    : isLive
      ? `EN DIRECT${match.minute ? ` · ${match.minute}'` : ''}`
      : 'À VENIR'

  const xgbConf = match.xgboost_confidence ? parseFloat(match.xgboost_confidence) : 0
  const baseWinP = parseInt(match.home_win_probability || match.winProb || 0)
  const winP = parseInt(match.adjusted_win_prob || baseWinP)
  const ev = calculateEV(winP, match.market_odds || 2.0)
  const reliability = Math.round(match.reliability_index || 50)

  const honestyBadge =
    analysis?.honesty.mode === 'normal' ? (
      <span style={{ color: '#10b981', fontSize: '0.8rem', fontWeight: 700 }}>✅ Cotes réelles</span>
    ) : analysis?.honesty.mode === 'modelOnly' ? (
      <span style={{ color: '#fbbf24', fontSize: '0.8rem', fontWeight: 700 }}>
        🔮 Modèle — sans cotes (pas d'EV)
      </span>
    ) : analysis?.honesty.mode === 'modelSignal' ? (
      <span style={{ color: '#fbbf24', fontSize: '0.8rem', fontWeight: 700 }}>
        🔮 Signal modèle (pas d'EV)
      </span>
    ) : (
      <span style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: 700 }}>
        🔮 Estimation sans cotes
      </span>
    )

  const pickClass =
    analysis?.winner.pick === '1'
      ? { color: '#38bdf8' }
      : analysis?.winner.pick === 'X'
        ? { color: '#94a3b8' }
        : analysis?.winner.pick === '2'
          ? { color: '#fb7185' }
          : { color: '#f1f5f9' }

  const probBars = [
    { label: '1', name: match.homeTeam, pct: analysis?.probs.home || 0, color: '#38bdf8' },
    { label: 'X', name: 'Nul', pct: analysis?.probs.draw || 0, color: '#94a3b8' },
    { label: '2', name: match.awayTeam, pct: analysis?.probs.away || 0, color: '#fb7185' },
  ]

  const valueRows = valueAnalysis
    ? [valueAnalysis.home, valueAnalysis.draw, valueAnalysis.away]
        .filter(Boolean)
        .map((v) => ({
          label: v.label,
          odds: v.odds,
          model: v.modelProb,
          fair: v.fairProb,
          edge: v.edge,
          ev: v.ev,
          kelly: v.kelly,
          tier: v.tier,
          best: v === valueAnalysis.best,
        }))
        .sort((a, b) => b.edge - a.edge)
    : []

  return (
    <div className="umc-overlay" onClick={onClose}>
      <div className="umc-modal" onClick={(e) => e.stopPropagation()}>
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
        >
          {/* INFORMATIONS CLÉS DU MATCH (remplace l'ancien simulateur Monte Carlo) */}
          <div
            className="col-span-12 umc-panel"
            style={{
              background: 'rgba(15, 23, 42, 0.7)',
              border: '1px solid rgba(99, 102, 241, 0.3)',
              padding: 25,
              borderRadius: 20,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 20,
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{
                    background: '#6366f1',
                    color: '#fff',
                    fontSize: '0.7rem',
                    fontWeight: 900,
                    padding: '2px 8px',
                    borderRadius: 4,
                  }}
                >
                  ANALYSE RÉELLE
                </span>
                <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#f1f5f9' }}>
                  ⚡ Informations clés du match
                </h3>
              </div>
              {honestyBadge}
            </div>

            {/* Row 1 : verdict + probabilités 1/X/2 */}
            <div className="umc-verdict-row">
              <div
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  borderRadius: 14,
                  padding: '18px 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  border: `2px solid ${analysis?.winner.solid ? 'rgba(245,158,11,0.6)' : 'rgba(255,255,255,0.06)'}`,
                }}
              >
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: '#94a3b8',
                    fontWeight: 800,
                    letterSpacing: '1px',
                    textTransform: 'uppercase',
                    marginBottom: 6,
                  }}
                >
                  Verdict du modèle
                </div>
                <div style={{ fontSize: '2.6rem', fontWeight: 900, ...pickClass }}>{analysis?.winner.pick}</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f1f5f9' }}>
                  {analysis?.winner.label}
                </div>
                {analysis?.winner.solid && (
                  <div
                    style={{
                      marginTop: 8,
                      background: 'rgba(245,158,11,0.12)',
                      border: '1px solid rgba(245,158,11,0.3)',
                      color: '#fbbf24',
                      padding: '2px 10px',
                      borderRadius: 20,
                      fontSize: '0.7rem',
                      fontWeight: 800,
                    }}
                  >
                    🎯 BASE SOLIDE
                  </div>
                )}
              </div>

              <div
                style={{
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: 14,
                  padding: '18px 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 12,
                }}
              >
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: '#94a3b8',
                    fontWeight: 800,
                    letterSpacing: '1px',
                    textTransform: 'uppercase',
                    marginBottom: 2,
                  }}
                >
                  Probabilités 1 / X / 2
                </div>
                {probBars.map((b) => (
                  <div key={b.label}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: '0.75rem',
                        color: '#cbd5e1',
                        marginBottom: 4,
                      }}
                    >
                      <span>
                        <b style={{ color: b.color }}>{b.label}</b>{' '}
                        <span style={{ color: '#64748b' }}>{b.name}</span>
                      </span>
                      <b style={{ color: b.color }}>{b.pct}%</b>
                    </div>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 4,
                        background: 'rgba(255,255,255,0.06)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, b.pct)}%`,
                          background: b.color,
                          borderRadius: 4,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Row 2 : marchés chirurgicaux */}
            <div className="umc-markets-grid">
              <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ fontSize: '0.62rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase' }}>
                  BTTS
                </div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#10b981', marginTop: 6 }}>
                  {analysis?.btts.label}
                </div>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ fontSize: '0.62rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase' }}>
                  Over / Under 2.5
                </div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#38bdf8', marginTop: 6 }}>
                  {analysis?.ou.direction} {analysis?.ou.label}
                </div>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ fontSize: '0.62rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase' }}>
                  Corners
                </div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#a855f7', marginTop: 6 }}>
                  {analysis?.corners.label}
                </div>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ fontSize: '0.62rem', color: '#64748b', fontWeight: 800, textTransform: 'uppercase' }}>
                  Handicap / Score
                </div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#f59e0b', marginTop: 6 }}>
                  {analysis?.handicap.label}
                </div>
              </div>
            </div>

            {/* Row 3 : cotes & EV (seulement si cotes réelles) */}
            <div
              style={{
                background: 'rgba(0,0,0,0.25)',
                borderRadius: 12,
                padding: '16px 18px',
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  fontSize: '0.62rem',
                  color: '#94a3b8',
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  marginBottom: 10,
                }}
              >
                Cotes & Value (de-vig)
              </div>
              {valueRows.length > 0 ? (
                <div className="umc-value-grid">
                  {valueRows.map((v) => (
                    <div
                      key={v.label}
                      style={{
                        background: v.best ? 'rgba(16,185,129,0.08)' : 'rgba(255,255,255,0.02)',
                        border: v.best ? '1px solid rgba(16,185,129,0.4)' : '1px solid rgba(255,255,255,0.05)',
                        borderRadius: 10,
                        padding: '12px 14px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', color: '#cbd5e1', fontWeight: 700 }}>
                          {v.label}
                          {v.best && (
                            <span
                              style={{
                                marginLeft: 6,
                                color: v.tier.color,
                                fontSize: '0.65rem',
                                fontWeight: 800,
                              }}
                            >
                              {v.tier.label}
                            </span>
                          )}
                        </span>
                        <b style={{ color: '#f1f5f9', fontSize: '0.9rem' }}>{v.odds.toFixed(2)}</b>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: '0.68rem',
                          color: '#64748b',
                          marginTop: 8,
                        }}
                      >
                        <span>Modèle {Math.round(v.model)}%</span>
                        <span>Fair {v.fair}%</span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: '0.68rem',
                          marginTop: 4,
                        }}
                      >
                        <span style={{ color: v.edge >= 0 ? '#10b981' : '#fb7185' }}>
                          Edge {v.edge >= 0 ? '+' : ''}
                          {v.edge}%
                        </span>
                        <span style={{ color: v.ev > 0 ? '#10b981' : '#fb7185' }}>
                          EV {v.ev > 0 ? '+' : ''}
                          {Math.round(v.ev * 100)}%
                        </span>
                        <span style={{ color: '#fbbf24' }}>Kelly {v.kelly}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                  🔮 Aucune cote bookmaker réelle — valeur (EV) non calculée.
                </div>
              )}
            </div>

            {/* Row 4 : confiance & risque + détails du match */}
            <div className="umc-cr-grid">
              <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: '0.62rem', color: '#94a3b8', fontWeight: 800, textTransform: 'uppercase', marginBottom: 10 }}>
                  Confiance & Risque
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 6 }}>
                  <span style={{ color: '#64748b' }}>Fiabilité</span>
                  <b style={{ color: '#a855f7' }}>{reliability}%</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 6 }}>
                  <span style={{ color: '#64748b' }}>Confiance XGBoost</span>
                  <b style={{ color: '#6366f1' }}>{Math.round(xgbConf * 100)}%</b>
                </div>
                {match.risk_label && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 6 }}>
                    <span style={{ color: '#64748b' }}>Risque</span>
                    <b style={{ color: String(match.risk_label).toLowerCase().includes('low') ? '#10b981' : '#fbbf24' }}>
                      {String(match.risk_label).toUpperCase()}
                    </b>
                  </div>
                )}
                {match.prediction && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                    <span style={{ color: '#64748b' }}>Prédiction brute</span>
                    <b style={{ color: '#f1f5f9', textAlign: 'right' }}>{match.prediction}</b>
                  </div>
                )}
              </div>
              <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: '0.62rem', color: '#94a3b8', fontWeight: 800, textTransform: 'uppercase', marginBottom: 10 }}>
                  Détails du match
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 6 }}>
                  <span style={{ color: '#64748b' }}>Compétition</span>
                  <b style={{ color: '#f1f5f9', textAlign: 'right' }}>
                    {match.country ? `${match.country} · ` : ''}
                    {match.tournament_name || match.league}
                  </b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 6 }}>
                  <span style={{ color: '#64748b' }}>Coup d'envoi</span>
                  <b style={{ color: '#f1f5f9' }}>{kickoff}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                  <span style={{ color: '#64748b' }}>Statut</span>
                  <b
                    style={{
                      color: isLive ? '#fbbf24' : isFinished ? '#10b981' : '#38bdf8',
                    }}
                  >
                    {statusLabel}
                  </b>
                </div>
              </div>
            </div>
          </div>

          {/* KPI STRIP */}
          <div className="col-span-12 umc-kpi-grid">
            {[
              { label: 'ثقة XGBoost', val: `${Math.round(xgbConf * 100)}%`, color: '#6366f1' },
              { label: 'Value (EV+)', val: `+${Math.round(ev * 100)}%`, color: '#10b981' },
              {
                label: ' Kelly Criterion',
                val: `${(reliability / 10).toFixed(1)}%`,
                color: '#f59e0b',
              },
              { label: 'موثوقية المباراة', val: `${reliability}%`, color: '#a855f7' },
            ].map((k, i) => (
              <div
                key={i}
                style={{
                  background: 'rgba(30,41,59,0.5)',
                  padding: 15,
                  borderRadius: 12,
                  textAlign: 'center',
                  borderTop: `4px solid ${k.color}`,
                }}
              >
                <div
                  style={{
                    fontSize: '0.7rem',
                    color: '#94a3b8',
                    textTransform: 'uppercase',
                    marginBottom: 5,
                  }}
                >
                  {k.label}
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: k.color }}>{k.val}</div>
              </div>
            ))}
          </div>

          {/* Player Props */}
          <div className="col-span-12">
            <PlayerProps propsData={match.player_props} />
          </div>

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
                  <div style={{ fontWeight: 800, color: '#38bdf8' }}>{dnbOf(analysis, 'home')}%</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.6rem', color: '#64748b' }}>{match.awayTeam}</div>
                  <div style={{ fontWeight: 800, color: '#38bdf8' }}>{dnbOf(analysis, 'away')}%</div>
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
                    {(analysis?.probs.home || 0) + (analysis?.probs.draw || 0)}%
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.6rem', color: '#64748b' }}>X2</div>
                  <div style={{ fontWeight: 800, color: '#38bdf8' }}>
                    {(analysis?.probs.away || 0) + (analysis?.probs.draw || 0)}%
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

const dnbOf = (analysis, side) => {
  const h = analysis?.probs.home || 0
  const a = analysis?.probs.away || 0
  if (h + a <= 0) return '--'
  return side === 'home' ? Math.round((h / (h + a)) * 100) : Math.round((a / (h + a)) * 100)
}

export default UltimateMatchCenter