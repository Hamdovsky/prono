import React, { useState, useMemo } from 'react';
import './GridGenerator.css';

const GridGenerator = ({ eliteMatches }) => {
  const [showGrid, setShowGrid] = useState(false);

  const promosportMatches = useMemo(() => {
    if (!eliteMatches || eliteMatches.length === 0) return [];
    return eliteMatches.slice(0, 13);
  }, [eliteMatches]);

  const goldenData = useMemo(() => {
    if (promosportMatches.length === 0) return [];
    let dcUsed = 0;
    return promosportMatches.map((m) => {
      const quant = m.quant || {};
      const hProb = parseFloat(m.home_win_probability || 0);
      const dProb = parseFloat(m.draw_probability || 0);
      const aProb = parseFloat(m.away_win_probability || 0);
      const standardPick = quant.main_pick || m.main_pick || m.pick || '—';
      const dvb = m.draw_value_bet === true || m.draw_value_bet === 'True' || m.draw_value_bet === 1;

      let golden = { pick: standardPick, type: '⚡ BASE', prob: 0 };

      if (dvb) {
        if (dcUsed < 6) {
          if (hProb > aProb && hProb - dProb < 25) {
            golden = { pick: '1X', type: '🔥 PIÈGE (Double)', prob: Math.round(hProb + dProb) };
          } else if (aProb > hProb && aProb - dProb < 25) {
            golden = { pick: 'X2', type: '🔥 PIÈGE (Double)', prob: Math.round(dProb + aProb) };
          } else {
            golden = { pick: 'X', type: '💣 SURPRISE', prob: Math.round(dProb) };
          }
          dcUsed++;
        } else {
          golden = { pick: standardPick, type: '⚠️ RISQUE', prob: Math.round(hProb > aProb ? hProb : aProb) };
        }
      } else if (hProb > 65 && dcUsed < 6) {
        golden = { pick: '1X', type: '🛡️ COUVERTURE', prob: Math.round(hProb + dProb) };
        dcUsed++;
      } else if (aProb > 60 && dcUsed < 6) {
        golden = { pick: 'X2', type: '🛡️ COUVERTURE', prob: Math.round(dProb + aProb) };
        dcUsed++;
      } else {
        golden = { pick: standardPick, type: '⚡ BASE', prob: Math.round(hProb > aProb ? hProb : aProb) };
      }

      return { m, standardPick, golden, hProb, dProb, aProb, dvb, bsm };
    });
  }, [promosportMatches]);

  const dcCount = goldenData.filter(g => g.golden.pick.length > 1).length;

  if (!eliteMatches || eliteMatches.length === 0) return null;

  return (
    <div className="grid-generator-container">
      <button
        className="grid-generator-btn"
        onClick={() => setShowGrid(s => !s)}
      >
        {showGrid ? '✕ CACHER' : '🎰 GRILLE PROMOSPORT TUNISIE — COLONNE D\'OR'}
      </button>

      {showGrid && (
        <div className="promosport-container">
          <div className="promosport-header">
            <span className="promosport-title">🎰 GRILLE PROMOSPORT TUNISIE — ⚡ TITANIUM SELECTION</span>
            <span className="golden-badge">🏆 LA COLONNE D'OR ACTIVÉE ({dcCount} DOUBLES CHANCES INJECTÉS)</span>
            <button className="btn-print" onClick={() => window.print()}>🖨️ IMPRIMER</button>
          </div>

          <table className="promosport-table">
            <thead>
              <tr>
                <th className="text-center">N°</th>
                <th>🏆 MATCHS DU CONCOURS</th>
                <th className="text-center">BASE STANDARD</th>
                <th className="text-center golden-header">✨ LA COLONNE D'OR (13/13)</th>
                <th className="text-center">ℹ️ NATURE</th>
              </tr>
            </thead>
            <tbody>
              {goldenData.map((g, idx) => {
                const isDouble = g.golden.pick.length > 1;
                const isSurprise = g.golden.type.includes('SURPRISE');
                const isTrapp = g.golden.type.includes('PIÈGE');
                const isCover = g.golden.type.includes('COUVERTURE');
                return (
                  <tr key={idx} className={isTrapp || isSurprise ? 'row-trap' : isCover ? 'row-cover' : ''}>
                    <td className="text-center match-num">{idx + 1}</td>
                    <td className="match-names">
                      <span className="match-league">[{g.m.league || g.m.tournament_name || 'INT'}]</span>
                      {' '}{g.m.homeTeam} vs {g.m.awayTeam}
                    </td>
                    <td className="text-center standard-pick">{g.standardPick}</td>
                    <td className="text-center golden-cell">
                      <span className={`golden-badge-pick ${isDouble ? 'double-gold' : 'single-gold'}`}>
                        {g.golden.pick}
                        {g.golden.prob > 0 && <span className="golden-prob"> {g.golden.prob}%</span>}
                      </span>
                    </td>
                    <td className="text-center text-nature">
                      <span className={`nature-tag ${isTrapp ? 'tag-piege' : isSurprise ? 'tag-surprise' : isCover ? 'tag-cover' : 'tag-base'}`}>
                        {g.golden.type}
                        {g.golden.prob > 0 && <span className="nature-prob"> — {g.golden.prob}%</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="promosport-footer">
            <span>📊 Système Combinatoire: <b>{dcCount} Doubles</b> = <b>{Math.pow(2, dcCount)}</b> Colonnes Équivalentes Simple.</span>
            <button className="btn-print" onClick={() => window.print()}>🖨️ IMPRIMER LA COLONNE D'OR</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GridGenerator;
