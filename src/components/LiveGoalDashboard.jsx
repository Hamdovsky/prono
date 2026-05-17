import React, { useState, useEffect, useCallback } from "react";
import "./LiveGoalDashboard.css";

const LiveGoalDashboard = () => {
    const [liveMatches, setLiveMatches] = useState([]);
    const [selectedMatch, setSelectedMatch] = useState(null);
    const [lastUpdate, setLastUpdate] = useState(Date.now());
    const [autoRefresh, setAutoRefresh] = useState(true);

    const fetchLiveData = useCallback(async () => {
        try {
            const response = await fetch('/api/live/goal-predictions');
            const data = await response.json();
            if (data && Array.isArray(data)) {
                setLiveMatches(data);
                setLastUpdate(Date.now());
            }
        } catch (e) {
            console.error('[LIVE DASHBOARD] Fetch error:', e);
        }
    }, []);

    useEffect(() => {
        fetchLiveData();
        if (autoRefresh) {
            const interval = setInterval(fetchLiveData, 10000);
            return () => clearInterval(interval);
        }
    }, [autoRefresh, fetchLiveData]);

    const getAlertColor = (level) => {
        const colors = {
            'IMMINENT': '#ff0044',
            'CRITICAL': '#ff4400',
            'HIGH': '#ff8800',
            'NORMAL': '#00aaff'
        };
        return colors[level] || '#666';
    };

    const getAlertBadge = (level) => {
        const badges = {
            'IMMINENT': '🔴 IMMINENT',
            'CRITICAL': '🟠 CRITIQUE',
            'HIGH': '🟡 ÉLEVÉ',
            'NORMAL': '🔵 NORMAL'
        };
        return badges[level] || '⚪';
    };

    const getProbabilityColor = (prob) => {
        if (prob > 90) return '#ff0044';
        if (prob > 80) return '#ff4400';
        if (prob > 70) return '#ff8800';
        if (prob > 60) return '#ffcc00';
        if (prob > 50) return '#88cc00';
        return '#666666';
    };

    const ProgressBar = ({ value, label, color }) => (
        <div className="progress-container">
            <div className="progress-label">{label}: {value}%</div>
            <div className="progress-bar">
                <div 
                    className="progress-fill" 
                    style={{ 
                        width: `${value}%`, 
                        backgroundColor: color || getProbabilityColor(value) 
                    }}
                />
            </div>
        </div>
    );

    const FactorMatrix = ({ factors }) => (
        <div className="factor-matrix">
            <div className="matrix-title">📊 MATRICE DES FACTEURS</div>
            <div className="matrix-grid">
                <div className="matrix-item">
                    <span className="factor-label">État Score</span>
                    <span className="factor-value" style={{color: getProbabilityColor(factors?.scoreState)}}>
                        {factors?.scoreState || 0}%
                    </span>
                </div>
                <div className="matrix-item">
                    <span className="factor-label">Temps Écoulé</span>
                    <span className="factor-value" style={{color: getProbabilityColor(factors?.timeFactor)}}>
                        {factors?.timeFactor || 0}%
                    </span>
                </div>
                <div className="matrix-item">
                    <span className="factor-label">Pression Attaque</span>
                    <span className="factor-value" style={{color: getProbabilityColor(factors?.pressureFactor)}}>
                        {factors?.pressureFactor || 0}%
                    </span>
                </div>
                <div className="matrix-item">
                    <span className="factor-label">Mouvement Cotes</span>
                    <span className="factor-value" style={{color: getProbabilityColor(factors?.oddsFactor)}}>
                        {factors?.oddsFactor || 0}%
                    </span>
                </div>
                <div className="matrix-item">
                    <span className="factor-label">Pattern Match</span>
                    <span className="factor-value" style={{color: getProbabilityColor(factors?.patternMatch)}}>
                        {factors?.patternMatch || 0}%
                    </span>
                </div>
                <div className="matrix-item">
                    <span className="factor-label">Carton Rouge</span>
                    <span className="factor-value" style={{color: getProbabilityColor(factors?.redCardFactor)}}>
                        {factors?.redCardFactor || 0}%
                    </span>
                </div>
            </div>
        </div>
    );

    return (
        <div className="live-goal-dashboard">
            <div className="dashboard-header">
                <h1>🎯 LIVE GOAL PREDICTOR - EXPERT MODE</h1>
                <div className="header-controls">
                    <span className="last-update">
                        🔄 Dernière mise à jour: {new Date(lastUpdate).toLocaleTimeString()}
                    </span>
                    <label className="auto-refresh-toggle">
                        <input 
                            type="checkbox" 
                            checked={autoRefresh}
                            onChange={(e) => setAutoRefresh(e.target.checked)}
                        />
                        Auto-refresh (10s)
                    </label>
                </div>
            </div>

            <div className="live-stats-bar">
                <div className="stat-item">
                    <span className="stat-label">MATCHS LIVE</span>
                    <span className="stat-value">{liveMatches.length}</span>
                </div>
                <div className="stat-item">
                    <span className="stat-label">ALERTES HAUTE</span>
                    <span className="stat-value danger">
                        {liveMatches.filter(m => m.alertLevel === 'HIGH' || m.alertLevel === 'CRITICAL' || m.alertLevel === 'IMMINENT').length}
                    </span>
                </div>
                <div className="stat-item">
                    <span className="stat-label">IMMINENT</span>
                    <span className="stat-value critical">
                        {liveMatches.filter(m => m.alertLevel === 'IMMINENT').length}
                    </span>
                </div>
                <div className="stat-item">
                    <span className="stat-label">CONFIDENCE MOY</span>
                    <span className="stat-value">
                        {liveMatches.length > 0 
                            ? Math.round(liveMatches.reduce((a,b) => a + (b.confidence || 0), 0) / liveMatches.length) 
                            : 0}%
                    </span>
                </div>
            </div>

            <div className="live-matches-container">
                {liveMatches.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon">⏳</div>
                        <div>Aucun match live en cours d'analyse</div>
                    </div>
                ) : (
                    liveMatches.map(match => (
                        <div 
                            key={match.matchId} 
                            className={`match-card ${match.alertLevel.toLowerCase()}`}
                            onClick={() => setSelectedMatch(selectedMatch?.matchId === match.matchId ? null : match)}
                        >
                            <div className="match-header">
                                <div className="match-teams">
                                    <span className="team-name">{match.homeTeam}</span>
                                    <span className="match-score">
                                        {match.score?.home || 0} - {match.score?.away || 0}
                                    </span>
                                    <span className="team-name">{match.awayTeam}</span>
                                </div>
                                <div className="match-meta">
                                    <span className="match-minute">⏱ {match.minute}'</span>
                                    <span 
                                        className="alert-badge"
                                        style={{ backgroundColor: getAlertColor(match.alertLevel) }}
                                    >
                                        {getAlertBadge(match.alertLevel)}
                                    </span>
                                </div>
                            </div>

                            <div className="probability-grid">
                                <div className="prob-item">
                                    <span className="prob-label">5 MIN</span>
                                    <span 
                                        className="prob-value"
                                        style={{ color: getProbabilityColor(match.probabilities?.next5min) }}
                                    >
                                        {match.probabilities?.next5min || 0}%
                                    </span>
                                </div>
                                <div className="prob-item">
                                    <span className="prob-label">10 MIN</span>
                                    <span 
                                        className="prob-value"
                                        style={{ color: getProbabilityColor(match.probabilities?.next10min) }}
                                    >
                                        {match.probabilities?.next10min || 0}%
                                    </span>
                                </div>
                                <div className="prob-item">
                                    <span className="prob-label">15 MIN</span>
                                    <span 
                                        className="prob-value"
                                        style={{ color: getProbabilityColor(match.probabilities?.next15min) }}
                                    >
                                        {match.probabilities?.next15min || 0}%
                                    </span>
                                </div>
                                <div className="prob-item">
                                    <span className="prob-label">FIN MATCH</span>
                                    <span 
                                        className="prob-value"
                                        style={{ color: getProbabilityColor(match.probabilities?.restOfMatch) }}
                                    >
                                        {match.probabilities?.restOfMatch || 0}%
                                    </span>
                                </div>
                            </div>

                            <div className="match-prediction">
                                {match.prediction?.recommendation || 'Analyse en cours...'}
                            </div>

                            {selectedMatch?.matchId === match.matchId && (
                                <div className="match-details-expanded">
                                    <FactorMatrix factors={match.factors} />
                                    
                                    <div className="confidence-indicator">
                                        <span className="confidence-label">NIVEAU DE CONFIANCE</span>
                                        <div className="confidence-bar">
                                            <div 
                                                className="confidence-fill"
                                                style={{ 
                                                    width: `${match.confidence}%`,
                                                    backgroundColor: match.confidence > 80 ? '#00ff88' : match.confidence > 60 ? '#ffcc00' : '#ff4444'
                                                }}
                                            />
                                        </div>
                                        <span className="confidence-value">{match.confidence}%</span>
                                    </div>

                                    {match.patternMatched && match.patternMatched.length > 0 && (
                                        <div className="patterns-section">
                                            <div className="patterns-title">🔍 PATTERNS CORRESPONDANTS</div>
                                            <div className="patterns-list">
                                                {match.patternMatched.map((p, i) => (
                                                    <div key={i} className="pattern-item">
                                                        <span>{p.minute}' - {p.league}</span>
                                                        <span>But dans: {p.goalInNext}min | Succès: {p.successRate}%</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default LiveGoalDashboard;
