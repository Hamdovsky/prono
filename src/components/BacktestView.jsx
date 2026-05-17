import React, { useState, useEffect } from 'react';
import dataService from '../services/dataService';
import './BacktestView.css';

const BacktestView = () => {
    const [strategy, setStrategy] = useState('Balanced');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);

    const runBacktest = async () => {
        setLoading(true);
        try {
            const data = await dataService.runBacktest(strategy);
            if (data) {
                setResults(data);
            }
        } catch (error) {
            console.error('Backtest failed:', error);
        }
        setLoading(false);
    };

    useEffect(() => {
        runBacktest();
    }, [strategy]);

    return (
        <div className="backtest-container">
            <header className="lab-header">
                <span className="badge-blue">PERFORMANCE LAB</span>
                <h1 className="lab-title">Tactical Backtest Engine</h1>
            </header>

            <div className="strategy-selector-lab">
                {['Safe', 'Balanced', 'Aggressive'].map(s => (
                    <button
                        key={s}
                        className={`lab-strat-btn ${strategy === s ? 'active' : ''}`}
                        onClick={() => setStrategy(s)}
                    >
                        {s}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="lab-loading">
                    <div className="spinner-lab"></div>
                    <p>Analyzing winning patterns...</p>
                </div>
            ) : results && (
                <div className="backtest-results-grid">
                    <ResultCard label="Win Rate" value={results.winRate} icon="verified" color="#00ff88" />
                    <ResultCard label="Projected ROI" value={results.projectedROI} icon="trending_up" color="#0d93f2" />
                    <ResultCard label="Qualified Targets" value={results.qualifiedTargets} icon="target" color="#ffd700" />
                    <ResultCard label="Samples Analyzed" value={results.totalSamples} icon="database" color="#ff4d4d" />
                </div>
            )}

            <div className="lab-system-status">
                <div className={`status-tag ${results?.status}`}>{results?.status || 'IDLE'}</div>
                <p className="lab-desc">Validated against `data/patterns.json`. Calculations assume 1.9 average live odds.</p>
            </div>
        </div>
    );
};

const ResultCard = ({ label, value, icon, color }) => (
    <div className="result-card-lab" style={{ '--accent-lab': color }}>
        <div className="lab-card-top">
            <span className="material-symbols-outlined">{icon}</span>
            <span className="lab-label">{label}</span>
        </div>
        <div className="lab-value">{value}</div>
    </div>
);

export default BacktestView;
