import React, { useState, useEffect } from 'react'
import { getApiUrl } from '../config/apiConfig'

const LEAGUE_COLORS = {
  'Botola Pro': '#00ffaa',
  'FIFA World Cup': '#fbbf24',
  'World Cup 2026': '#38bdf8',
  'Suomen Cup': '#a78bfa',
  'LaLiga 2': '#f472b6',
}

const AccuracyTracker = () => {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState('total')

  useEffect(() => {
    fetch(getApiUrl('/api/accuracy/tracker'))
      .then(r => r.json())
      .then(d => { if (d.success) setData(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>
      Chargement du tracker de précision...
    </div>
  )
  if (!data || !data.leagues) return (
    <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>
      Aucune donnée disponible. Les matchs doivent avoir des scores réels et des probabilités.
    </div>
  )

  const sortedLeagues = [...data.leagues].sort((a, b) => {
    if (sortBy === 'winRate') return b.winRate - a.winRate
    if (sortBy === 'league') return a.league.localeCompare(b.league)
    return b.total - a.total
  })

  const barMax = Math.max(...data.leagues.map(l => l.total), 1)

  return (
    <div style={{ padding: '16px 20px', color: '#e2e8f0', fontFamily: 'Inter, sans-serif' }}>
      <h2 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '4px', color: '#f1f5f9' }}>
        Précision des Pronostics
      </h2>
      <p style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '20px' }}>
        Comparaison des prédictions (IA) vs résultats réels — {data.total} matchs analysés
      </p>

      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' }}>
        {[
          { label: 'Total', value: data.total, color: '#38bdf8' },
          { label: 'Corrects', value: data.correct, color: '#00ffaa' },
          { label: 'Incorrects', value: data.wrong, color: '#ef4444' },
          { label: 'Win Rate', value: data.winRate + '%', color: data.winRate >= 50 ? '#00ffaa' : '#ef4444' },
        ].map(stat => (
          <div key={stat.label} style={{
            background: '#0f172a', borderRadius: '12px', padding: '16px 24px',
            border: '1px solid #1e293b', minWidth: '120px', flex: 1
          }}>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>{stat.label}</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      <div style={{
        background: '#0f172a', borderRadius: '12px', border: '1px solid #1e293b', overflow: 'hidden'
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', padding: '12px 16px',
          borderBottom: '1px solid #1e293b', fontSize: '12px', color: '#64748b', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.5px'
        }}>
          <span style={{ flex: 2, cursor: 'pointer' }} onClick={() => setSortBy('league')}>Ligue</span>
          <span style={{ flex: 1, textAlign: 'center', cursor: 'pointer' }} onClick={() => setSortBy('total')}>Matchs</span>
          <span style={{ flex: 1, textAlign: 'center' }}>Corrects</span>
          <span style={{ flex: 1, textAlign: 'center' }}>Incorrects</span>
          <span style={{ flex: 1, textAlign: 'center', cursor: 'pointer' }} onClick={() => setSortBy('winRate')}>Win Rate</span>
          <span style={{ flex: 3, textAlign: 'center' }}>Barre</span>
        </div>
        {sortedLeagues.map((l, i) => {
          const color = LEAGUE_COLORS[l.league] || '#38bdf8'
          const barWidth = Math.max((l.total / barMax) * 100, 2)
          return (
            <div key={l.league} style={{
              display: 'flex', alignItems: 'center', padding: '10px 16px',
              borderBottom: i < sortedLeagues.length - 1 ? '1px solid #1e293b' : 'none',
              fontSize: '13px'
            }}>
              <span style={{ flex: 2, fontWeight: 500, color: '#e2e8f0' }}>{l.league}</span>
              <span style={{ flex: 1, textAlign: 'center', color: '#94a3b8' }}>{l.total}</span>
              <span style={{ flex: 1, textAlign: 'center', color: '#00ffaa', fontWeight: 600 }}>{l.correct}</span>
              <span style={{ flex: 1, textAlign: 'center', color: '#ef4444', fontWeight: 600 }}>{l.wrong}</span>
              <span style={{
                flex: 1, textAlign: 'center', fontWeight: 700, fontSize: '14px',
                color: l.winRate >= 60 ? '#00ffaa' : l.winRate >= 40 ? '#fbbf24' : '#ef4444'
              }}>{l.winRate}%</span>
              <div style={{ flex: 3, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{
                  height: '8px', width: barWidth + '%', borderRadius: '4px',
                  background: `linear-gradient(90deg, ${color}, ${color}88)`,
                  transition: 'width 0.3s ease',
                  minWidth: '4px'
                }} />
                <span style={{ fontSize: '11px', color: '#475569', minWidth: '30px' }}>{l.total}</span>
              </div>
            </div>
          )
        })}
      </div>

      <p style={{ fontSize: '11px', color: '#475569', marginTop: '12px', textAlign: 'center' }}>
        Les prédictions sont déterminées par la probabilité la plus élevée (Home/Draw/Away).
      </p>
    </div>
  )
}

export default AccuracyTracker
