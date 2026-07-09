import React, { useState, useEffect } from 'react';
import './EliteROITracker.css';

const EliteROITracker = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let mounted = true;
    const fetchData = async () => {
      try {
        const r = await fetch('/api/results/elite-tracker');
        const json = await r.json();
        if (!mounted) return;
        if (json.success) setData(json);
        else setError(json.error || 'Erreur inconnue');
      } catch (e) {
        if (mounted) setError(e.message);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  if (error) {
    return (
      <div className="roi-tracker-container">
        <div className="roi-tracker-bar">
          <span className="roi-label">📊 TRACK RECORD</span>
          <span className="roi-value" style={{ color: '#8b949e' }}>⚠️ {error}</span>
        </div>
      </div>
    );
  }

  if (!data || data.total_bets === 0) {
    return (
      <div className="roi-tracker-container">
        <div className="roi-tracker-bar">
          <span className="roi-label">📊 TRACK RECORD</span>
          <span className="roi-value" style={{ color: '#8b949e' }}>En attente des premiers résultats...</span>
        </div>
      </div>
    );
  }

  const { roi, net_profit, won, lost, win_rate, total_bets, by_signal, matches } = data;
  const roiColor = roi >= 0 ? '#3fb950' : '#f85149';

  return (
    <div className="roi-tracker-container">
      <div className="roi-tracker-bar" onClick={() => setExpanded(e => !e)} style={{ cursor: 'pointer' }}>
        <span className="roi-label">📊 TRACK RECORD</span>
        <span className="roi-stat">{total_bets} paris</span>
        <span className="roi-stat">{won}W/{lost}L</span>
        <span className="roi-stat" style={{ color: win_rate >= 50 ? '#3fb950' : '#d29922' }}>{win_rate}%</span>
        <span className="roi-value" style={{ color: roiColor }}>
          {roi >= 0 ? '+' : ''}{roi}% ROI
        </span>
        <span className="roi-toggle">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="roi-detail">
          <div className="roi-signal-strip">
            {by_signal.solid.count > 0 && (
              <span className="roi-signal-item solid">
                ⚡ SOLID: {by_signal.solid.count} | ROI {by_signal.solid.roi >= 0 ? '+' : ''}{by_signal.solid.roi}%
              </span>
            )}
            {by_signal.value_bet.count > 0 && (
              <span className="roi-signal-item valuebet">
                🎯 VALUE BET: {by_signal.value_bet.count} | ROI {by_signal.value_bet.roi >= 0 ? '+' : ''}{by_signal.value_bet.roi}%
              </span>
            )}
            {by_signal.dynamic.count > 0 && (
              <span className="roi-signal-item dynamic">
                DYNAMIC: {by_signal.dynamic.count}
              </span>
            )}
          </div>

          <div className="roi-match-list">
            {matches.map(m => (
              <div key={m.id} className={`roi-match-row ${m.result}`}>
                <span className="roi-match-score">{m.score}</span>
                <span className="roi-match-teams">{m.homeTeam} vs {m.awayTeam}</span>
                <span className="roi-match-pick">{m.pick}</span>
                <span className="roi-match-ev">EV {m.ev.toFixed(2)}</span>
                <span className={`roi-match-result ${m.result}`}>
                  {m.result === 'won' ? '✅ +' : '❌ '}{m.profit > 0 ? m.profit.toFixed(2) : m.profit.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default EliteROITracker;
