import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, BarChart, Bar, Cell, Legend,
    PieChart, Pie, Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from 'recharts';
import { getApiUrl } from '../config/apiConfig';
import './AccuracyDashboard.css';

// ── Utilities ─────────────────────────────────────────────────────────────────
function getAccColor(pct) {
    if (pct === null || pct === undefined) return '#444';
    if (pct >= 70) return '#10b981';
    if (pct >= 55) return '#f59e0b';
    return '#ef4444';
}

function getRoiColor(roi) {
    if (roi > 0)  return '#10b981';
    if (roi < 0)  return '#ef4444';
    return '#94a3b8';
}

const AUTOPSY_COLORS = {
    XG_WASTE:                    '#f59e0b',
    GK_WALL:                     '#3b82f6',
    LATE_GOAL:                   '#8b5cf6',
    PERSONNEL_DEFICIT_DISRUPTION:'#ef4444',
    SYSTEMIC_DEFENSIVE_FAILURE:  '#dc2626',
    BIG_CHANCE_WASTE:            '#f97316',
    EARLY_TACTICAL_DISRUPTION:   '#06b6d4',
    SET_PIECE_DECIDER:           '#10b981',
    SHOT_DOMINANCE:              '#a855f7',
    CORNER_DOMINANCE:            '#ec4899',
    LOW_INTENSITY_OFFENSE:       '#64748b',
    POSSESSION_FAIL:             '#84cc16',
    UNKNOWN:                     '#374151',
};

const AUTOPSY_AR = {
    XG_WASTE:                    'رعونة هجومية (xG)',
    GK_WALL:                     'جدار الحارس',
    LATE_GOAL:                   'هدف قاتل',
    PERSONNEL_DEFICIT_DISRUPTION:'طرد مبكر',
    SYSTEMIC_DEFENSIVE_FAILURE:  'انهيار دفاعي',
    BIG_CHANCE_WASTE:            'تضييع فرص',
    EARLY_TACTICAL_DISRUPTION:   'صدمة مبكرة',
    SET_PIECE_DECIDER:           'ركلة جزاء',
    SHOT_DOMINANCE:              'تسديدات عقيمة',
    CORNER_DOMINANCE:            'ركنيات عقيمة',
    LOW_INTENSITY_OFFENSE:       'عقم هجومي',
    POSSESSION_FAIL:             'استحواذ سلبي',
    UNKNOWN:                     'قابل للتقلب',
};

// ── Surgical Report Component ─────────────────────────────────────────────────
const SurgicalAutopsy = ({ data }) => {
    if (!data || !data.surgicalStats) return null;

    const stats = data.surgicalStats;
    const chartData = [
        { subject: 'xG',      A: 100, B: Math.min(150, (stats.expectedGoals.home + stats.expectedGoals.away) * 40), fullMark: 150 },
        { subject: 'SoT',     A: 100, B: Math.min(150, (stats.shotsOnTarget.home + stats.shotsOnTarget.away) * 15), fullMark: 150 },
        { subject: 'Poss',    A: 100, B: Math.max(stats.possession.home, stats.possession.away) * 2, fullMark: 150 },
        { subject: 'Corners', A: 100, B: Math.min(150, (stats.corners.home + stats.corners.away) * 10), fullMark: 150 },
        { subject: 'Chances', A: 100, B: Math.min(150, (stats.bigChances.home + stats.bigChances.away) * 30), fullMark: 150 },
    ];

    return (
        <div className="surgical-report animate-in">
            <div className="surgical-grid">
                <div className="surgical-radar">
                    <ResponsiveContainer width="100%" height={220}>
                        <RadarChart cx="50%" cy="50%" outerRadius="80%" data={chartData}>
                            <PolarGrid stroke="rgba(255,255,255,0.1)" />
                            <PolarAngleAxis dataKey="subject" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                            <Radar name="الواقع" dataKey="B" stroke="#ef4444" fill="#ef4444" fillOpacity={0.6} />
                            <Radar name="الخطة" dataKey="A" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
                        </RadarChart>
                    </ResponsiveContainer>
                </div>
                <div className="surgical-details">
                    <h5 className="surgical-title">🩸 خط زمني للإخفاق التكتيكي</h5>
                    <div className="surgical-timeline">
                        {data.criticalIncidents?.length > 0 ? data.criticalIncidents.map((inc, idx) => (
                            <div key={idx} className="timeline-item">
                                <span className="timeline-time">{inc.time}'</span>
                                <span className="timeline-icon">
                                    {(inc.type || inc.incidentClass || '').toLowerCase().includes('goal') ? '⚽' : 
                                     (inc.type || inc.incidentClass || '').toLowerCase().includes('card') ? '🟥' : '🎯'}
                                </span>
                                <span className="timeline-text">{inc.isHome ? '🏠' : '✈️'} {inc.text || inc.incidentClass}</span>
                            </div>
                        )) : <div className="acc-empty">لا توجد حوادث حرجة مسجلة.</div>}
                    </div>
                </div>
            </div>
            <div className="surgical-footer">
                <span className="surgical-badge">AI CLINICAL VERDICT: {data.autopsy?.type || 'UNKNOWN'}</span>
                <p className="surgical-tip">💡 نصيحة النظام: تكرر هذا الإخفاق في هذا الدوري المتقلب؛ يفضل استخدام Double Chance مستقبلاً.</p>
            </div>
        </div>
    );
};

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function AccuracyDashboard() {
    const [log, setLog]             = useState(null);
    const [loading, setLoading]     = useState(true);
    const [running, setRunning]     = useState(false);
    const [error, setError]         = useState(null);
    const [activeTab, setActiveTab] = useState('trend');
    const [autopsyData, setAutopsyData] = useState(null);
    const [expandedMiss, setExpandedMiss] = useState(null);

    const fetchLog = useCallback(async () => {
        try {
            const [accRes, autopsyRes] = await Promise.all([
                fetch(getApiUrl('/api/accuracy')),
                fetch(getApiUrl('/api/autopsy/report')).catch(() => null)
            ]);
            if (!accRes.ok) throw new Error(`HTTP ${accRes.status}`);
            const data = await accRes.json();
            setLog(data);
            if (autopsyRes?.ok) {
                const autopsy = await autopsyRes.json();
                setAutopsyData(autopsy);
            }
            setError(null);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchLog(); }, [fetchLog]);

    const runNow = async () => {
        setRunning(true);
        try {
            const res  = await fetch(getApiUrl('/api/accuracy/run'), { method: 'POST' });
            const data = await res.json();
            if (data.success) await fetchLog();
        } catch (e) { setError(e.message); }
        finally { setRunning(false); }
    };

    // ── Derived stats ──
    const entries = useMemo(() => log?.entries || [], [log]);
    const last30  = useMemo(() => [...entries].slice(0, 30).reverse(), [entries]);
    const overallAcc = useMemo(() => {
        const hits = entries.reduce((s, e) => s + (e.hits || 0), 0);
        const misses = entries.reduce((s, e) => s + (e.misses || 0), 0);
        return (hits + misses) > 0 ? Math.round((hits / (hits + misses)) * 100) : 0;
    }, [entries]);

    return (
        <div className="acc-dashboard" dir="rtl">
            <div className="acc-header">
                <div className="acc-header-title">
                    <span className="acc-icon">🧪</span>
                    <div>
                        <h1>تشريح الأداء والموثوقية (V2)</h1>
                        <p>نظام التدقيق الرقمي لما بعد المباراة · {entries.length} يوم</p>
                    </div>
                </div>
                <button className={`acc-run-btn ${running ? 'running' : ''}`} onClick={runNow} disabled={running}>
                    {running ? 'جارٍ التدقيق…' : '▶ تحديث التشريح'}
                </button>
            </div>

            <div className="acc-kpis">
                <div className="acc-kpi highlight" style={{ '--kpi-color': getAccColor(overallAcc) }}>
                    <div className="acc-kpi-value">{overallAcc}%</div>
                    <div className="acc-kpi-label">دقة النموذج الوراثي</div>
                </div>
                {/* Simplified KPIs for focus */}
                <div className="acc-kpi" style={{ '--kpi-color': '#10b981' }}>
                    <div className="acc-kpi-value">+{entries.reduce((s,e)=>s+(e.roi||0),0).toFixed(1)}</div>
                    <div className="acc-kpi-label">إجمالي الربح (وحدات)</div>
                </div>
                <div className="acc-kpi" style={{ '--kpi-color': '#ef4444' }}>
                    <div className="acc-kpi-value">{autopsyData?.failedCount || 0}</div>
                    <div className="acc-kpi-label">إخفاقات تم تشريحها</div>
                </div>
            </div>

            <div className="acc-tabs">
                {['trend', 'leagues', 'autopsy', 'misses'].map(id => (
                    <button key={id} className={`acc-tab ${activeTab === id ? 'active' : ''}`} onClick={() => setActiveTab(id)}>
                        {id === 'trend' ? '📈 المنحنى' : id === 'leagues' ? '🏆 الدوريات' : id === 'autopsy' ? '🔬 التشريح' : '❌ الأخطاء'}
                    </button>
                ))}
            </div>

            {/* Render Logic */}
            {activeTab === 'trend' && (
                <div className="acc-chart-card">
                    <h3>📈 تطور المحفظة (الربح التاريخي المتراكم)</h3>
                    <ResponsiveContainer width="100%" height={300}>
                        <AreaChart data={last30}>
                            <defs>
                                <linearGradient id="rGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/><stop offset="95%" stopColor="#10b981" stopOpacity={0}/></linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="date" tick={{fontSize: 10}} />
                            <YAxis />
                            <Tooltip />
                            <Area type="monotone" dataKey="cumulativeRoi" stroke="#10b981" fill="url(#rGrad)" strokeWidth={3} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            )}

            {activeTab === 'autopsy' && (
                <div className="acc-chart-card">
                    <h3>🔬 توزيع مسببات الفشل (Surgical Breakdown)</h3>
                    <div className="acc-autopsy-layout">
                        {/* Summary of reasons */}
                        <div className="acc-misses-feed" style={{ width: '100%', maxHeight: '400px' }}>
                            {autopsyData?.report?.slice(0, 20).map((m, i) => (
                                <div key={i} className={`acc-miss-entry ${expandedMiss === m.id ? 'expanded' : ''}`} onClick={() => setExpandedMiss(expandedMiss === m.id ? null : m.id)}>
                                    <div className="acc-miss-main">
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <span className="acc-autopsy-dot" style={{ background: AUTOPSY_COLORS[m.autopsy?.type] || '#6b7280', margin: 0 }} />
                                            <span className="acc-miss-teams">{m.homeTeam} × {m.awayTeam}</span>
                                        </div>
                                        <span className="acc-miss-score">{m.score}</span>
                                    </div>
                                    <div className="acc-miss-tactical">
                                        <span className="acc-miss-icon">{m.autopsy?.icon || '⚠️'}</span>
                                        <span className="acc-miss-desc">{m.autopsy?.ar || 'تحليل معلق...'}</span>
                                    </div>
                                    {expandedMiss === m.id && <SurgicalAutopsy data={m} />}
                                    <div className="acc-miss-meta">
                                         ثقة AI: {m.confidence}% · {m.prediction} · اضغط للتفاصيل الجراحية 🔍
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
