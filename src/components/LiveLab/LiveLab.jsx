import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './LiveLab.css';

const SOCKET_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:5000' 
    : window.location.origin.replace(/:\d+$/, ':5000');

const CAT_INFO = {
    LIVE: { badge: 'مباشر', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)', border: 'rgba(239, 68, 68, 0.2)' },
    STATS: { badge: 'إحصائيات', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.1)', border: 'rgba(59, 130, 246, 0.2)' },
    SCHEDULED: { badge: 'مجدولة', color: '#10b981', bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.2)' }
};

function usePrevious(value) {
    const ref = useRef();
    useEffect(() => {
        ref.current = value;
    });
    return ref.current;
}

const AnimatedStat = ({ val, prevVal, className, isScore, style }) => {
    let flashClass = '';
    if (prevVal !== undefined && prevVal !== null && val !== prevVal) {
        if (isScore) flashClass = 'flash-score';
        else if (val > prevVal) flashClass = 'flash-up';
        else if (val < prevVal) flashClass = 'flash-down';
    }
    return <span className={`${className} ${flashClass}`} style={style} key={val}>{val}</span>;
};

const MatchCard = ({ m }) => {
    const prevM = usePrevious(m);
    const cat = CAT_INFO[m.category] || CAT_INFO.SCHEDULED;
    const hasLiveStats = (m.stats?.dangerousAttacks?.home + m.stats?.dangerousAttacks?.away) > 0;
    const staleSecs = m.staleSecs;

    return (
        <div className="ll-card">
            <div className="ll-card-top">
                <span className="ll-league">{m.league}</span>
                <span className={`ll-cat ${m.category === 'LIVE' ? 'pulse' : ''}`}
                    style={{color:cat.color, background:cat.bg, borderColor:cat.border}}>
                    {cat.badge}
                </span>
            </div>

            <div className="ll-teams">
                <div className="ll-team">
                    <span className="ll-team-name">{m.homeTeam}</span>
                    <AnimatedStat val={m.scoreHome} prevVal={prevM?.scoreHome} className="ll-score" isScore={true} />
                </div>
                <div className="ll-vs">
                    {m.minute ? <span className="ll-min">{m.minute}'</span> : <span>ضد</span>}
                </div>
                <div className="ll-team">
                    <AnimatedStat val={m.scoreAway} prevVal={prevM?.scoreAway} className="ll-score" isScore={true} />
                    <span className="ll-team-name">{m.awayTeam}</span>
                </div>
            </div>

            {staleSecs !== null && (
                <div className="ll-freshness">
                    <span className={staleSecs < 60 ? 'fresh' : staleSecs < 120 ? 'warm' : 'stale'}>
                        {staleSecs < 5 ? '⚡ مباشر' : staleSecs < 60 ? `🟢 ${staleSecs}ث` : `🔴 ${Math.round(staleSecs/60)}د`}
                    </span>
                </div>
            )}

            <div className="ll-ai-strip">
                <div className="ll-ai-item">
                    <span className="ll-ai-lbl">🏠 فوز ح</span>
                    <div><AnimatedStat val={m.homeWinP} prevVal={prevM?.homeWinP} className="ll-ai-val" />%</div>
                </div>
                <div className="ll-ai-item">
                    <span className="ll-ai-lbl">🤝 تعادل</span>
                    <div><AnimatedStat val={m.drawP} prevVal={prevM?.drawP} className="ll-ai-val" />%</div>
                </div>
                <div className="ll-ai-item">
                    <span className="ll-ai-lbl">✈️ فوز ض</span>
                    <div><AnimatedStat val={m.awayWinP} prevVal={prevM?.awayWinP} className="ll-ai-val" />%</div>
                </div>
                <div className="ll-ai-item highlight">
                    <span className="ll-ai-lbl">🎯 ثقة</span>
                    <div><AnimatedStat val={m.confidence} prevVal={prevM?.confidence} className="ll-ai-val" />%</div>
                </div>
            </div>

            {m.dnaInsight && (
                <div className="ll-dna-insight">
                    🧬 {m.dnaInsight}
                </div>
            )}

            {m.statsbombInsight && (m.statsbombInsight.home || m.statsbombInsight.away) && (
                <div style={{margin: '0 10px 10px 10px', padding: '10px', background: 'rgba(234, 179, 8, 0.08)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: '6px', fontSize: '0.75rem', color: '#fef08a'}}>
                    <strong style={{display: 'block', marginBottom: '6px'}}>📊 التحليل التاريخي العميق (StatsBomb):</strong>
                    {m.statsbombInsight.home && <div style={{marginBottom: '4px'}}><strong>{m.homeTeam}:</strong> {m.statsbombInsight.home}</div>}
                    {m.statsbombInsight.away && <div><strong>{m.awayTeam}:</strong> {m.statsbombInsight.away}</div>}
                </div>
            )}

            {hasLiveStats && (
                <div className="ll-momentum-wave">
                    <div className="ll-wave-label">زخم الهجوم (آخر 15 دقيقة)</div>
                    <div className="ll-wave-container">
                        <div className="ll-wave-bar home" style={{height: `${m.momentum.homePercent * 0.6}%`}}></div>
                        <div className="ll-wave-bar away" style={{height: `${m.momentum.awayPercent * 0.6}%`}}></div>
                    </div>
                </div>
            )}

            {hasLiveStats && (
                <div className="ll-stats">
                    <div className="ll-stat-row">
                        <AnimatedStat val={m.stats.dangerousAttacks.home} prevVal={prevM?.stats.dangerousAttacks.home} className="ll-sv home" />
                        <span className="ll-sl">⚔️ هجمات خطيرة</span>
                        <AnimatedStat val={m.stats.dangerousAttacks.away} prevVal={prevM?.stats.dangerousAttacks.away} className="ll-sv away" />
                    </div>
                    <div className="ll-stat-row">
                        <AnimatedStat val={m.stats.shotsOnTarget.home} prevVal={prevM?.stats.shotsOnTarget.home} className="ll-sv home" />
                        <span className="ll-sl">🎯 تسديدات</span>
                        <AnimatedStat val={m.stats.shotsOnTarget.away} prevVal={prevM?.stats.shotsOnTarget.away} className="ll-sv away" />
                    </div>
                    <div className="ll-stat-row xg-row">
                        <AnimatedStat val={m.stats.xg.home} prevVal={prevM?.stats.xg.home} className="ll-sv home" />
                        <span className="ll-sl">📈 الأهداف المتوقعة (xG)</span>
                        <AnimatedStat val={m.stats.xg.away} prevVal={prevM?.stats.xg.away} className="ll-sv away" />
                    </div>

                    {/* --- V26 6-LAYER TI INDICATORS --- */}
                    <div className="ll-6layer-header">
                        <div className="ll-ti-grid">
                            <div className="ll-ti-box">
                                <span className="ll-ti-label">قوة العودة (Recovery)</span>
                                <span className="ll-ti-value recovery">{m.recoveryRate}%</span>
                            </div>
                            <div className="ll-ti-box">
                                <span className="ll-ti-label">انحراف xG (Deviation)</span>
                                <span className="ll-ti-value deviation">{m.xgDeviation.home > 0 ? `+${m.xgDeviation.home}` : m.xgDeviation.home}H</span>
                                <div className={`luck-indicator ${m.xgDeviation.verdict.includes('Over') ? 'luck' : m.xgDeviation.verdict.includes('Under') ? 'unluck' : 'normal'}`}>
                                    {m.xgDeviation.verdict.includes('Over') ? '⚠️ محظوظ' : m.xgDeviation.verdict.includes('Under') ? '❌ منحوس' : '✅ واقعي'}
                                </div>
                            </div>
                        </div>
                    </div>

                    {m.nextGoalEstimate && (
                        <div className="ll-goal-estimate">
                            ⚠️ هدف متوقع خلال {m.nextGoalEstimate} دقائق
                        </div>
                    )}
                </div>
            )}

            {m.pronostics && (m.pronostics.bets || Array.isArray(m.pronostics)) && (
                <div className="ll-pronostics">
                    <div className="ll-prono-title">💎 تحليل عسكري (6 طبقات)</div>
                    
                    {/* Strategic Orientation Table */}
                    {m.pronostics.strategicOrientation && (
                        <div className="ll-orient-table">
                            <div className="ll-orient-row">
                                <span className="ll-orient-key">Conf. Score</span>
                                <span className="ll-orient-val">{m.pronostics.strategicOrientation.confidenceScore}%</span>
                            </div>
                            <div className="ll-orient-row">
                                <span className="ll-orient-key">Risk Level</span>
                                <span className={`ll-orient-val ${m.pronostics.strategicOrientation.riskLevel.toLowerCase()}`}>
                                    {m.pronostics.strategicOrientation.riskLevel}
                                </span>
                            </div>
                            <div className="ll-orient-row">
                                <span className="ll-orient-key">Market</span>
                                <span className="ll-orient-val">{m.pronostics.strategicOrientation.suggestedMarket}</span>
                            </div>
                        </div>
                    )}

                    {(m.pronostics.bets || m.pronostics).map((p, i) => (
                        <div key={i} className="ll-prono-item" style={{borderRight: `3px solid ${p.color || '#475569'}`}}>
                            <div className="ll-prono-head">
                                <span className="ll-prono-icon">{p.icon}</span>
                                <div className="ll-prono-market-group">
                                    <span className="ll-prono-market">{p.market}</span>
                                    <div className="ll-prono-tags">
                                        {p.status && (
                                            <span className={`ll-prono-status ${p.status.includes('نخبة') ? 'elite' : p.status.includes('قيمة') ? 'value' : ''}`} 
                                                style={{color: p.status.includes('نخبة') || p.status.includes('قيمة') ? undefined : (p.color || '#94a3b8')}}>
                                                {p.status}
                                            </span>
                                        )}
                                        {p.matchState && (
                                            <span className="ll-prono-state">{p.matchState}</span>
                                        )}
                                    </div>
                                </div>
                                <div style={{display: 'flex', alignItems: 'center'}}>
                                    <AnimatedStat val={p.probability} prevVal={prevM?.pronostics?.bets?.[i]?.probability || prevM?.pronostics?.[i]?.probability} className="ll-prono-prob" style={{color: p.color || '#f8fafc'}} />%
                                </div>
                            </div>
                            <div className="ll-prono-reason">{p.reason}</div>
                            {p.criticalAlert && (
                                <div className="ll-critical-alert">
                                    <strong>🚨 تنبيه كوانتي:</strong> {p.criticalAlert}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};


const LiveLab = () => {
    const [matches, setMatches] = useState([]);
    const [loading, setLoading] = useState(true);
    const [socketConnected, setSocketConnected] = useState(false);
    const [lastUpdate, setLastUpdate] = useState(null);
    const [filter, setFilter] = useState('ALL');

    useEffect(() => {
        const socket = io(SOCKET_URL, {
            transports: ['websocket', 'polling']
        });

        socket.on('connect', () => {
            console.log('✅ [SOCKET] Connected for Live Lab');
            setSocketConnected(true);
        });

        socket.on('disconnect', () => {
            setSocketConnected(false);
        });

        socket.on('live:update', (data) => {
            if (Array.isArray(data)) {
                setMatches(data);
                setLastUpdate(new Date());
                setLoading(false);
            }
        });

        const fetchInitial = async () => {
            try {
                const res = await fetch('/api/live-lab');
                const data = await res.json();
                setMatches(data);
                setLastUpdate(new Date());
                setLoading(false);
            } catch (err) {
                console.error('❌ Error fetching Live Lab:', err);
                setLoading(false);
            }
        };

        fetchInitial();
        return () => socket.disconnect();
    }, []);

    const filteredMatches = matches.filter(m => {
        if (filter === 'ALL') return true;
        if (filter === 'ELITE') return m.pronostics?.some(p => p.status?.includes('نخبة'));
        if (filter === 'VALUE') return m.pronostics?.some(p => p.type === 'VALUE');
        if (filter === 'GOALS') return m.pronostics?.some(p => p.type === 'GOALS' || p.market?.includes('هدف'));
        return true;
    });

    if (loading) return <div className="ll-loading">جاري المزامنة مع خوادم البيانات...</div>;

    return (
        <div className="live-lab-container" dir="rtl">
            <div className="ll-header">
                <div className="ll-title-row">
                    <h1>مختبر التحليل الكوانتي <span>Elite V38</span></h1>
                    <div className="ll-header-meta">
                        <span className={`ll-socket-status ${socketConnected ? 'online' : 'offline'}`}>
                            {socketConnected ? '🟢 متصل لحظياً' : '🔴 جاري إعادة الاتصال'}
                        </span>
                        {lastUpdate && <span className="ll-last-ts">آخر تحديث: {lastUpdate.toLocaleTimeString('ar-EG')}</span>}
                    </div>
                </div>
                
                <div className="ll-filters">
                    <button className={filter === 'ALL' ? 'active' : ''} onClick={() => setFilter('ALL')}>الكل</button>
                    <button className={filter === 'ELITE' ? 'active' : ''} onClick={() => setFilter('ELITE')}>🔥 النخبة</button>
                    <button className={filter === 'VALUE' ? 'active' : ''} onClick={() => setFilter('VALUE')}>💰 القيمة</button>
                    <button className={filter === 'GOALS' ? 'active' : ''} onClick={() => setFilter('GOALS')}>⚽ أهداف</button>
                </div>
            </div>

            <div className="ll-grid">
                {filteredMatches.map(m => (
                    <MatchCard key={m.id} m={m} />
                ))}
            </div>
        </div>
    );
};

export default LiveLab;
