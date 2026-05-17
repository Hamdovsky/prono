import React, { useState, useEffect } from 'react';
import './MarketSensors.css';

const MarketSensors = () => {
    const [signals, setSignals] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchSignals = async () => {
            try {
                const response = await fetch('/api/evolution/sensors?days=2');
                const data = await response.json();
                if (data.success) {
                    setSignals(data.signals);
                }
            } catch (error) {
                console.error('Error fetching market signals:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchSignals();
        const interval = setInterval(fetchSignals, 5 * 60 * 1000); // Refresh every 5m
        return () => clearInterval(interval);
    }, []);

    if (loading) return <div className="sensor-loading">Scanning Global Markets...</div>;

    return (
        <div className="sensors-container">
            <header className="sensors-header">
                <h3>📊 GLOBAL MARKET SENSORS</h3>
                <span className="live-badge">LIVE MONITOR</span>
            </header>

            {signals.length === 0 ? (
                <div className="no-signals">No significant anomalies detected in the last 48h.</div>
            ) : (
                <div className="signals-list">
                    {signals.map((s, i) => (
                        <div key={i} className={`signal-card ${s.type.toLowerCase()}`}>
                            <div className="signal-badge">{s.type}</div>
                            <div className="signal-main">
                                <div className="signal-match">
                                    <span className="teams">{s.homeTeam} vs {s.awayTeam}</span>
                                    <span className="league">{s.league}</span>
                                </div>
                                <div className="signal-desc">{s.description}</div>
                            </div>
                            <div className="signal-meta">
                                <div className="severity">
                                    <span className="label">Impact</span>
                                    <span className="value">{s.severity.toFixed(1)}%</span>
                                </div>
                                <div className="odds-strip">
                                    <span>{s.odds.h}</span>
                                    <span>{s.odds.d}</span>
                                    <span>{s.odds.a}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default MarketSensors;
