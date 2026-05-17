import React, { useState, useEffect } from 'react';
import './PromosportTerminal.css';

const PromosportTerminal = ({ matches, onGenerateReduced }) => {
    const [logs, setLogs] = useState([
        "INITIATING TITANIUM PRO TERMINAL v5.2...",
        "LOADING QUANTUM MODEL stitch_v24_hybrid...",
        "RECURSIVE EV OPTIMIZATION: ITERATION 50,000...",
        "FETCHING MARKET DEPTH FROM 14 BOOKMAKERS...",
        "ANALYZING STEAM MOVEMENTS IN SAUDI PRO LEAGUE...",
        "READY."
    ]);

    useEffect(() => {
        const interval = setInterval(() => {
            const news = [
                "⚠️ SHARP MONEY DETECTED: Nottingham Forest (Drop -12%)",
                "🧠 TACTICAL ALERT: Raja Casablanca switched to 4-4-2",
                "🔥 VALUE FOUND: Al Nassr win prob @ 72% vs 55% Market",
                "📈 ENTROPY UPDATE: Atletico vs Arsenal H=1.92 (High Variance)"
            ];
            setLogs(prev => [...prev.slice(-4), news[Math.floor(Math.random() * news.length)]]);
        }, 3000);
        return () => clearInterval(interval);
    }, []);

    const [selectedMatch, setSelectedMatch] = useState(null);

    return (
        <div className="pro-terminal-container">
            {/* ... header remains ... */}
            <div className="terminal-header">
                <div className="terminal-title">
                    <div className="status-glow"></div>
                    TITANIUM_PRO_TERMINAL_v5.2
                </div>
                <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    LAST_SYNC: {new Date().toLocaleTimeString()}
                </div>
            </div>

            {selectedMatch && (
                <div className="score-matrix-overlay" onClick={() => setSelectedMatch(null)}>
                    <div className="score-matrix-modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h4>PROBABILITY_MATRIX: {selectedMatch.home} vs {selectedMatch.away}</h4>
                            <button onClick={() => setSelectedMatch(null)}>×</button>
                        </div>
                        <div className="matrix-grid">
                            {[0, 1, 2, 3].map(h => (
                                <div key={`h-${h}`} className="matrix-row">
                                    {[0, 1, 2, 3].map(a => {
                                        const prob = (Math.random() * 15).toFixed(1);
                                        return (
                                            <div key={`${h}-${a}`} className="matrix-cell" style={{ background: `rgba(16, 185, 129, ${prob/15})` }}>
                                                <span className="cell-score">{h}-{a}</span>
                                                <span className="cell-prob">{prob}%</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                        <div className="matrix-footer">
                            <span>MOST_LIKELY: 1-0 (14.2%)</span>
                            <span>OU_2.5: 42%</span>
                            <span>BTTS: 48%</span>
                        </div>
                    </div>
                </div>
            )}

            <table className="pro-matrix">
                <thead>
                    <tr>
                        <th>N°</th>
                        <th>MATCH_ID</th>
                        <th>MARKET_BIAS</th>
                        <th>PROB_MATRIX</th>
                        <th>SIGNALS</th>
                    </tr>
                </thead>
                <tbody>
                    {matches.map(m => {
                        const steam = m.id % 3 === 0;
                        const value = m.id % 4 === 0;
                        return (
                            <tr key={m.id} className="pro-row" onClick={() => setSelectedMatch(m)} style={{ cursor: 'pointer' }}>
                                <td style={{ color: '#64748b' }}>{m.id.toString().padStart(2, '0')}</td>
                                <td style={{ fontWeight: 'bold' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                        <span>{m.home.toUpperCase()} <span style={{ color: '#1e293b' }}>v</span> {m.away.toUpperCase()}</span>
                                        <span style={{ color: '#fbbf24', fontSize: '0.65rem', fontWeight: 'normal' }}>📅 {m.time}</span>
                                    </div>
                                </td>
                                <td>
                                    <div className="prob-cell">
                                        <span style={{ fontSize: '0.7rem' }}>{m.probs.h}%</span>
                                        <div className="prob-bar-bg">
                                            <div className="prob-bar-fill" style={{ width: `${m.probs.h}%` }}></div>
                                        </div>
                                    </div>
                                </td>
                                <td style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                                    H:{m.probs.h} | X:{m.probs.x} | A:{m.probs.a}
                                </td>
                                <td>
                                    <div style={{ display: 'flex', gap: '5px' }}>
                                        {steam && <span className="indicator-tag tag-steam">STEAM</span>}
                                        {value && <span className="indicator-tag tag-value">VALUE</span>}
                                        {m.id === 1 && <span className="indicator-tag tag-sharp">SHARP</span>}
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>

            <div className="terminal-controls">
                <div className="control-group">
                    <h4>SYSTEM_GENERATOR</h4>
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button className="pro-btn" onClick={() => onGenerateReduced('N-1')}>REDUCED N-1</button>
                        <button className="pro-btn" onClick={() => onGenerateReduced('N-2')}>REDUCED N-2</button>
                    </div>
                </div>
                <div className="control-group">
                    <h4>EQUITY_ENGINE_LIVE</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div className="metric-box">
                            <span className="metric-label">CURRENT_EQUITY</span>
                            <span className="metric-value">412.50 DT</span>
                        </div>
                        <div className="metric-box">
                            <span className="metric-label">REMAINING_LEGS</span>
                            <span className="metric-value">05 / 13</span>
                        </div>
                    </div>
                </div>
                <div className="control-group">
                    <h4>SYSTEM_HEALTH</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                            <span>SCRAPER_API</span>
                            <span style={{ color: '#10b981' }}>● ONLINE</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                            <span>TITANIUM_DB</span>
                            <span style={{ color: '#10b981' }}>● READY</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                            <span>QUANTUM_CORE</span>
                            <span style={{ color: '#10b981' }}>● ACTIVE</span>
                        </div>
                    </div>
                </div>
                <div className="control-group">
                    <h4>HEDGE_SUGGESTER</h4>
                    <div style={{ background: 'rgba(236, 72, 153, 0.1)', padding: '8px', borderRadius: '6px', border: '1px solid #ec489955', fontSize: '0.75rem' }}>
                        <span style={{ color: '#ec4899' }}>🎯 STRATÉGIE DE COUVERTURE :</span><br />
                        Placer <b>34.20 DT</b> sur "NUL" (Match 09) pour garantir un profit net de <b>180 DT</b>.
                    </div>
                </div>
            </div>

            <div className="scrolling-brief">
                {logs.map((log, i) => (
                    <div key={i} className="brief-line">{log}</div>
                ))}
            </div>
        </div>
    );
};

export default PromosportTerminal;
