import React, { useState, useEffect } from 'react'
import { fetchEvolutionData } from '../services/heatmapService'
import './EvolutionHeatmap.css'

function EvolutionHeatmap() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [timeRange, setTimeRange] = useState('30') // days
  const [selectedLeague, setSelectedLeague] = useState('all')

  useEffect(() => {
    loadData()
  }, [timeRange, selectedLeague])

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchEvolutionData({
        days: parseInt(timeRange),
        league: selectedLeague,
      })
      setData(result.data || [])
    } catch (e) {
      setError(e.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }

  const getColorClass = (value) => {
    if (value === null || value === undefined) return 'no-data'
    if (value >= 90) return 'excellent'
    if (value >= 75) return 'good'
    if (value >= 60) return 'average'
    if (value >= 45) return 'below-avg'
    if (value >= 30) return 'poor'
    return 'very-poor'
  }

  const renderLegend = () => (
    <div className="heatmap-legend">
      <span className="legend-title">Légende:</span>
      <div className="legend-items">
        <span className="legend-item excellent">≥ 90%</span>
        <span className="legend-item good">75-89%</span>
        <span className="legend-item average">60-74%</span>
        <span className="legend-item below-avg">45-59%</span>
        <span className="legend-item poor">30-44%</span>
        <span className="legend-item very-poor">{'< 30%'}</span>
        <span className="legend-item no-data">N/A</span>
      </div>
    </div>
  )

  if (loading) {
    return (
      <div className="heatmap-container">
        <h2 className="heatmap-title">📊 Heatmap Évolution Concours</h2>
        <div className="heatmap-loading">Chargement...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="heatmap-container">
        <h2 className="heatmap-title">📊 Heatmap Évolution Concours</h2>
        <div className="heatmap-error">❌ {error}</div>
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <div className="heatmap-container">
        <h2 className="heatmap-title">📊 Heatmap Évolution Concours</h2>
        <div className="heatmap-empty">Aucune donnée disponible</div>
      </div>
    )
  }

  return (
    <div className="heatmap-container">
      <h2 className="heatmap-title">📊 Heatmap Évolution Concours Tunisie</h2>

      <div className="heatmap-controls">
        <select
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value)}
          className="time-range-select"
        >
          <option value="7">7 derniers jours</option>
          <option value="14">14 derniers jours</option>
          <option value="30">30 derniers jours</option>
          <option value="60">60 derniers jours</option>
          <option value="90">90 derniers jours</option>
        </select>

        <select
          value={selectedLeague}
          onChange={(e) => setSelectedLeague(e.target.value)}
          className="league-select"
        >
          <option value="all">Tous Concours</option>
          <option value="promosport">Promosport</option>
          <option value="tunisie">Tunisie</option>
        </select>
      </div>

      <div className="heatmap-wrapper">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th>Concours</th>
              <th>Score Moyen</th>
              <th>Taux de Réussite</th>
              <th>Volatilité</th>
              <th>Dernier Score</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, idx) => (
              <tr key={idx} className={`heatmap-row ${getColorClass(row.success_rate)}`}>
                <td className="concours-name">{row.concours || `Concours ${idx + 1}`}</td>
                <td className="score-avg">
                  {row.avg_score !== null ? row.avg_score.toFixed(1) : '-'}
                </td>
                <td className={`success-rate ${getColorClass(row.success_rate)}`}>
                  {row.success_rate !== null ? `${row.success_rate.toFixed(1)}%` : '-'}
                </td>
                <td className="volatility">
                  {row.volatility !== null ? row.volatility.toFixed(2) : '-'}
                </td>
                <td className="last-score">
                  {row.last_score !== null ? row.last_score.toFixed(1) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {renderLegend()}

      <div className="heatmap-summary">
        <div className="summary-card">
          <span className="summary-value">{data.length}</span>
          <span className="summary-label">Concours analysés</span>
        </div>
        <div className="summary-card">
          <span className="summary-value">
            {data.reduce((sum, r) => sum + (r.success_rate || 0), 0) / data.length.toFixed(1)}%
          </span>
          <span className="summary-label">Taux réussite moyen</span>
        </div>
        <div className="summary-card">
          <span className="summary-value">
            {data.reduce((sum, r) => sum + (r.volatility || 0), 0) / data.length.toFixed(2)}
          </span>
          <span className="summary-label">Volatilité moyenne</span>
        </div>
      </div>

      <button onClick={loadData} className="refresh-btn" disabled={loading}>
        🔄 Actualiser
      </button>
    </div>
  )
}

export default EvolutionHeatmap
