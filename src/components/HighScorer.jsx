import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { getApiUrl } from '../config/apiConfig';
import { saveAsJpeg } from '../utils/exportUtils';
import './HighScorer.css';

const HighScorer = () => {
    const [picks, setPicks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const handleDownload = () => {
        saveAsJpeg('high-scorer-capture', `HighScorer_${new Date().toISOString().split('T')[0]}.jpg`);
    };

    useEffect(() => {
        const fetchPicks = async () => {
            try {
                setLoading(true);
                const response = await axios.get(getApiUrl('/api/high-scoring'));
                if (response.data && response.data.success) {
                    setPicks(response.data.picks);
                } else {
                    setError("Failed to fetch goal picks");
                }
            } catch (err) {
                console.error("Error fetching high scoring picks:", err);
                setError("System offline or API error");
            } finally {
                setLoading(false);
            }
        };

        fetchPicks();
    }, []);

    if (loading) {
        return (
            <div className="high-scorer-loading">
                <div className="fire-pulse">🔥</div>
                <p>ANALYZING OVER 2.5 INTENSITY...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="high-scorer-error">
                <span className="error-icon">⚠️</span>
                <p>{error}</p>
                <button onClick={() => window.location.reload()}>RETRY SENSORS</button>
            </div>
        );
    }

    return (
        <div className="high-scorer-container" id="high-scorer-capture">
            <header className="high-scorer-header">
                <div className="header-content">
                    <div style={{display:'flex', alignItems:'center', gap:'20px'}}>
                        <h1>🔥 HIGH SCORING ELITE</h1>
                        <button className="jpeg-btn" onClick={handleDownload} style={{background:'#ef4444', color:'white', border:'none', padding:'8px 16px', borderRadius:'4px', fontWeight:'bold', cursor:'pointer'}}>SAVE JPEG</button>
                    </div>
                    <p>Top selections optimized for Over 2.5 goals & BTTS based on XGBoost Strike Force Analysis.</p>
                </div>
                <div className="header-stats">
                    <div className="stat-box">
                        <span className="stat-val">{picks.length}</span>
                        <span className="stat-label">HOT PICKS</span>
                    </div>
                </div>
            </header>

            <div className="picks-grid">
                {picks.map((pick) => (
                    <div key={pick.id} className="pick-card">
                        <div className="pick-league">{pick.league}</div>
                        <div className="pick-teams">
                            <div className="team home">
                                <span className="odds-badge">[{pick.odds.home || '—'}]</span>
                                {pick.home}
                            </div>
                            <div className="vs">VS</div>
                            <div className="team away">
                                <span className="odds-badge">[{pick.odds.away || '—'}]</span>
                                {pick.away}
                            </div>
                        </div>

                        <div className="pick-analysis">
                            <div className="intensity-section">
                                <div className="intensity-header">
                                    <span>GOAL INTENSITY</span>
                                    <span>{pick.intensity}%</span>
                                </div>
                                <div className="intensity-bar">
                                    <div 
                                        className="intensity-fill" 
                                        style={{ width: `${pick.intensity}%` }}
                                    ></div>
                                </div>
                            </div>

                            <div className="data-points">
                                <div className="data-point">
                                    <span className="label">O2.5 PROB</span>
                                    <span className="value orange">{pick.ouProb}%</span>
                                </div>
                                <div className="data-point">
                                    <span className="label">BTTS PROB</span>
                                    <span className="value green">{pick.bttsProb}%</span>
                                </div>
                                <div className="data-point">
                                    <span className="label">EXP. SCORE</span>
                                    <span className="value white">{pick.expectedScore}</span>
                                </div>
                            </div>
                        </div>

                        <div className="pick-odds">
                            <div className="odds-box">
                                <span className="label">1</span>
                                <span className="val">{pick.odds.home || '—'}</span>
                            </div>
                            <div className="odds-box destac">
                                <span className="label">O2.5</span>
                                <span className="val highlight">GOOD</span>
                            </div>
                            <div className="odds-box">
                                <span className="label">2</span>
                                <span className="val">{pick.odds.away || '—'}</span>
                            </div>
                        </div>

                        <div className="card-footer">
                            <span className="kickoff">
                                🕒 {new Date(pick.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <span className="strategy-tag">STRIKE FORCE EXTREME</span>
                        </div>
                    </div>
                ))}
            </div>

            {picks.length === 0 && (
                <div className="no-picks">
                    <p>No high-intensity matches detected for today's prematch slate.</p>
                </div>
            )}
        </div>
    );
};

export default HighScorer;
