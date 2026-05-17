import React, { useState, useEffect } from 'react';
import dataService from '../services/dataService';
import { classifyMatch } from '../utils/analystEngine';
import { saveAsJpeg } from '../utils/exportUtils';
import './AIAnalysis.css';

const AIAnalysis = () => {
    const [match, setMatch] = useState(null);

    const handleDownload = () => {
        saveAsJpeg('ai-analysis-capture', `AI_Analysis_${match?.homeTeam?.name || 'Match'}.jpg`);
    };

    useEffect(() => {
        const unsubscribe = dataService.subscribe((data) => {
            if (data && data.length > 0) {
                setMatch(data[0]);
            }
        });
        return () => unsubscribe();
    }, []);

    if (!match) return <div className="loading">CONNECTING TO WAR ROOM...</div>;

    const { homeTeam, awayTeam, score = {}, minute, stats = {}, winProb } = match;

    const analysis = match ? classifyMatch(match) : null;

    const matchLog = [
        { time: new Date().toLocaleTimeString(), message: `DANGEROUS ATTACK DETECTED - ${(stats?.pressure?.home || 0) > (stats?.pressure?.away || 0) ? 'HOME' : 'AWAY'}`, type: 'danger' },
        { time: new Date().toLocaleTimeString(), message: `ANALYST CLASSIFICATION: ${analysis?.tagLabel || 'SYNCING...'}`, type: 'elite' },
        { time: new Date().toLocaleTimeString(), message: 'RECALCULATING MOMENTUM (0.42ms)', type: 'info' },
    ];

    return (
        <div className="ai-analysis-container" id="ai-analysis-capture">
            <header className="ai-header">
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', width:'100%'}}>
                    <div className="system-ver">AI Analysis Engine v4.2.0</div>
                    <button className="jpeg-btn" onClick={handleDownload} style={{background:'rgba(255,255,255,0.1)', color:'#fff', border:'1px solid rgba(255,255,255,0.2)', padding:'4px 8px', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer'}}>SAVE JPEG</button>
                </div>
                <div className="live-badge">
                    <span className="dot animate-pulse"></span>
                    WAR ROOM ACTIVE
                </div>
            </header>

            <section className="match-card-compact">
                <div className="scanline"></div>
                <div className="team home">
                    <div className="crest">
                        <span className="material-symbols-outlined">shield</span>
                    </div>
                    <span className="name">
                        {typeof homeTeam === 'object' ? homeTeam.name : (homeTeam || 'HOME')}
                    </span>
                </div>
                <div className="score-area">
                    <div className="time">{minute}' <span className="material-symbols-outlined">timer</span></div>
                    <div className="score">
                        {score?.home ? Math.round(parseFloat(score.home)) : 0} - {score?.away ? Math.round(parseFloat(score.away)) : 0}
                    </div>
                </div>
                <div className="team away">
                    <div className="crest text-red">
                        <span className="material-symbols-outlined">military_tech</span>
                    </div>
                    <span className="name">
                        {typeof awayTeam === 'object' ? awayTeam.name : (awayTeam || 'AWAY')}
                    </span>
                </div>
            </section>

            <div className="war-rings-grid">
                <RingStat label="GOALS WAR" val={stats?.pressure?.home || 0} icon="local_fire_department" color="#22c55e" />
                <RingStat label="CORNERS WAR" val={(stats?.corners?.home || 0) * 10} icon="flag" color="#3b82f6" />
                <RingStat label="CARDS WAR" val={(stats?.cards?.home || 0) * 20} icon="style" color="#ef4444" />
                <RingStat label="COMBO AI" val={winProb} icon="psychology" color="#eab308" />
            </div>

            <div className="terminal-log">
                <div className="log-header">
                    <span className="material-symbols-outlined">terminal</span>
                    CLEANUP AGENT LOG
                </div>
                <div className="log-entries">
                    {matchLog.map((log, i) => (
                        <div key={i} className={`log-entry ${log.type}`}>
                            <span className="timestamp">[{log.time}]</span>
                            <span className="msg">{log.message}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="analyst-report-box">
                <div className="report-header">
                    <span className="material-symbols-outlined">analytics</span>
                    TITANIUM ANALYST REPORT
                </div>
                <div className="report-content">
                    <div className="report-item">
                        <span className="report-label">TAG:</span>
                        <span className={`report-value tag-badge ${analysis?.tagLabel?.includes('BANKER') ? 'banker' : analysis?.tagLabel?.includes('TREND') ? 'trend' : 'value'}`}>
                            {analysis?.tagLabel}
                        </span>
                    </div>
                    <div className="report-item">
                        <span className="report-label">LOGIC:</span>
                        <p className="report-logic">{analysis?.logic}</p>
                    </div>
                </div>
            </div>

            <div className="elite-selection-card">
                <div className="card-glow"></div>
                <div className="card-top">
                    <div className="elite-icon">
                        <span className="material-symbols-outlined">trending_up</span>
                    </div>
                    <div className="selection-info">
                        <h3>OVER 1.5 GOALS</h3>
                        <p>AI MOMENTUM CONFIDENCE</p>
                        <div className="progress-bar-container">
                            <div className="progress-bar" style={{ width: `${winProb}%` }}></div>
                            <span className="percentage">{winProb}%</span>
                        </div>
                    </div>
                </div>
                <div className="card-bottom">
                    <div className="odds">
                        <span>LIVE ODDS</span>
                        <div className="val">1.85</div>
                    </div>
                    <button className="track-btn">TRACK BET</button>
                </div>
            </div>
        </div>
    );
};

const RingStat = ({ label, val, icon, color }) => {
    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (val / 100) * circumference;

    return (
        <div className="ring-stat-card">
            <div className="ring-wrap">
                <svg viewBox="0 0 100 100">
                    <circle className="bg" cx="50" cy="50" r={radius} />
                    <circle
                        className="prog"
                        cx="50"
                        cy="50"
                        r={radius}
                        stroke={color}
                        style={{ strokeDasharray: circumference, strokeDashoffset: offset }}
                    />
                </svg>
                <div className="ring-icon" style={{ color }}>
                    <span className="material-symbols-outlined">{icon}</span>
                </div>
            </div>
            <span className="ring-label">{label}</span>
            <span className="ring-val" style={{ color }}>{val}%</span>
        </div>
    );
};

export default AIAnalysis;
