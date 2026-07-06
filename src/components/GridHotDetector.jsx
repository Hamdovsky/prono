import React, { useState, useEffect } from 'react'
import { fetchHotGrids } from '../services/gridHotService'
import './GridHotDetector.css'

function GridHotDetector() {
  const [hotGrids, setHotGrids] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [timeRange, setTimeRange] = useState('7')

  useEffect(() => {
    loadHotGrids()
  }, [timeRange])

  const loadHotGrids = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchHotGrids({
        days: parseInt(timeRange),
        minScore: 55
      })
      setHotGrids(result.data || [])
    } catch (e) {
      setError(e.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }

  const getRatingColor = (rating) => {
    if (rating.includes('TRÈS CHAUD')) return '#ef4444'
    if (rating.includes('CHAU')) return '#f97316'
    if (rating.includes('TIÈDE')) return '#eab308'
    if (rating.includes('FRIS')) return '#3b82f6'
    return '#6b7280'
  }

  const getRatingEmoji = (rating) => {
    if (rating.includes('TRÈS CHAUD')) return '🔥'
    if (rating.includes('CHAU')) return '🔥'
    if (rating.includes('TIÈDE')) return '🌡️'
    if (rating.includes('FRIS')) return '❄️'
    return '🧊'
  }

  if (loading) {
    return (
      <div className="grid-hot-container">
        <h2 className="grid-hot-title">🔥 Détecteur de Grids Hot</h2>
        <div className="grid-loading">Chargement...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="grid-hot-container">
        <h2 className="grid-hot-title">🔥 Détecteur de Grids Hot</h2>
        <div className="grid-error">❌ {error}</div>
      </div>
    )
  }

  return (
    <div className="grid-hot-container">
      <h2 className="grid-hot-title">🔥 Détecteur de Grids Hot</h2>
      
      <div className="grid-controls">
        <select 
          value={timeRange} 
          onChange={(e) => setTimeRange(e.target.value)}
          className="time-select"
        >
          <option value="3">3 derniers jours</option>
          <option value="7">7 derniers jours</option>
          <option value="14">14 derniers jours</option>
          <option value="30">30 derniers jours</option>
        </select>
        
        <button onClick={loadHotGrids} className="refresh-btn">
          🔄 Actualiser
        </button>
      </div>

      <div className="grids-list">
        {hotGrids.length === 0 ? (
          <div className="grid-empty">
            Aucun grid "hot" détecté pour cette période
          </div>
        ) : (
          hotGrids.map((grid) => (
            <div 
              key={grid.grid} 
              className="grid-card"
              style={{ borderLeft: `4px solid ${getRatingColor(grid.rating)}` }}
            >
              <div className="grid-header">
                <span className="grid-number">Grid {grid.grid}</span>
                <span className="grid-rating" style={{ color: getRatingColor(grid.rating) }}>
                  {getRatingEmoji(grid.rating)} {grid.rating}
                </span>
              </div>
              
              <div className="grid-score">
                Score: {grid.score.toFixed(1)}/100
              </div>
              
              <div className="grid-metrics">
                <div className="metric">
                  <span className="metric-label">Cagnotte</span>
                  <span className="metric-value">{grid.cagnotte ? `${grid.cagnotte} TND` : '-'}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Matchs</span>
                  <span className="metric-value">{grid.matchCount}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Taux réussite</span>
                  <span className="metric-value">{grid.winRate ? `${grid.winRate.toFixed(1)}%` : '-'}</span>
                </div>
              </div>
              
              {grid.factors && grid.factors.length > 0 && (
                <div className="grid-factors">
                  {grid.factors.slice(0, 4).map((f, idx) => (
                    <span key={idx} className="factor-tag">
                      {f.name}: {f.value}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default GridHotDetector