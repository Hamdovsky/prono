import React, { useState, useEffect } from 'react';
import MarketSensors from './MarketSensors';
import './EvolutionDashboard.css';

const EvolutionDashboard = () => {
    const [intelligence, setIntelligence] = useState(null);
    const [metrics, setMetrics] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [intelRes, perfRes] = await Promise.all([
                    fetch('/api/evolution/intelligence').then(r => r.json()),
                    fetch('/api/evolution/performance-metrics').then(r => r.json())
                ]);

                if (intelRes.success) setIntelligence(intelRes);
                if (perfRes.success) setMetrics(perfRes.metrics);
            } catch (error) {
                console.error('Error fetching evolution data:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    if (loading) return <div className="evolution-loading">Initialisation du Calque d'Évolution...</div>;

    return (
        <div className="evolution-container">
            <header className="evolution-header">
                <h1>🧬 TITANIUM EVOLUTION LAYER</h1>
                <p>Adaptive Quantitative Intelligence & Failure Analysis</p>
            </header>

            <div className="evolution-grid">
                {/* 1. TOP FAILURE REASONS */}
                <section className="evolution-card failure-card">
                    <h3>🔍 TAXONOMIE DES ÉCHECS (GLOBAL)</h3>
                    <div className="failure-list">
                        {intelligence?.topFailures?.map((f, i) => (
                            <div key={i} className="failure-item">
                                <span className="failure-type">{f.failure_type.replace(/_/g, ' ')}</span>
                                <div className="failure-bar-container">
                                    <div 
                                        className="failure-bar" 
                                        style={{ width: `${(f.total / intelligence.topFailures[0].total) * 100}%` }}
                                    ></div>
                                </div>
                                <span className="failure-count">{f.total}</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 2. LEAGUE HEATMAP (CLV vs CONFIDENCE) */}
                <section className="evolution-card metrics-card">
                    <h3>🏆 PERFORMANCE COMPARATIVE (LIGUES)</h3>
                    <div className="metrics-table-wrapper">
                        <table className="metrics-table">
                            <thead>
                                <tr>
                                    <th>LIGUE</th>
                                    <th>MATCHS</th>
                                    <th>AVG CLV</th>
                                    <th>STABILITÉ</th>
                                </tr>
                            </thead>
                            <tbody>
                                {metrics.map((m, i) => (
                                    <tr key={i}>
                                        <td className="league-name">{m.league}</td>
                                        <td>{m.total_matches}</td>
                                        <td className={m.avg_clv > 0 ? 'text-green' : 'text-red'}>
                                            {(m.avg_clv * 100).toFixed(2)}%
                                        </td>
                                        <td>
                                            <div className="stability-indicator">
                                                <div 
                                                    className="stability-fill" 
                                                    style={{ 
                                                        width: `${m.avg_confidence}%`,
                                                        background: m.avg_confidence > 80 ? '#10b981' : m.avg_confidence > 65 ? '#f59e0b' : '#ef4444'
                                                    }}
                                                ></div>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* 3. LEARNING PROGRESS */}
                <section className="evolution-card learning-card">
                    <h3>🧠 ÉTAT DE L'APPRENTISSAGE</h3>
                    <div className="learning-stats">
                        <div className="stat-box">
                            <span className="stat-label">Patterns Détectés</span>
                            <span className="stat-value">{intelligence?.leaguePatterns?.length || (loading ? '...' : 'SCANNING')}</span>
                        </div>
                        <div className="stat-box">
                            <span className="stat-label">Index de Calibration</span>
                            <span className="stat-value">98.4%</span>
                        </div>
                        <div className="stat-box">
                            <span className="stat-label">Poids Synaptiques</span>
                            <span className="stat-value">14,202</span>
                        </div>
                    </div>
                </section>
                {/* 4. MARKET SENSORS */}
                <section className="evolution-card sensor-section">
                    <MarketSensors />
                </section>
            </div>
        </div>
    );
};

export default EvolutionDashboard;
