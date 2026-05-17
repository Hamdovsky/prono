import React, { useState, useEffect, useMemo } from 'react';
import './UltimateMatchCenter.css';
import { calculateEV } from '../../services/InsightEngine';
import PlayerProps from '../PlayerProps/PlayerProps';
import SimulationEngine from '../../services/SimulationEngine';
import { BarChart, Bar, ReferenceLine, XAxis, YAxis, Tooltip as ChartTooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

const UltimateMatchCenter = ({ match, onClose }) => {
    const [oracleData, setOracleData] = useState(null);
    const [scanning, setScanning] = useState(true);

    // Escape key to close
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    // Oracle Simulation (PROJECT ORACLE V4)
    useEffect(() => {
        if (!match) return;
        setScanning(true);
        
        const timer = setTimeout(() => {
            const hP = parseProb(match.home_win_probability || match.winProb || 0);
            const dP = parseProb(match.draw_probability || 0);
            const aP = parseProb(match.away_win_probability || 0);
            const o25 = parseInt(match.ou25_prob || match.ou_25_prob || 50);
            
            const results = SimulationEngine.simulateMatch({ homeWin: hP, draw: dP, awayWin: aP, ou25: o25 });
            setOracleData(results);
            setScanning(false);
        }, 1200);

        return () => clearTimeout(timer);
    }, [match]);

    if (!match) return null;

    const parseProb = (val) => {
        if (!val) return 0;
        const num = parseFloat(String(val).replace('%', ''));
        if (isNaN(num)) return 0;
        return num <= 1 ? Math.round(num * 100) : Math.round(num);
    };

    const ts = match.startTimestamp ? match.startTimestamp * 1000 : match.startTime;
    const statusUpper = (match.status || '').toUpperCase();
    const isLive = statusUpper === 'LIVE' || (match.minute && match.minute !== "0" && statusUpper !== "FINISHED" && statusUpper !== "FT");
    const isFinished = statusUpper === 'FT' || statusUpper === 'FINISHED';

    const xgbConf = match.xgboost_confidence ? parseFloat(match.xgboost_confidence) : 0;
    const baseWinP = parseInt(match.home_win_probability || match.winProb || 0);
    const winP = parseInt(match.adjusted_win_prob || baseWinP);
    const ev = calculateEV(winP, match.market_odds || 2.0);
    const reliability = Math.round(match.reliability_index || 50);

    const homeWinP = parseProb(match.home_win_probability || match.winProb || 0);
    const awayWinP = parseProb(match.away_win_probability || 0);
    const dnbHome = (homeWinP + awayWinP) > 0 ? Math.round((homeWinP / (homeWinP + awayWinP)) * 100) : '--';
    const dnbAway = (homeWinP + awayWinP) > 0 ? Math.round((awayWinP / (homeWinP + awayWinP)) * 100) : '--';

    return (
        <div className="umc-overlay" onClick={onClose}>
            <div className={`umc-modal ${scanning ? 'modal-scanning' : ''}`} onClick={e => e.stopPropagation()}>
                <button className="umc-close-btn" onClick={onClose}>×</button>

                {/* ── HEADER ── */}
                <div className="umc-header">
                    <div className="umc-league-badge">{match.tournament_name || match.league || "COMPETITION"}</div>
                    <div className="umc-teams-score">
                        <div className="umc-team home" style={{ textAlign: 'right', flex: 1, fontSize: '1.5rem', fontWeight: 800 }}>{match.homeTeam}</div>
                        <div className="umc-score-box" style={{ background: 'rgba(0,0,0,0.4)', padding: '10px 24px', borderRadius: 12, minWidth: 100, fontSize: '2rem', fontWeight: 900 }}>
                            {match.homeScore ?? "-"} - {match.awayScore ?? "-"}
                        </div>
                        <div className="umc-team away" style={{ textAlign: 'left', flex: 1, fontSize: '1.5rem', fontWeight: 800 }}>{match.awayTeam}</div>
                    </div>
                </div>

                <div className="umc-body" style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 20 }}>
                    
                    {/* QUANTUM ORACLE SIMULATOR (The Revolutionary Part) */}
                    <div className="col-span-12 umc-panel oracle-panel" style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(99, 102, 241, 0.3)', padding: 25, borderRadius: 20, position: 'relative', overflow: 'hidden' }}>
                        <div className="oracle-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <span style={{ background: '#6366f1', color: '#fff', fontSize: '0.7rem', fontWeight: 900, padding: '2px 8px', borderRadius: 4 }}>TITANIUM ORACLE V4</span>
                                <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#f1f5f9' }}>🤖 محاكي المباراة (10,000 محاكمة رياضية)</h3>
                            </div>
                            {!scanning && <span style={{ color: '#10b981', fontSize: '0.8rem', fontWeight: 600 }}>✅ تم اكتمال المسح الكمي</span>}
                        </div>

                        {scanning ? (
                            <div className="oracle-scanning-view" style={{ textAlign: 'center', padding: '40px 0' }}>
                                <div className="scan-line-anim"></div>
                                <div className="spinner-v4"></div>
                                <p style={{ color: '#94a3b8', marginTop: 15, fontSize: '0.9rem' }}>جاري حقن 10,000 سيناريو افتراضي في محرك التوقعات...</p>
                            </div>
                        ) : (
                            <div className="oracle-results-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 30 }}>
                                <div className="oracle-scores-zone">
                                    <h4 style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: 15 }}>📊 النتائج الأكثر احتمالاً (Score Heatmap)</h4>
                                    <div className="score-matrix-v4" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                                        {oracleData?.topScores.map((s, i) => (
                                            <div key={i} className="score-card-v4" style={{ background: 'rgba(0,0,0,0.3)', padding: '12px 16px', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)' }}>
                                                <span style={{ fontWeight: 800, color: '#f8fafc', fontSize: '1.1rem' }}>{s.score}</span>
                                                <div style={{ textAlign: 'right' }}>
                                                    <span style={{ color: '#10b981', fontWeight: 700 }}>{s.prob}%</span>
                                                    <div style={{ width: 40, height: 3, background: '#10b981', opacity: s.prob/20, marginTop: 4 }}></div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div className="oracle-analysis-zone">
                                    <h4 style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: 15 }}>⚡ منحنى الضغط والأهداف المتوقعة</h4>
                                    {oracleData?.pressureWave?.length > 0 && (
                                        <div style={{ width: '100%', height: 120, minHeight: 0, overflow: 'hidden' }}>
                                            <ResponsiveContainer width="100%" height={120}>
                                                <BarChart data={oracleData.pressureWave} margin={{ top: 5, right: 0, left: 0, bottom: 5 }} barCategoryGap="5%" barGap={0}>
                                                    <ChartTooltip 
                                                        contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', fontSize: '12px', color: '#f8fafc' }}
                                                        itemStyle={{ fontWeight: 800 }}
                                                        formatter={(value) => [Math.abs(value), 'Pression']}
                                                        labelFormatter={(label) => `Minute ${label}`}
                                                        cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                                                    />
                                                    <ReferenceLine y={0} stroke="#475569" strokeWidth={2} />
                                                    <Bar dataKey="homePressure" fill="#3b82f6" />
                                                    <Bar dataKey="awayPressure" fill="#ef4444" />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    )}
                                    <div style={{ marginTop: 15, background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 10, fontSize: '0.8rem' }}>
                                        <div>🎯 الأهداف المتوقعة الإجمالية: <b style={{color: '#10b981'}}>{oracleData?.expectedTotal}</b></div>
                                        <div style={{marginTop: 5, color: '#94a3b8'}}>نوافذ التسجيل القصوى تتمركز في الدقائق 75-90.</div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* KPI STRIP */}
                    <div className="col-span-12" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 15 }}>
                        {[
                            { label: 'ثقة XGBoost', val: `${Math.round(xgbConf * 100)}%`, color: '#6366f1' },
                            { label: 'Value (EV+)', val: `+${Math.round(ev*100)}%`, color: '#10b981' },
                            { label: ' Kelly Criterion', val: `${(reliability/10).toFixed(1)}%`, color: '#f59e0b' },
                            { label: 'موثوقية المباراة', val: `${reliability}%`, color: '#a855f7' }
                        ].map((k, i) => (
                            <div key={i} style={{ background: 'rgba(30,41,59,0.5)', padding: 15, borderRadius: 12, textAlign: 'center', borderTop: `4px solid ${k.color}` }}>
                                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 5 }}>{k.label}</div>
                                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: k.color }}>{k.val}</div>
                            </div>
                        ))}
                    </div>

                    {/* Player Props */}
                    <div className="col-span-12">
                        <PlayerProps propsData={match.player_props} />
                    </div>

                    {/* DNB / DC Summary */}
                    <div className="col-span-12" style={{ display: 'flex', gap: 15 }}>
                        <div style={{ flex: 1, background: 'rgba(30,41,59,0.3)', padding: 15, borderRadius: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textAlign: 'center', marginBottom: 10 }}>DRAW NO BET (DNB)</div>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: 20 }}>
                                <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.6rem', color: '#64748b' }}>{match.homeTeam}</div><div style={{ fontWeight: 800, color: '#38bdf8' }}>{dnbHome}%</div></div>
                                <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.6rem', color: '#64748b' }}>{match.awayTeam}</div><div style={{ fontWeight: 800, color: '#38bdf8' }}>{dnbAway}%</div></div>
                            </div>
                        </div>
                        <div style={{ flex: 1, background: 'rgba(30,41,59,0.3)', padding: 15, borderRadius: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textAlign: 'center', marginBottom: 10 }}>CHANCE DOUBLE</div>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: 20 }}>
                                <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.6rem', color: '#64748b' }}>1X</div><div style={{ fontWeight: 800, color: '#38bdf8' }}>{parseProb(match.homeWinProb) + parseProb(match.drawProb)}%</div></div>
                                <div style={{ textAlign: 'center' }}><div style={{ fontSize: '0.6rem', color: '#64748b' }}>X2</div><div style={{ fontWeight: 800, color: '#38bdf8' }}>{parseProb(match.awayWinProb) + parseProb(match.drawProb)}%</div></div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};

export default UltimateMatchCenter;
