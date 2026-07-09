import React, { useState, useCallback } from 'react';
import VipPaywall, { isVipUnlocked } from './VipPaywall';
import './EliteRadar.css';

const EliteRadarDashboard = ({ eliteMatches }) => {
  const [showPaywall, setShowPaywall] = useState(false);
  const [unlockKey, setUnlockKey] = useState(0);

  const handleUnlock = useCallback(() => {
    if (isVipUnlocked()) return;
    setShowPaywall(true);
  }, []);

  const handlePaywallClose = useCallback(() => {
    setShowPaywall(false);
    setUnlockKey(k => k + 1);
  }, []);

  const vipAvailable = isVipUnlocked();

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

  const vipCount = eliteMatches.filter(m => m._vip).length;
  const freeCount = eliteMatches.length - vipCount;

  return (
    <div className="elite-radar-container" key={unlockKey}>
      <div className="radar-header">
        <div className="brand">Laboratoire Hamdi — ⚡ TITANIUM NEURAL-X v3.5</div>
        <div className="status-badge">
          🟢 {eliteMatches.length} MATCHS {!vipAvailable && vipCount > 0 && `· ${vipCount} 🔒 VIP`}
        </div>
      </div>

      {!vipAvailable && vipCount > 0 && (
        <div className="vip-strip">
          <span>👑 {vipCount} pronostic{vipCount > 1 ? 's' : ''} VIP disponible{vipCount > 1 ? 's' : ''}</span>
          <button className="vip-unlock-btn" onClick={handleUnlock}>DÉBLOQUER</button>
        </div>
      )}

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
            const isVip = match._vip === true;
            const locked = isVip && !vipAvailable;

            const ouProb = parseFloat(match.ou_25_prob || enriched.ou_25_prob || 0);
            const ouLabel = ouProb > 0
              ? ouProb >= 50 ? '📈 O2.5' : '📉 U2.5'
              : hPct > 70 || aPct > 65 ? '📈 O2.5'
              : dPct > 35 || (hPct < 45 && aPct < 45) ? '📉 U2.5'
              : '';
            const ouPct = ouProb > 0 ? (ouProb >= 50 ? ouProb : 100 - ouProb).toFixed(0) : '';

            return (
              <tr key={match.id || idx} className={`${isSolid && !locked ? 'row-solid' : ''} ${isValueBet && !locked ? 'row-value' : ''} ${locked ? 'row-locked' : ''}`}>
                <td className="match-cell">
                  <span className="league-tag">[{match.league || match.tournament_name || match.competition || 'INT'}]</span>
                  <span className="teams-text">{match.homeTeam} vs {match.awayTeam}</span>
                </td>

                <td className="text-center">
                  {locked ? (
                    <span className="pick-badge locked" onClick={handleUnlock} style={{cursor: 'pointer'}}>
                      🔒 VIP
                    </span>
                  ) : (
                    <span className={`pick-badge ${isSolid ? 'solid' : isValueBet ? 'value-draw' : 'standard'}`}>
                      {quant.main_pick || match.pick || 'N/A'}
                    </span>
                  )}
                  {ouLabel && !locked && (
                    <span className={`ou-mini ${ouLabel.includes('O2.5') ? 'ou-over' : 'ou-under'}`}>
                      {ouLabel}{ouPct ? ` ${ouPct}%` : ''}
                    </span>
                  )}
                </td>

                <td className="text-center technical-text">
                  {locked ? (
                    <span className="locked-blur">—/—/—</span>
                  ) : (
                    <>
                      <span className="prob-h">{hPct}%</span>/
                      <span className="prob-d">{dPct}%</span>/
                      <span className="prob-a">{aPct}%</span>
                    </>
                  )}
                </td>

                <td className={`text-center technical-text ${locked ? '' : 'ev-highlight'}`}>
                  {locked ? <span className="locked-blur">EV=—</span> : `EV=${parseFloat(quant.ev_score || match.ev_score || 0).toFixed(2)}`}
                </td>

                <td className="text-center">
                  {locked ? (
                    <button className="vip-cell-unlock" onClick={handleUnlock}>🔓 DÉBLOQUER</button>
                  ) : isSolid ? (
                    <span className="signal-tag solid-signal">
                      ⚡ SOLID (BSM: {Math.round(match.base_solid_margin)}%)
                    </span>
                  ) : isValueBet ? (
                    <span className="signal-tag draw-signal">
                      🎯 VALUE BET (Draw Sniffer)
                    </span>
                  ) : (
                    <span className="signal-tag standard-signal">DYNAMIC</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {showPaywall && <VipPaywall onClose={handlePaywallClose} />}
    </div>
  );
};

export default EliteRadarDashboard;
