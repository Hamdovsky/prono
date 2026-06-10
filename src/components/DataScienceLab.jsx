import React, { useState, useMemo, useEffect } from 'react';
import './DataScienceLab.css';

const FEATURE_COLORS = ['#38bdf8', '#f472b6', '#fbbf24', '#4ade80', '#a78bfa', '#fb923c', '#818cf8', '#f87171', '#34d399', '#e879f9']

const DataScienceLab = ({ matches = [] }) => {
    const [selectedLeague, setSelectedLeague] = useState('ALL');
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        fetch('/api/ds/performance')
            .then(r => r.json())
            .then(d => { if (!cancelled) setData(d); setLoading(false) })
            .catch(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [])

    const leagues = useMemo(() => {
        const set = new Set(matches.map(m => m.league).filter(Boolean));
        return ['ALL', ...Array.from(set)];
    }, [matches]);

    const stats = useMemo(() => {
        const filtered = selectedLeague === 'ALL' ? matches : matches.filter(m => m.league === selectedLeague);
        const total = filtered.length;
        const sharp = filtered.filter(m => (m.sharp_score || 0) > 50).length;
        const highConf = filtered.filter(m => (m.xgboost_confidence || 0) > 0.85).length;
        
        return { total, sharp, highConf };
    }, [matches, selectedLeague]);

    const modelPerformance = data?.models || []
    const globalFeatures = data?.models?.[0]?.featureImportance?.length
        ? data.models[0].featureImportance
        : [
            { feature: 'Attacking Momentum (DA)', importance: 0.24, color: '#38bdf8' },
            { feature: 'Defensive Pressure', importance: 0.18, color: '#f472b6' },
            { feature: 'Market Sharp Ratio', importance: 0.15, color: '#fbbf24' },
            { feature: 'News Sentiment', importance: 0.12, color: '#4ade80' },
            { feature: 'ELO Differential', importance: 0.09, color: '#a78bfa' }
        ]
    const overall = data?.overallAccuracy

    return (
        <div className="ds-lab">
            <header className="ds-header">
                <div className="ds-title">
                    <span className="ds-icon">🧬</span>
                    <h1>Data Science Lab <small>v22.0</small></h1>
                </div>
                <div className="ds-filters">
                    <select value={selectedLeague} onChange={(e) => setSelectedLeague(e.target.value)}>
                        {leagues.map(l => <option key={l} value={l}>{l === 'ALL' ? 'Toutes les Ligues' : l}</option>)}
                    </select>
                </div>
            </header>

            <div className="ds-grid">
                {/* 1. Model Performance Dashboard */}
                <section className="ds-card perf-card">
                    <h2>Performance des Modèles</h2>
                    <div className="model-list">
                        {modelPerformance.map((m, i) => (
                            <div key={i} className="model-item">
                                <div className="model-info">
                                    <span className="model-name">{m.name}</span>
                                    <span className={`model-status ${m.status.toLowerCase()}`}>{m.status}</span>
                                </div>
                                <div className="model-metrics">
                                    <div className="metric">
                                        <span className="m-label">Précision</span>
                                        <span className="m-val">{m.accuracy}%</span>
                                    </div>
                                    <div className="metric">
                                        <span className="m-label">Score AUC</span>
                                        <span className="m-val">{m.auc}</span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 2. Feature Importance Explainability */}
                <section className="ds-card explain-card">
                    <h2>Importance des Variables (Modèle Global)</h2>
                    <div className="feature-chart">
                        {globalFeatures.map((f, i) => (
                            <div key={i} className="feature-row">
                                <span className="f-name">{f.feature}</span>
                                <div className="f-bar-container">
                                    <div className="f-bar" style={{ width: `${f.importance * 100 * 3}%`, backgroundColor: f.color }}></div>
                                    <span className="f-val">{(f.importance * 100).toFixed(1)}%</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 3. Overall Accuracy Dashboard */}
                <section className="ds-card backtest-card">
                    <h2>Performance Globale</h2>
                    {loading ? (
                        <div style={{padding:'20px', textAlign:'center', color:'#64748b', fontSize:'12px'}}>Chargement...</div>
                    ) : overall ? (
                        <>
                            <div className="ds-stats-row">
                                <div className="ds-stat">
                                    <span className="ds-stat-val">{overall.last7Days != null ? `${overall.last7Days}%` : 'N/A'}</span>
                                    <span className="ds-stat-label">Précision 7 jours</span>
                                </div>
                                <div className="ds-stat highlight">
                                    <span className="ds-stat-val">{overall.last30Days != null ? `${overall.last30Days}%` : 'N/A'}</span>
                                    <span className="ds-stat-label">Précision 30 jours</span>
                                </div>
                                <div className="ds-stat">
                                    <span className="ds-stat-val">{overall.cumulativeRoi ?? 0}%</span>
                                    <span className="ds-stat-label">ROI Cumulé</span>
                                </div>
                            </div>
                            <div className="ds-stats-row" style={{marginTop:'8px'}}>
                                {Object.entries(overall.byMarket || {}).map(([key, m]) => (
                                    <div key={key} className="ds-stat" style={{flex:1}}>
                                        <span className="ds-stat-val" style={{fontSize:'16px'}}>{m.accuracy != null ? `${m.accuracy}%` : 'N/A'}</span>
                                        <span className="ds-stat-label">{key === '1x2' ? '1X2' : key === 'ou25' ? 'O/U 2.5' : 'BTTS'} ({m.total} matchs)</span>
                                    </div>
                                ))}
                            </div>
                            {overall.currentStreak > 0 && (
                                <div className="ds-insight">
                                    <p><strong>🔥 Série en cours:</strong> {overall.currentStreak} prédictions correctes consécutives (Record: {overall.recordStreak})</p>
                                </div>
                            )}
                        </>
                    ) : (
                        <div style={{padding:'20px', textAlign:'center', color:'#64748b', fontSize:'12px'}}>Aucune donnée de performance disponible.</div>
                    )}
                </section>
            </div>
        </div>
    );
};

export default DataScienceLab;
