import React, { useState, useEffect, useCallback } from 'react';
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend, BarChart, Bar
} from 'recharts';
import { getApiUrl } from '../config/apiConfig';
import './AccuracyLab.css';

// ── تخصيص أداة الشرح (Tooltip) ──────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className="lab-tooltip">
            <p className="lab-tooltip-date">{label}</p>
            {payload.map((p, i) => (
                <p key={i} style={{ color: p.color }}>
                    {p.name === 'Accuracy' ? 'الدقة' : 'الإصابات'}: <strong>{p.value}{p.name === 'Accuracy' ? '%' : ''}</strong>
                </p>
            ))}
        </div>
    );
};

export default function AccuracyLab() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('summary');

    const fetchStats = useCallback(async () => {
        try {
            const res = await fetch(getApiUrl('/api/analytics/accuracy'));
            if (!res.ok) throw new Error(`Error: ${res.status}`);
            const result = await res.json();
            setData(result);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchStats(); }, [fetchStats]);

    const overallAccuracy = data?.history?.length 
        ? Math.round(data.history.reduce((acc, curr) => acc + (curr.accuracy || 0), 0) / data.history.length)
        : 0;

    if (loading) return (
        <div className="lab-loading">
            <div className="lab-loader"></div>
            <p>جارٍ تحليل البيانات التاريخية واستخراج النتائج...</p>
        </div>
    );

    const current = data?.current || {};
    const history = [...(data?.history || [])].reverse();

    return (
        <div className="accuracy-lab">
            {/* Header Area */}
            <div className="lab-header">
                <div className="lab-title">
                    <span className="lab-badge">TITANIUM FEEDBACK</span>
                    <h1>مختبر الدقة والتعلم الآلي</h1>
                    <p>تحليل أداء الذكاء الاصطناعي وتصحيح المسار التلقائي</p>
                </div>
                <div className="lab-stats-quick">
                    <div className="quick-stat">
                        <span className="label">الدقة الإجمالية</span>
                        <span className="val" style={{ color: overallAccuracy > 75 ? '#10b981' : '#f59e0b' }}>
                            {overallAccuracy}%
                        </span>
                    </div>
                </div>
            </div>

            {/* Main Tabs */}
            <div className="lab-tabs">
                <button className={activeTab === 'summary' ? 'active' : ''} onClick={() => setActiveTab('summary')}>
                    📑 ملخص الأداء
                </button>
                <button className={activeTab === 'trend' ? 'active' : ''} onClick={() => setActiveTab('trend')}>
                    📈 اتجاه النمو
                </button>
                <button className={activeTab === 'misses' ? 'active' : ''} onClick={() => setActiveTab('misses')}>
                    🔍 تحليل الأخطاء
                </button>
            </div>

            <div className="lab-content">
                {activeTab === 'summary' && (
                    <div className="lab-summary-grid">
                        <div className="summary-card main">
                            <h3>أداء اليوم المنصرم ({current.date})</h3>
                            <div className="score-ring">
                                <svg viewBox="0 0 36 36" className="circular-chart">
                                    <path className="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <path className="circle" strokeDasharray={`${current.accuracy || 0}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <text x="18" y="20.35" className="percentage">{current.accuracy || 0}%</text>
                                </svg>
                            </div>
                            <div className="summary-details">
                                <div className="det"><span>✅ إصابات:</span> <strong>{current.hits}</strong></div>
                                <div className="det"><span>❌ إخفاقات:</span> <strong>{current.misses}</strong></div>
                                <div className="det"><span>⏳ قيد الانتظار:</span> <strong>{current.pending}</strong></div>
                            </div>
                        </div>

                        <div className="summary-card">
                            <h3>التوزيع حسب الدوريات</h3>
                            <div className="league-mini-list">
                                {(current.leagueTable || []).slice(0, 5).map((l, i) => (
                                    <div key={i} className="league-mini-item">
                                        <span className="n">{l.league}</span>
                                        <span className="p">{l.accuracy}%</span>
                                        <div className="b"><div style={{ width: `${l.accuracy}%` }}></div></div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'trend' && (
                    <div className="lab-chart-container">
                        <h3>منحنى الدقة التاريخي (آخر 7 أيام)</h3>
                        <ResponsiveContainer width="100%" height={300}>
                            <AreaChart data={history}>
                                <defs>
                                    <linearGradient id="colorAcc" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 10}} />
                                <YAxis axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 10}} domain={[0, 100]} />
                                <Tooltip content={<CustomTooltip />} />
                                <Area type="monotone" dataKey="accuracy" name="Accuracy" stroke="#6366f1" fillOpacity={1} fill="url(#colorAcc)" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                )}

                {activeTab === 'misses' && (
                    <div className="lab-misses-container">
                        <h3>قائمة "الفجوات" للتعلم (Gap Learning)</h3>
                        <p className="hint">هذه المباريات تم إرسالها لمحرك التدريب بوزن (5.0x) لتصحيح الخطأ في المرة القادمة.</p>
                        <div className="misses-grid">
                            {(current.missedPredictions || []).map((m, i) => (
                                <div key={i} className="miss-card-v19">
                                    <div className="m-head">
                                        <span className="m-match">{m.match}</span>
                                        <span className="m-score">{m.score}</span>
                                    </div>
                                    <div className="m-verdict">
                                        <div className="v"><span>وقعنا:</span> {m.predicted}</div>
                                        <div className="v"><span>الواقع:</span> {m.actual}</div>
                                    </div>
                                    <div className="m-footer">
                                        ثقة XGBoost: {Math.round((m.xgbConf || 0) * 100)}%
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
