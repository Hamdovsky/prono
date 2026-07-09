import React, { useState } from 'react';
import './GridGenerator.css';

function computeGrid(matches) {
  return matches.map((m, idx) => {
    const enriched = m.enriched || {};
    const quant = m.quant || enriched.quant || {};
    const hPct = parseFloat(m.home_win_probability || enriched.home_win_probability || 0);
    const dPct = parseFloat(m.draw_probability || enriched.draw_probability || 0);
    const aPct = parseFloat(m.away_win_probability || enriched.away_win_probability || 0);

    const pick = (quant.main_pick || m.main_pick || m.pick || '').toString().trim().toUpperCase();

    let col1 = pick;
    if (pick === '1X' || pick === 'X2' || pick === '12') {
      col1 = pick;
    } else if (!pick || pick === 'N/A') {
      const maxPct = Math.max(hPct, dPct, aPct);
      col1 = maxPct === hPct ? '1' : maxPct === aPct ? '2' : 'X';
    }

    const picks = [hPct, dPct, aPct];
    const sortedIdx = [0, 1, 2].sort((a, b) => picks[b] - picks[a]);
    const labels = ['1', 'X', '2'];

    const col2 = (() => {
      if (picks[sortedIdx[0]] >= 70) return null;
      const coverage = sortedIdx[1];
      const primary = sortedIdx[0];
      return labels[Math.min(primary, coverage)] + labels[Math.max(primary, coverage)];
    })();

    const col3 = (() => {
      if (picks[sortedIdx[0]] >= 55) return null;
      const coverage = sortedIdx[2];
      const primary = sortedIdx[0];
      return labels[Math.min(primary, coverage)] + labels[Math.max(primary, coverage)];
    })();

    return {
      num: idx + 1,
      home: m.homeTeam,
      away: m.awayTeam,
      league: m.league || m.tournament_name || '',
      col1,
      col2,
      col3,
      probs: `${Math.round(hPct)}/${Math.round(dPct)}/${Math.round(aPct)}`,
      ev: parseFloat(quant.ev_score || m.ev_score || 0).toFixed(2)
    };
  });
}

function computeCost(grid) {
  const cols = [1, 0, 0]; // col1 always active
  grid.forEach(g => {
    if (g.col2) cols[1]++;
    if (g.col3) cols[2]++;
  });
  const combos = (1 << cols[0]) * (1 << cols[1]) * (1 << cols[2]);
  return Math.max(1, combos);
}

const GridGenerator = ({ eliteMatches }) => {
  const [showGrid, setShowGrid] = useState(false);

  if (!eliteMatches || eliteMatches.length === 0) return null;

  const grid = computeGrid(eliteMatches);
  const cost = computeCost(grid);

  return (
    <div className="grid-generator-container">
      <button
        className="grid-generator-btn"
        onClick={() => setShowGrid(s => !s)}
      >
        {showGrid ? '✕ CACHER' : '🎰 GÉNÉRER TICKET PROMOSPORT'}
      </button>

      {showGrid && (
        <div className="grid-panel">
          <div className="grid-header-info">
            <span className="grid-title">📋 GRILLE PROMOSPORT — TITANIUM NEURAL-X</span>
            <span className="grid-meta">{grid.length} MATCHS · {cost} COMBINAISONS</span>
            <button className="grid-print-btn" onClick={() => window.print()}>🖨️ IMPRIMER</button>
          </div>

          <table className="grid-table">
            <thead>
              <tr>
                <th>#</th>
                <th>MATCH</th>
                <th>LEAGUE</th>
                <th className="text-center">PROBS</th>
                <th className="text-center col-primary">COL 1</th>
                <th className="text-center col-cover">COL 2</th>
                <th className="text-center col-cover">COL 3</th>
                <th className="text-center">EV</th>
              </tr>
            </thead>
            <tbody>
              {grid.map(g => (
                <tr key={g.num}>
                  <td className="text-center grid-num">{g.num}</td>
                  <td className="grid-teams">{g.home} vs {g.away}</td>
                  <td className="grid-league">{g.league}</td>
                  <td className="text-center grid-probs">{g.probs}</td>
                  <td className="text-center grid-pick-primary">{g.col1}</td>
                  <td className="text-center grid-pick-cover">{g.col2 || '—'}</td>
                  <td className="text-center grid-pick-cover">{g.col3 || '—'}</td>
                  <td className="text-center grid-ev">EV {g.ev}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="grid-legend">
            <span><strong>COL 1</strong> — Pick principal (base de la grille)</span>
            {grid.some(g => g.col2) && <span><strong>COL 2</strong> — Couverture double chance (&gt;70% sécurité)</span>}
            {grid.some(g => g.col3) && <span><strong>COL 3</strong> — Couverture secondaire (&gt;55% sécurité)</span>}
          </div>
        </div>
      )}
    </div>
  );
};

export default GridGenerator;
