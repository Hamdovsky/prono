import React from 'react';
import './EliteRadar.css';

const EliteRadarDashboard = ({ eliteMatches }) => {
  if (!eliteMatches || eliteMatches.length === 0) {
    return (
      <div className="elite-radar-container">
        <div className="radar-header">
          <div className="brand">Laboratoire Hamdi — ⚡ TITANIUM NEURAL-X v3.5</div>
          <div className="status-badge">🔴 AUCUN MATCH DISPONIBLE</div>
        </div>
        <div style={{ padding: '20px', textAlign: 'center', color: '#8b949e', fontSize: '12px' }}>
          Aucun match ne correspond aux critères de la sélection chirurgicale.
        </div>
      </div>
    );
  }

  return (
    <div className="elite-radar-container">
      <div className="radar-header">
        <div className="brand">Laboratoire Hamdi — ⚡ TITANIUM NEURAL-X v3.5</div>
        <div className="status-badge">🟢 MODE CHIRURGICAL ACTIVE ({eliteMatches.length} ELITE)</div>
      </div>

      <table className="radar-table">
        <thead>
          <tr>
            <th>🏆 COMPÉTITION / MATCH</th>
            <th className="text-center">🎯 PICK</th>
            <th className="text-center">📊 PROBS (1/X/2)</th>
            <th className="text-center">💵 VALUE INDEX</th>
            <th className="text-center">🛡️ TARGET SIGNAL</th>
          </tr>
        </thead>
        <tbody>
          {eliteMatches.map((match, idx) => {
            const enriched = match.enriched || {};
            const quant = match.quant || enriched.quant || {};
            const hPct = Math.round(parseFloat(match.home_win_probability || enriched.home_win_probability || 0));
            const dPct = Math.round(parseFloat(match.draw_probability || enriched.draw_probability || 0));
            const aPct = Math.round(parseFloat(match.away_win_probability || enriched.away_win_probability || 0));
            const isSolid = (match.base_solid_margin || 0) > 0 && (match.base_solid_margin || 0) >= 25;
            const isValueBet = match.draw_value_bet === true || match.draw_value_bet === 'True' || match.draw_value_bet === 1;

            return (
              <tr key={match.id || idx} className={isSolid ? 'row-solid' : isValueBet ? 'row-value' : ''}>
                <td className="match-cell">
                  <span className="league-tag">[{match.league || match.tournament_name || match.competition || 'INT'}]</span>
                  <span className="teams-text">{match.homeTeam} vs {match.awayTeam}</span>
                </td>

                <td className="text-center">
                  <span className={`pick-badge ${isSolid ? 'solid' : isValueBet ? 'value-draw' : 'standard'}`}>
                    {quant.main_pick || match.pick || 'N/A'}
                  </span>
                </td>

                <td className="text-center technical-text">
                  <span className="prob-h">{hPct}%</span>/
                  <span className="prob-d">{dPct}%</span>/
                  <span className="prob-a">{aPct}%</span>
                </td>

                <td className="text-center technical-text ev-highlight">
                  EV={parseFloat(quant.ev_score || match.ev_score || 0).toFixed(2)}
                </td>

                <td className="text-center">
                  {isSolid && (
                    <span className="signal-tag solid-signal">
                      ⚡ SOLID (BSM: {Math.round(match.base_solid_margin)}%)
                    </span>
                  )}
                  {isValueBet && (
                    <span className="signal-tag draw-signal">
                      🎯 VALUE BET (Draw Sniffer)
                    </span>
                  )}
                  {!isSolid && !isValueBet && (
                    <span className="signal-tag standard-signal">DYNAMIC</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default EliteRadarDashboard;
