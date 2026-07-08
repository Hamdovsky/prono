import React from 'react';
import './MatchCard.css';

const MatchCard = ({ rawData, style }) => {
  const parseRow = (lines) => {
    if (!lines || lines.length === 0) return null;
    const league = lines[0] || '';
    const home = lines[1] || '';
    const away = lines[2] || '';
    const edgeLine = lines.find(l => l.startsWith('🎯')) || '';
    const edgeVal = edgeLine.replace('🎯', '').replace('%', '').trim();
    const pcts = lines.filter(l => l.includes('%') && !l.startsWith('🎯') && !l.startsWith('⚠️'));
    const ouPct = pcts[1] || '0%';
    const evLine = lines.find(l => l.startsWith('EV')) || 'EV 0.00';
    const evVal = evLine.replace('EV', '').trim();
    const pickLine = lines.find(l => l.startsWith('1X2:')) || '1X2: X';
    const pick = pickLine.replace('1X2:', '').trim();
    return { league, home, away, edgeVal, ouPct, evVal, pick };
  };

  const d = parseRow(rawData);
  if (!d) return null;

  const shortTeam = (name) => {
    if (!name) return '';
    const parts = name.split(' ');
    if (parts.length <= 2) return name;
    return parts.map((w, i) => i === 0 ? w : w[0] + '.').join(' ');
  };

  const label = `${shortTeam(d.home)} vs ${shortTeam(d.away)} [${d.league}]`;
  const ouNum = parseFloat(d.ouPct) || 0;
  const dir = ouNum > 50 ? 'OVER' : 'UNDER';
  const prec = Math.round(ouNum > 50 ? ouNum : 100 - ouNum);
  const evNum = parseFloat(d.evVal) || 0;
  const evClass = evNum >= 0.45 ? 'compact-ev-high' : evNum >= 0.40 ? 'compact-ev-med' : 'compact-ev-low';
  const pickClass = `compact-pick-${d.pick}`;

  return (
    <div className="compact-row" style={style}>
      <div className="compact-col-match">{label}</div>
      <div className={`compact-col-pick ${pickClass}`}>{d.pick} {d.edgeVal}%</div>
      <div className={`compact-col-ou compact-ou-${dir.toLowerCase()}`}>{dir} 2.5 ({prec}%)</div>
      <div className={`compact-col-ev ${evClass}`}>{d.evVal}</div>
    </div>
  );
};

export default MatchCard;
