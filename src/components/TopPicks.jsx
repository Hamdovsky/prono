import React, { useState, useEffect } from 'react'
import { getApiUrl } from '../config/apiConfig'
import './TopPicks.css'

const TopPicks = () => {
  const [data, setData] = useState(null)
  const [accuracy, setAccuracy] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(getApiUrl('/api/top-picks'))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setData(d)
        else setData(null)
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false))
    fetch(getApiUrl('/api/top-picks/accuracy'))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setAccuracy(d)
      })
      .catch(() => setAccuracy(null))
  }, [])

  if (loading) return <div className="top-picks-loading">Chargement des pronostics...</div>
  if (!data || !data.top_confidence)
    return (
      <div className="top-picks-empty">Aucun pronostic disponible. Lance daily_predictions.py</div>
    )

  const { top_confidence, top_value, generated_at, total_matches } = data
  const date = generated_at ? new Date(generated_at).toLocaleDateString('fr-FR') : ''

  return (
    <div className="top-picks-container">
      <div className="top-picks-header">
        <h2>🎯 Top Pronostics du {date}</h2>
        <span className="top-picks-count">{total_matches} matchs analysés</span>
      </div>

      <div className="top-picks-section">
        <h3>🏆 Par Confiance (pour gagner)</h3>
        <div className="picks-table">
          <div className="picks-row picks-header">
            <span className="col-date">Date</span>
            <span className="col-match">Match</span>
            <span className="col-prono">Prono</span>
            <span className="col-conf">Conf.</span>
            <span className="col-ou">OU 2.5</span>
            <span className="col-btts">BTTS</span>
            <span className="col-odds">Cote</span>
            <span className="col-ev">EV</span>
          </div>
          {top_confidence.map((r, i) => {
            const odds =
              r.prediction === '1' ? r.odds_home : r.prediction === 'X' ? r.odds_draw : r.odds_away
            const prob =
              r.prediction === '1' ? r.home_prob : r.prediction === 'X' ? r.draw_prob : r.away_prob
            return (
              <div key={i} className={`picks-row ${i < 3 ? 'top-three' : ''}`}>
                <span className="col-date">{r.date?.slice(5)}</span>
                <span className="col-match">
                  {r.home.slice(0, 14)} vs {r.away.slice(0, 14)}
                </span>
                <span className={`col-prono prono-${r.prediction.toLowerCase()}`}>
                  {r.prediction === '1' ? '1' : r.prediction === 'X' ? 'N' : '2'}
                </span>
                <span className="col-conf">{prob.toFixed(0)}%</span>
                <span className="col-ou">{r.ou25 != null ? `${r.ou25.toFixed(0)}%` : '-'}</span>
                <span className="col-btts">{r.btts != null ? `${r.btts.toFixed(0)}%` : '-'}</span>
                <span className="col-odds">@{odds.toFixed(2)}</span>
                <span className={`col-ev ${r.ev > 0.3 ? 'ev-good' : ''}`}>
                  {(r.ev * 100).toFixed(0)}%
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="top-picks-section">
        <h3>💰 Par Valeur (EV)</h3>
        <div className="picks-table">
          <div className="picks-row picks-header">
            <span className="col-date">Date</span>
            <span className="col-match">Match</span>
            <span className="col-prono">Prono</span>
            <span className="col-conf">Conf.</span>
            <span className="col-ou">OU 2.5</span>
            <span className="col-btts">BTTS</span>
            <span className="col-odds">Cote</span>
            <span className="col-ev">EV</span>
          </div>
          {top_value.slice(0, 5).map((r, i) => {
            const odds =
              r.prediction === '1'
                ? r.odds_home
                : r.prediction === 'X'
                  ? r.odds_draw
                  : r.prediction === '2'
                    ? r.odds_away
                    : 0
            const prob =
              r.prediction === '1'
                ? r.home_prob
                : r.prediction === 'X'
                  ? r.draw_prob
                  : r.prediction === '2'
                    ? r.away_prob
                    : 0
            return (
              <div key={i} className="picks-row">
                <span className="col-date">{r.date?.slice(5)}</span>
                <span className="col-match">
                  {r.home.slice(0, 14)} vs {r.away.slice(0, 14)}
                </span>
                <span className={`col-prono prono-${r.prediction.toLowerCase()}`}>
                  {r.prediction === '1' ? '1' : r.prediction === 'X' ? 'N' : '2'}
                </span>
                <span className="col-conf">{prob.toFixed(0)}%</span>
                <span className="col-ou">{r.ou25 != null ? `${r.ou25.toFixed(0)}%` : '-'}</span>
                <span className="col-btts">{r.btts != null ? `${r.btts.toFixed(0)}%` : '-'}</span>
                <span className="col-odds">@{odds.toFixed(2)}</span>
                <span className="col-ev ev-good">{(r.ev * 100).toFixed(0)}%</span>
              </div>
            )
          })}
        </div>
      </div>

      {accuracy && accuracy.total_settled > 0 && (
        <div className="top-picks-section accuracy-section">
          <h3>📊 Accuracy Réelle (settled)</h3>
          <div className="accuracy-stats">
            <div className="accuracy-stat">
              <span className="accuracy-label">Global</span>
              <span className="accuracy-value">{accuracy.win_rate}%</span>
              <span className="accuracy-sub">
                {accuracy.won}/{accuracy.total_settled}
              </span>
            </div>
            <div className="accuracy-stat">
              <span className="accuracy-label">ROI (flat 1u)</span>
              <span className={`accuracy-value ${accuracy.roi_percent >= 0 ? 'acc-pos' : 'acc-neg'}`}>
                {accuracy.roi_percent >= 0 ? '+' : ''}
                {accuracy.roi_percent}%
              </span>
              <span className="accuracy-sub">En attente: {accuracy.pending}</span>
            </div>
            {accuracy.by_source && (
              <div className="accuracy-stat">
                <span className="accuracy-label">Confiance</span>
                <span className="accuracy-value">
                  {accuracy.by_source.top_confidence?.win_rate ?? 0}%
                </span>
                <span className="accuracy-sub">
                  {accuracy.by_source.top_confidence?.won ?? 0}/
                  {accuracy.by_source.top_confidence?.total ?? 0}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TopPicks
