import React from 'react';
import './StrategicSections.css';

const StrategicSections = ({ matches }) => {
    const vaultMatches = matches.filter(m => {
        const audit = typeof m.integrity_audit === 'string' ? JSON.parse(m.integrity_audit) : (m.integrity_audit || {});
        return audit.strategicTags?.includes('CERTAINTY_VAULT');
    });

    const multiplierMatches = matches.filter(m => {
        const audit = typeof m.integrity_audit === 'string' ? JSON.parse(m.integrity_audit) : (m.integrity_audit || {});
        return audit.strategicTags?.includes('GOLDEN_MULTIPLIER');
    });

    if (vaultMatches.length === 0 && multiplierMatches.length === 0) return null;

    return (
        <div className="strategic-container">
            {vaultMatches.length > 0 && (
                <div className="strategic-section vault">
                    <div className="strategic-header">
                        <span className="strat-icon">🛡️</span>
                        <h3>THE CERTAINTY VAULT (الخزنة الآمنة)</h3>
                        <span className="strat-badge">Ultra-Safe &gt; 90%</span>
                    </div>
                    <div className="strat-list">
                        {vaultMatches.map(m => {
                            const audit = typeof m.integrity_audit === 'string' ? JSON.parse(m.integrity_audit) : (m.integrity_audit || {});
                            const odds = JSON.parse(m.market_odds || '{}');
                            return (
                                <div key={m.id} className="strat-item">
                                    <div className="strat-match-info">
                                        <span className="strat-teams">{m.homeTeam} vs {m.awayTeam}</span>
                                        <span className="strat-reason">{m.prediction_logic || 'AI Precision + News Hit'}</span>
                                    </div>
                                    <div className="strat-metrics">
                                        <div className="strat-metric">
                                            <span className="label">PICK</span>
                                            <span className="val win-color">Home Win</span>
                                        </div>
                                        <div className="strat-metric">
                                            <span className="label">ODDS</span>
                                            <span className="val">{odds.home || '-'}</span>
                                        </div>
                                        <div className="strat-metric">
                                            <span className="label">REF. CONF</span>
                                            <span className="val emerald-text">{m.home_win_probability}%</span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {vaultMatches.length >= 2 && (() => {
                        const totalOdds = vaultMatches.reduce((acc, m) => {
                            const odds = JSON.parse(m.market_odds || '{}');
                            return acc * (parseFloat(odds.home) || 1);
                        }, 1).toFixed(2);

                        const jointProb = (vaultMatches.reduce((acc, m) => {
                            return acc * (parseFloat(m.home_win_probability) / 100 || 1);
                        }, 1) * 100).toFixed(1);

                        return (
                            <div className="vault-combo-card">
                                <div className="combo-left">
                                    <span className="combo-title">🛡️ SAFETY COMBO (تجميعة الأمان)</span>
                                    <span className="combo-desc">{vaultMatches.length} Matches Mixed Accumulator</span>
                                </div>
                                <div className="combo-right">
                                    <div className="combo-stat">
                                        <span className="label">TOTAL ODDS</span>
                                        <span className="val gold-text">x{totalOdds}</span>
                                    </div>
                                    <div className="combo-stat">
                                        <span className="label">JOINT SAFETY</span>
                                        <span className="val emerald-text">{jointProb}%</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}
                </div>
            )}

            {multiplierMatches.length > 0 && (
                <div className="strategic-section multiplier">
                    <div className="strategic-header">
                        <span className="strat-icon">🚀</span>
                        <h3>THE GOLDEN MULTIPLIER (المضاعف الذهبي)</h3>
                        <span className="strat-badge">Pro Value Edge &gt; 20%</span>
                    </div>
                    <div className="strat-list">
                        {multiplierMatches.map(m => {
                            const audit = typeof m.integrity_audit === 'string' ? JSON.parse(m.integrity_audit) : (m.integrity_audit || {});
                            const odds = JSON.parse(m.market_odds || '{}');
                            return (
                                <div key={m.id} className="strat-item">
                                    <div className="strat-match-info">
                                        <span className="strat-teams">{m.homeTeam} vs {m.awayTeam}</span>
                                        <span className="strat-reason">{m.prediction_logic || 'Inside Edge: Mispriced Underdog'}</span>
                                    </div>
                                    <div className="strat-metrics">
                                        <div className="strat-metric">
                                            <span className="label">ODDS (B365)</span>
                                            <span className="val gold-text">{odds.home || '-'}</span>
                                        </div>
                                        <div className="strat-metric">
                                            <span className="label">FAIR PRICE</span>
                                            <span className="val">{audit.fairPrice || '-'}</span>
                                        </div>
                                        <div className="strat-metric">
                                            <span className="label">EDGE %</span>
                                            <span className="val pulse-text">+{Math.round(audit.edge * 100)}%</span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default StrategicSections;
