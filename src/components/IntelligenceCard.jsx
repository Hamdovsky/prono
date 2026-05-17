import React from 'react';
import './IntelligenceCard.css';

const IntelligenceCard = ({ match, onOpenUltimate }) => {
    // Data extraction from V17 Engine payload
    // Supports both nested (match.enriched.*) and flat (match.*) formats
    const enriched = match.enriched || {};
    const verdict = enriched.verdict || match.verdict || "RISKY BET";
    const mainPredictions = enriched.main_predictions || match.main_predictions || [];
    
    // Power tubes: use enriched, or flat, or built from probabilities
    const homeWinPct = Math.round(parseFloat(match.home_win_probability || 0));
    const awayWinPct = Math.round(parseFloat(match.away_win_probability || 0));
    const drawPct = Math.round(parseFloat(match.draw_probability || 0));
    const xgbConf = Math.round(parseFloat(match.xgboost_confidence || 0) * 100);
    // V48: Direct integration of real percentages instead of tubes (░░░░░)
    const powerTubes = enriched.power_tubes || match.power_tubes || (
        homeWinPct > 0 ? {
            "Attack": `${homeWinPct}%`,
            "Defense": `${100 - awayWinPct}%`,
            "Recent": `${xgbConf}%`,
            "Team": `${homeWinPct > awayWinPct ? homeWinPct : awayWinPct}%`,
            "Motivation": `${Math.max(homeWinPct, drawPct, awayWinPct)}%`
        } : {
            "Attack Strength": "TBD",
            "Defense Strength": "TBD",
            "Recent Form": "TBD",
            "Team Momentum": "TBD",
            "Motivation Level": "TBD"
        }
    );
    let integrityAudit = {};
    try {
        integrityAudit = typeof match.integrity_audit === 'string' ? JSON.parse(match.integrity_audit) : (match.integrity_audit || {});
    } catch(e) {}
    const smartMoney = integrityAudit.smartMoneyPulse || { pro: 50, amateur: 50 };
    const trafficLight = integrityAudit.trafficLight || 'GREEN';
    
    const integrity = match.integrity || match.news_data?.integrity || { score: 0, status: 'GREEN' };
    const valueEdge = match.value_edge || match.enriched?.value_edge || 0;

    let v70 = match.v70_analytics;
    if (typeof v70 === 'string') {
        try { v70 = JSON.parse(v70); } catch(e) { v70 = null; }
    }

    const getVerdictClass = (v) => {
        if (v === "SAFE BET") return "safe";
        if (v === "STRONG BET") return "strong";
        return "risky";
    };

    const confidence = match.confidence || (enriched.main_predictions?.[0]?.probability) || xgbConf || homeWinPct || 50;
    const isGolden = (match.is_confirmed || enriched.is_confirmed) && confidence >= 88;
    const isSmartMoney = match.is_smart_money || enriched.is_smart_money;
    
    const calculateStake = () => {
        const successRate = match.v22_success_rate || enriched.v22_success_rate || confidence;
        if (successRate > 85) return 9;
        const valIdx = match.value_index || enriched.value_index || 1.0;
        let base = Math.floor(successRate / 10);
        if (valIdx > 1.2) base += 1;
        return Math.min(10, Math.max(1, base));
    };
    const recommendedStake = calculateStake();

    const oddsH = match.odds_home || match.market_odds || (match.odds?.home);
    const oddsHOpen = match.odds_home_open || (match.odds?.home_open);
    const dropPct = oddsHOpen && oddsH && oddsH < oddsHOpen ? Math.floor(((oddsHOpen - oddsH) / oddsHOpen) * 100) : 0;

    const displayTime = () => {
        if (match.status === 'FT' || match.status === 'FINISHED') return "FINISHED";
        if (match.startTimestamp) {
            return new Date(match.startTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return "--:--";
    };

    return (
        <div className={`titanium-card ${isGolden ? 'golden-pick' : ''}`}>
            {/* Header: Verdict Badge & Time */}
            <div className="titanium-card-header">
                <div className="header-left">
                    <div className={`verdict-pill ${getVerdictClass(verdict)}`}>
                        <span className="dot"></span>
                        {verdict}
                    </div>
                    {/* V22 PROBABILITY SUCCESS RATE */}
                    <div className="v22-success-rate-badge">
                        <span className="label">PROBABILITY SUCCESS RATE</span>
                        <div className="val-row">
                            <span className="val">{match.v22_success_rate || enriched.v22_success_rate || (match.power_score ? Math.round(match.power_score / 1.2 + 20) : '--')}%</span>
                            {(match.smart_money_active || enriched.smart_money_active) && <span className="smart-money-icon">💰</span>}
                        </div>
                    </div>
                    {match.power_score && (
                        <div className="sentiment-badge" style={{background: 'rgba(56,189,248,0.1)', color: '#38bdf8', borderColor: 'rgba(56,189,248,0.3)'}}>
                            ⚡ PWR: {Math.round(match.power_score)}
                        </div>
                    )}
                </div>
                <div className="match-time">{displayTime()}</div>
            </div>

            {/* V18: Country & League Badge */}
            <div className="league-badge" style={{
                fontSize: '10px',
                fontWeight: '900',
                color: '#94a3b8',
                background: 'rgba(255,255,255,0.03)',
                padding: '4px 10px',
                borderRadius: '4px',
                marginBottom: '5px',
                display: 'inline-block',
                textTransform: 'uppercase',
                letterSpacing: '1px',
                border: '1px solid rgba(255,255,255,0.05)'
            }}>
                🌍 {match.league || 'Ligue Inconnue'}
            </div>

            {/* Duel Section */}
            <div className="titanium-duel">
                <div className="team home">
                    <span className="name">
                        {match.momentum?.home > 1.05 && <span title="Hot Streak" style={{marginRight: '4px'}}>🔥</span>}
                        {match.momentum?.home < 0.95 && <span title="Crisis" style={{marginRight: '4px'}}>❄️</span>}
                        {match.homeTeam}
                    </span>
                </div>
                
                <div className="score-display">
                    {/* Show expected_score for upcoming matches, real score for live/finished */}
                    {(() => {
                        const isLive = match.status === 'live' || match.status === 'LIVE';
                        const isFt = match.status === 'FT' || match.status === 'FINISHED';
                        if (isLive || isFt) {
                            return (<><span className="val">{match.homeScore ?? '-'}</span><span className="sep">:</span><span className="val">{match.awayScore ?? '-'}</span></>);
                        }
                        // Upcoming: show predicted score
                        if (match.expected_score && match.expected_score !== '? - ?' && match.expected_score !== '-') {
                            const parts = match.expected_score.split('-');
                            if (parts.length === 2) {
                                return (<><span className="val" style={{color:'#38bdf8'}}>{parts[0].trim()}</span><span className="sep">:</span><span className="val" style={{color:'#38bdf8'}}>{parts[1].trim()}</span></>);
                            }
                        }
                        return (<><span className="val-analyzing" style={{fontSize: '0.8rem', color: '#6366f1'}}>ANALYZING...</span></>);
                    })()}
                </div>

                <div className="team away">
                    <span className="name">
                        {match.awayTeam}
                        {match.momentum?.away > 1.05 && <span title="Hot Streak" style={{marginLeft: '4px'}}>🔥</span>}
                        {match.momentum?.away < 0.95 && <span title="Crisis" style={{marginLeft: '4px'}}>❄️</span>}
                    </span>
                </div>
            </div>

            {/* Odds Comparison & Stake */}
            <div className="titanium-metadata">
                <div className="odds-comparison">
                    <div className="odds-item">
                        <span className="label">Ouv.</span>
                        <span className="val">{oddsHOpen || '-'}</span>
                    </div>
                    <div className="odds-item current">
                        <span className="label">Live</span>
                        <span className="val">{oddsH || '-'}</span>
                    </div>
                </div>
                {enriched.bankroll_advice ? (
                    <div className="recommended-stake bankroll-v90" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                        <span className="label" style={{ color: '#fbbf24' }}>BANKROLL V90 (Kelly)</span>
                        <div className="val" style={{ fontSize: '1.2rem', fontWeight: 'bold', color: enriched.bankroll_advice.recommendedPercentage > 2.5 ? '#10b981' : '#f59e0b' }}>
                            {enriched.bankroll_advice.recommendedPercentage}%
                        </div>
                        <div className="tooltip-hint" style={{ fontSize: '0.7rem', color: '#9ca3af', maxWidth: '150px', textAlign: 'right' }}>
                            {enriched.bankroll_advice.explanationAr}
                        </div>
                    </div>
                ) : (
                    <div className="recommended-stake">
                        <span className="label">MISE REC.</span>
                        <div className="stake-dots">
                            {[...Array(10)].map((_, i) => (
                                <span key={i} className={`stake-dot ${i < recommendedStake ? 'active' : ''}`}></span>
                            ))}
                            <span className="stake-val">{recommendedStake}/10</span>
                        </div>
                    </div>
                )}
            </div>

            {/* V22 Predictions Grid */}
            <div className="titanium-stats-grid v22-grid">
                {mainPredictions.filter(p => p.label !== "Both Teams to Score").map((p, i) => (
                    <div key={i} className="stat-slot">
                        <label>{p.label === "Goals Prediction" ? "TOTAL GOALS PREDICTED" : p.label}</label>
                        <span className="value">
                            {p.label === "Goals Prediction" ? (match.total_goals_label || enriched.total_goals_label || p.val) : p.val}
                        </span>
                    </div>
                ))}
            </div>

            {/* [V49] AI CS-PREDICTION: Poisson Matrix outcomes */}
            {enriched.ai_cs_prediction && enriched.ai_cs_prediction.length > 0 && (
                <div className="ai-cs-prediction-v19 v22-cs">
                    <div className="cs-header">[AI CORRECT SCORE]</div>
                    <div className="cs-grid">
                        {enriched.ai_cs_prediction.map((p, idx) => (
                            <div key={idx} className="cs-item">
                                <span className="cs-score">{p.score}</span>
                                <span className="cs-prob">({p.prob}%)</span>
                                {idx === 0 && <span className="cs-fire">🎯</span>}
                            </div>
                        ))}
                    </div>
                    {/* V22 CHAOS FACTORS FOOTER */}
                    {(match.chaos_factor_msg || enriched.chaos_factor_msg) && (
                        <div className="v22-chaos-factors">
                            <span className="factor-label">CHAOS FACTORS:</span>
                            <span className="factor-val">{match.chaos_factor_msg || enriched.chaos_factor_msg}</span>
                        </div>
                    )}
                </div>
            )}

            {/* V61 Smart Money Heatmap */}
            <div className={`sm-heatmap-container glow-${trafficLight}`}>
                <div className="sm-header">
                    <span className="sm-title">SMART MONEY</span>
                    <span className={`sm-status status-${trafficLight}`}>
                        {trafficLight === 'GREEN' ? '🟢 CLEAR' : trafficLight === 'YELLOW' ? '🟡 CAUTION' : '🔴 DANGER'}
                    </span>
                </div>
                <div className="sm-bar-bg">
                    <div className="sm-bar-pro" style={{ width: `${smartMoney.pro}%` }}></div>
                </div>
                <div className="sm-footer">
                    <span className="pro-label">PRO: {smartMoney.pro}%</span>
                    <span className="am-label">AM: {smartMoney.amateur}%</span>
                </div>
            </div>

            {/* V70 Advanced Analytics Suite */}
            {v70 && (
                <div className="v70-analytics-grid">
                    <div className="v70-header">
                        <span className="v70-title">V70 TACTICAL ENGINE</span>
                    </div>
                    <div className="v70-metrics">
                        {/* Fatigue / Rest */}
                        {v70.rest && (
                            <div className={`v70-badge ${v70.rest.isFatigueTrap ? 'alert' : 'normal'}`}>
                                <span className="icon">🔋</span>
                                <span>{v70.rest.advantage}</span>
                            </div>
                        )}
                        
                        {/* Referee Conflict */}
                        {v70.discipline && v70.discipline.score >= 60 && (
                            <div className="v70-badge alert-red">
                                <span className="icon">🟨</span>
                                <span>{v70.discipline.warning}</span>
                            </div>
                        )}
                        
                        {/* Odds Velocity */}
                        {v70.odds_velocity && Math.abs(v70.odds_velocity.diffPct) >= 5 && (
                            <div className="v70-badge velocity">
                                <span className="icon">♨️</span>
                                <span>{v70.odds_velocity.trend} ({v70.odds_velocity.diffPct > 0 ? '+' : ''}{v70.odds_velocity.diffPct}%)</span>
                            </div>
                        )}
                    </div>

                    {/* xG Regression Matrix */}
                    {v70.xg_regression && (
                        <div className="v70-xg-matrix">
                            <div className="xg-row">
                                <span className="tm-label">HOME</span>
                                <span className="xg-val">xG: {v70.xg_regression.home?.xg || '-'}</span>
                                <span className="xg-badge">{v70.xg_regression.home?.badge} {v70.xg_regression.home?.status}</span>
                            </div>
                            <div className="xg-row">
                                <span className="tm-label">AWAY</span>
                                <span className="xg-val">xG: {v70.xg_regression.away?.xg || '-'}</span>
                                <span className="xg-badge">{v70.xg_regression.away?.badge} {v70.xg_regression.away?.status}</span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Power Tubes: Visual Indicators */}
            <div className="titanium-tubes">
                {Object.entries(powerTubes).map(([label, tube]) => (
                    <div key={label} className="tube-item">
                        <div className="tube-header">
                            <span className="label">{label.split(' ')[0]}</span>
                        </div>
                        <div className="tube-bar">{tube}</div>
                    </div>
                ))}
            </div>

            {/* Terminal Action Footer */}
            <div className="titanium-action">
                <button className="console-btn" onClick={() => onOpenUltimate && onOpenUltimate()}>
                    DÉPLOYER ANALYSE TITANIUM V19
                </button>
            </div>
        </div>
    );
};

export default IntelligenceCard;
