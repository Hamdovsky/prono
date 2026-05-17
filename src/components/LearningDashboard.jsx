import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, RadarChart, Radar, PolarGrid,
    PolarAngleAxis, PolarRadiusAxis, Cell, PieChart, Pie, Legend
} from 'recharts';
import { getApiUrl } from '../config/apiConfig';
import './LearningDashboard.css';

// ── Error type colours ───────────────────────────────────────────────────────
const ERROR_COLORS = {
    CORRECT:              '#10b981',
    WRONG_OUTCOME:        '#ef4444',
    WRONG_GOAL_PRED:      '#f97316',
    UNDERESTIMATED_FACTOR:'#8b5cf6',
    OVERESTIMATED_FACTOR: '#f59e0b',
};
const ERROR_LABELS = {
    CORRECT:              '✅ Correct',
    WRONG_OUTCOME:        '❌ Wrong Outcome',
    WRONG_GOAL_PRED:      '⚽ Wrong Goal Pred',
    UNDERESTIMATED_FACTOR:'📉 Underestimated',
    OVERESTIMATED_FACTOR: '📈 Overestimated',
};

// ── Root cause colours ───────────────────────────────────────────────────────
const CAUSE_COLORS = {
    RED_CARD_IGNORED:        '#ef4444',
    XG_ANOMALY:              '#f59e0b',
    ODDS_MOVEMENT_MISREAD:   '#6366f1',
    INJURY_IGNORED:          '#ec4899',
    LATE_GOAL_DISRUPTION:    '#8b5cf6',
    EARLY_GOAL_DISRUPTION:   '#06b6d4',
    DEFENSIVE_COLLAPSE:      '#dc2626',
    GK_MASTERCLASS:          '#3b82f6',
    BIG_CHANCE_WASTE:        '#f97316',
    POSSESSION_TRAP:         '#84cc16',
    NORMAL_VARIANCE:         '#64748b',
    DATA_POVERTY:            '#374151',
};

const FEATURE_LABELS = {
    form:           '📊 Form',
    xg:             '🎯 xG',
    odds:           '📉 Odds',
    red_card:       '🟥 Red Card',
    injuries:       '🏥 Injuries',
    possession:     '⚽ Possession',
    home_advantage: '🏠 Home Adv.',
    h2h:            '🤝 H2H',
    elo:            '📈 ELO',
    late_goal_risk: '⏱️ Late Goal',
};

// Leagues are now fetched dynamically from the API.
const DEFAULT_LEAGUES = ['Premier League', 'Ligue 1', 'LaLiga', 'Serie A', 'Bundesliga'];

// ── Tag badge ────────────────────────────────────────────────────────────────
const TAG_COLORS = {
    unexpected_upset:       '#ef4444',
    red_card_impact:        '#dc2626',
    overestimated_favorite: '#f59e0b',
    xg_waste:               '#f97316',
    late_goal_drama:        '#8b5cf6',
    gk_hero:                '#3b82f6',
    low_odds_trap:          '#6366f1',
    correct_prediction:     '#10b981',
    friendly_match_noise:   '#64748b',
};

function TagBadge({ tag }) {
    return (
        <span className="ld-tag" style={{ background: TAG_COLORS[tag] || '#374151' }}>
            {(tag || '').replace(/_/g, ' ')}
        </span>
    );
}

// ── Weight radar ─────────────────────────────────────────────────────────────
function WeightRadar({ weights }) {
    const data = Object.entries(weights || {}).map(([k, v]) => ({
        feature: FEATURE_LABELS[k] || k,
        value:   Math.round(v * 100),
        fullMark: 35,
    }));
    return (
        <ResponsiveContainer width="100%" height={280}>
            <RadarChart cx="50%" cy="50%" outerRadius="75%" data={data}>
                <PolarGrid stroke="rgba(255,255,255,0.08)" />
                <PolarAngleAxis dataKey="feature" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <PolarRadiusAxis angle={30} domain={[0, 35]} tick={{ fill: '#64748b', fontSize: 9 }} />
                <Radar name="Weight %" dataKey="value"
                    stroke="#6366f1" fill="#6366f1" fillOpacity={0.35}
                    dot={{ r: 3, fill: '#818cf8' }} />
                <Tooltip formatter={(v) => [`${v}%`, 'Weight']}
                    contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }} />
            </RadarChart>
        </ResponsiveContainer>
    );
}

// ── Error distribution bar ────────────────────────────────────────────────────
function ErrorDistribBar({ distrib }) {
    const data = Object.entries(distrib || {}).map(([k, v]) => ({
        name:  ERROR_LABELS[k] || k,
        count: v,
        color: ERROR_COLORS[k] || '#64748b',
    }));
    if (!data.length) return <div className="ld-empty">No data yet.</div>;
    return (
        <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data} layout="vertical" margin={{ left: 10, right: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <YAxis type="category" dataKey="name" width={145} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {data.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

// ── Cause pie ─────────────────────────────────────────────────────────────────
function CausePie({ distrib }) {
    const data = Object.entries(distrib || {})
        .map(([k, v]) => ({ name: k.replace(/_/g, ' '), value: v, color: CAUSE_COLORS[k] || '#64748b' }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);
    if (!data.length) return <div className="ld-empty">No cause data yet.</div>;
    return (
        <ResponsiveContainer width="100%" height={280}>
            <PieChart>
                <Pie data={data} dataKey="value" nameKey="name"
                    cx="50%" cy="50%" outerRadius={100}
                    label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                >
                    {data.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Legend formatter={(v) => <span style={{ color: '#94a3b8', fontSize: 11 }}>{v}</span>} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }} />
            </PieChart>
        </ResponsiveContainer>
    );
}

// ── Rules table ───────────────────────────────────────────────────────────────
const RULE_TL = {
    'GENERAL_NOISE': 'ضوضاء عامة',
    'DEF_COLLAPSE': 'انهيار دفاعي',
    'ATK_COLLAPSE': 'انهيار هجومي',
    'variance_event': 'حدث عرضي',
    'STRUCTURAL_TEAM_WEAKNESS': 'ضعف بنيوي متكرر (فريق)',
    'no_weight_change_required': 'لا يتطلب تغيير وزن',
    'downgrade_form_weight_in_next_match_same_team': 'خفض مؤشر الفورمة للمباراة القادمة',
    // total_goals >= 5 remains as is if not matched exactly
};
const tl = s => RULE_TL[s] || s;

// ── Rules table ───────────────────────────────────────────────────────────────
function RulesTable({ rules }) {
    if (!rules?.length) return <div className="ld-empty">لا توجد قواعد مستنتجة بعد.</div>;
    return (
        <table className="ld-rules-table" dir="rtl">
            <thead>
                <tr>
                    <th>النوع</th>
                    <th>الشرط</th>
                    <th>الإجراء</th>
                    <th>الثقة</th>
                    <th>التكرار</th>
                </tr>
            </thead>
            <tbody>
                {rules.map((r, i) => (
                    <tr key={i}>
                        <td><span className="ld-rule-type">{tl(r.rule_type)}</span></td>
                        <td className="ld-rule-cond" dir="ltr" style={{textAlign: 'right'}}>{tl(r.condition)}</td>
                        <td className="ld-rule-action">{tl(r.action)}</td>
                        <td>
                            <span className="ld-conf-badge"
                                style={{ color: r.confidence >= 0.7 ? '#10b981' : r.confidence >= 0.55 ? '#f59e0b' : '#ef4444' }}>
                                {Math.round((r.confidence || 0) * 100)}%
                            </span>
                        </td>
                        <td><span className="ld-hit-badge">{r.hit_count || 1}</span></td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

// ── Recent cases feed ─────────────────────────────────────────────────────────
function CasesFeed({ cases, isHistory = false }) {
    if (!cases?.length) return <div className="ld-empty">No cases stored yet. Run the engine on finished matches.</div>;
    return (
        <div className="ld-cases-feed">
            {isHistory && (
                <div className="ld-history-info">
                    📅 Showing last processed matches (No results for selected date yet)
                </div>
            )}
            {cases.map((c, i) => {
                const tags = (() => { try { return JSON.parse(c.tags || '[]'); } catch { return []; } })();
                const isCorrect = c.error_type === 'CORRECT';
                return (
                    <div key={i} className={`ld-case-card ${isCorrect ? 'correct' : 'wrong'}`}>
                        <div className="ld-case-header">
                            <span className="ld-case-teams">{c.home_team} <span className="ld-vs">vs</span> {c.away_team}</span>
                            <span className="ld-case-score">{c.score}</span>
                            <span className={`ld-case-verdict ${isCorrect ? 'ok' : 'fail'}`}>
                                {isCorrect ? '✅ CORRECT' : '❌ WRONG'}
                            </span>
                        </div>
                        <div className="ld-case-meta">
                            <span className="ld-case-league">🏆 {c.league}</span>
                            {c.match_date && <span className="ld-case-date">📅 {c.match_date.split('T')[0]}</span>}
                            <span className="ld-case-conf">Conf: {Math.round(c.confidence || 0)}%</span>
                        </div>
                        <div className="ld-case-analysis">
                            <div className="ld-case-row">
                                <span className="ld-label">Error:</span>
                                <span style={{ color: ERROR_COLORS[c.error_type] || '#94a3b8' }}>
                                    {ERROR_LABELS[c.error_type] || c.error_type}
                                </span>
                            </div>
                            <div className="ld-case-row">
                                <span className="ld-label">Root Cause:</span>
                                <span style={{ color: CAUSE_COLORS[c.root_cause] || '#94a3b8' }}>
                                    {(c.root_cause || '').replace(/_/g, ' ')}
                                </span>
                            </div>
                            {c.context && (
                                <div className="ld-case-context">{c.context}</div>
                            )}
                        </div>
                        {tags.length > 0 && (
                            <div className="ld-case-tags">
                                {tags.map((t, j) => <TagBadge key={j} tag={t} />)}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function LearningDashboard() {
    const [leagues, setLeagues]               = useState(DEFAULT_LEAGUES);
    const [selectedLeague, setSelectedLeague] = useState('ALL');
    const [selectedDate, setSelectedDate]     = useState('');
    const [report, setReport]                 = useState(null);
    const [loadingReport, setLoadingReport]   = useState(false);
    const [processing, setProcessing]         = useState(false);
    const [processMsg, setProcessMsg]         = useState('');
    const [activeTab, setActiveTab]           = useState('overview');
    const [error, setError]                   = useState(null);

    const fetchLeagues = useCallback(async () => {
        try {
            const r = await fetch(getApiUrl('/api/learn/leagues'));
            const data = await r.json();
            if (data.success && data.leagues?.length > 0) {
                setLeagues(data.leagues);
                // If current selected league isn't in new list AND it's not 'ALL', pick first
                if (selectedLeague !== 'ALL' && !data.leagues.includes(selectedLeague)) {
                    setSelectedLeague(data.leagues[0]);
                }
            }
        } catch (e) {
            console.error('Failed to fetch leagues:', e);
        }
    }, [selectedLeague]);

    const fetchReport = useCallback(async (league, date) => {
        if (!league) return;
        setLoadingReport(true);
        setError(null);
        try {
            const cleanLeague = (league === 'ALL') ? 'ALL' : league.trim();
            const url = date 
                ? getApiUrl(`/api/learn/report/${encodeURIComponent(cleanLeague)}?date=${date}`)
                : getApiUrl(`/api/learn/report/${encodeURIComponent(cleanLeague)}`);
            const r = await fetch(url);
            if (!r.ok) throw new Error(`Server responded with ${r.status}`);
            const data = await r.json();
            if (data.success) setReport(data.report);
            else setError(data.error || 'The learning engine is still calibrating for this league.');
        } catch (e) {
            console.error('Learning Fetch Error:', e);
            setError(`Connection Error: ${e.message}`);
        } finally {
            setLoadingReport(false);
        }
    }, []);

    useEffect(() => {
        fetchLeagues();
    }, []); // on mount only

    useEffect(() => { 
        if (selectedLeague) fetchReport(selectedLeague, selectedDate); 
    }, [selectedLeague, selectedDate, fetchReport]);

    const triggerAutoProcess = async () => {
        setProcessing(true);
        setProcessMsg('');
        try {
            const r = await fetch(getApiUrl('/api/learn/auto-process'));
            const data = await r.json();
            setProcessMsg(data.message || `Queued ${data.queued || 0} matches.`);
            setTimeout(() => fetchReport(selectedLeague, selectedDate), 3000);
        } catch (e) {
            setProcessMsg(`Error: ${e.message}`);
        } finally {
            setProcessing(false);
        }
    };

    const accuracy = report?.accuracy ?? null;
    const confAdj  = report?.confidenceAdj ?? 0;
    const totalCases = report?.totalCases ?? 0;
    const weights  = report?.weights ?? {};

    const accuracyColor = accuracy === null ? '#64748b'
        : accuracy >= 0.65 ? '#10b981'
        : accuracy >= 0.50 ? '#f59e0b'
        : '#ef4444';

    const confColor = confAdj > 0 ? '#10b981' : confAdj < 0 ? '#ef4444' : '#64748b';

    return (
        <div className="ld-root">
            {/* ── Header ──────────────────────────────────────────────── */}
            <div className="ld-header">
                <div className="ld-header-info">
                    <span className="ld-header-icon">🧠</span>
                    <div>
                        <h1>Adaptive Learning Engine</h1>
                        <p>Self-correcting AI · Weight evolution · Per-league memory</p>
                    </div>
                </div>
                <div className="ld-header-actions">
                    <button
                        className={`ld-btn ld-btn-primary ${processing ? 'loading' : ''}`}
                        onClick={triggerAutoProcess}
                        disabled={processing}
                    >
                        {processing ? '⏳ Processing…' : '▶ Auto-Learn Finished Matches'}
                    </button>
                    <button className="ld-btn ld-btn-secondary"
                        onClick={() => fetchReport(selectedLeague)}>
                        🔄 Refresh
                    </button>
                </div>
            </div>

            {processMsg && (
                <div className="ld-process-msg">{processMsg}</div>
            )}

            {/* ── League & Date selector ──────────────────────────────────────── */}
            <div className="ld-league-strip">
                <div className="ld-leagues">

                    {leagues.map(l => (
                        <button key={l}
                            className={`ld-league-btn ${selectedLeague === l ? 'active' : ''}`}
                            onClick={() => setSelectedLeague(l)}>
                            {l}
                        </button>
                    ))}
                </div>
                
                <div className="ld-date-picker">
                    <label>📅 Analyse du :</label>
                    <input 
                        type="date" 
                        value={selectedDate} 
                        onChange={(e) => setSelectedDate(e.target.value)}
                    />
                    <button 
                        className={`ld-date-all ${!selectedDate ? 'active' : ''}`}
                        onClick={() => setSelectedDate('')}
                    >
                        Historique Global
                    </button>
                </div>
            </div>

            {error && <div className="ld-error">⚠️ {error}</div>}

            {/* ── KPI strip ────────────────────────────────────────────── */}
            <div className="ld-kpis">
                <div className="ld-kpi" style={{ '--kc': accuracyColor }}>
                    <div className="ld-kpi-value" style={{ color: accuracyColor }}>
                        {typeof accuracy === 'number' ? `${Math.round(accuracy * 100)}%` : '—'}
                    </div>
                    <div className="ld-kpi-label">Accuracy</div>
                </div>
                <div className="ld-kpi" style={{ '--kc': '#6366f1' }}>
                    <div className="ld-kpi-value" style={{ color: '#a5b4fc' }}>{totalCases}</div>
                    <div className="ld-kpi-label">Cases Learned</div>
                </div>
                <div className="ld-kpi" style={{ '--kc': confColor }}>
                    <div className="ld-kpi-value" style={{ color: confColor }}>
                        {confAdj >= 0 ? '+' : ''}{confAdj.toFixed(1)}
                    </div>
                    <div className="ld-kpi-label">Conf. Δ Adjustment</div>
                </div>
                <div className="ld-kpi" style={{ '--kc': '#f59e0b' }}>
                    <div className="ld-kpi-value" style={{ color: '#fbbf24' }}>
                        {report?.topRules?.length ?? 0}
                    </div>
                    <div className="ld-kpi-label">Active Rules</div>
                </div>
            </div>

            {/* ── Tabs ─────────────────────────────────────────────────── */}
            <div className="ld-tabs">
                {[
                    { id: 'overview',  label: '🧬 الأوزان' },
                    { id: 'errors',    label: '❌ أنواع الأخطاء' },
                    { id: 'causes',    label: '🔎 الأسباب الجذرية' },
                    { id: 'rules',     label: '📋 القواعد' },
                    { id: 'cases',     label: '📁 الحالات' },
                ].map(t => (
                    <button key={t.id}
                        className={`ld-tab ${activeTab === t.id ? 'active' : ''}`}
                        onClick={() => setActiveTab(t.id)}>
                        {t.label}
                    </button>
                ))}
            </div>

            {loadingReport && (
                <div className="ld-loading">
                    <div className="ld-spinner" />
                    <span>Fetching learning data for {selectedLeague}…</span>
                </div>
            )}

            {!loadingReport && report && (
                <div className="ld-content">

                    {/* ── WEIGHTS TAB ───────────────────────────────────── */}
                    {activeTab === 'overview' && (
                        <div className="ld-panel">
                            <div className="ld-panel-title">
                                🧬 Adaptive Feature Weights — <em>{selectedLeague}</em>
                                <span className="ld-panel-sub">Radar shows % importance of each signal</span>
                            </div>
                            <div className="ld-two-col">
                                <div className="ld-col">
                                    <WeightRadar weights={weights} />
                                </div>
                                <div className="ld-col ld-weights-list">
                                    {Object.entries(weights)
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([k, v]) => (
                                        <div key={k} className="ld-weight-row">
                                            <span className="ld-weight-label">
                                                {FEATURE_LABELS[k] || k}
                                            </span>
                                            <div className="ld-weight-bar-wrap">
                                                <div className="ld-weight-bar"
                                                    style={{ width: `${Math.round(v * 100)}%` }} />
                                            </div>
                                            <span className="ld-weight-pct">{Math.round(v * 100)}%</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── ERRORS TAB ────────────────────────────────────── */}
                    {activeTab === 'errors' && (
                        <div className="ld-panel">
                            <div className="ld-panel-title">
                                ❌ Error Type Distribution
                                <span className="ld-panel-sub">How the model fails in this league</span>
                            </div>
                            <ErrorDistribBar distrib={report.errorDistrib} />
                            <div className="ld-error-pills">
                                {Object.entries(report.errorDistrib || {}).map(([k, v]) => (
                                    <div key={k} className="ld-error-pill"
                                        style={{ borderColor: ERROR_COLORS[k] || '#374151' }}>
                                        <span style={{ color: ERROR_COLORS[k] || '#94a3b8' }}>
                                            {ERROR_LABELS[k] || k}
                                        </span>
                                        <strong>{v}</strong>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ── CAUSES TAB ───────────────────────────────────── */}
                    {activeTab === 'causes' && (
                        <div className="ld-panel">
                            <div className="ld-panel-title">
                                🔎 Root Cause Taxonomy
                                <span className="ld-panel-sub">Why predictions failed</span>
                            </div>
                            <CausePie distrib={report.causeDistrib} />
                        </div>
                    )}

                    {/* ── RULES TAB ────────────────────────────────────── */}
                    {activeTab === 'rules' && (
                        <div className="ld-panel">
                            <div className="ld-panel-title">
                                📋 قواعد القرار المستنتجة
                                <span className="ld-panel-sub">مستخرجة آلياً من تحليل الأنماط المتكررة</span>
                            </div>
                            <RulesTable rules={report.topRules} />
                        </div>
                    )}

                    {/* ── CASES TAB ────────────────────────────────────── */}
                    {activeTab === 'cases' && (
                        <div className="ld-panel">
                            <div className="ld-panel-title">
                                📁 Recent Learning Cases
                                <span className="ld-panel-sub">Recent system activity & processed matches</span>
                            </div>
                            <CasesFeed 
                                cases={selectedDate ? (report.recentCases || []) : (report.allRecentCases || [])} 
                                isHistory={!selectedDate} 
                            />
                        </div>
                    )}

                </div>
            )}

            {!loadingReport && !report && !error && (
                <div className="ld-empty-state">
                    <div className="ld-empty-icon">🧠</div>
                    <h3>No learning data yet for {selectedLeague}</h3>
                    <p>Click <strong>Auto-Learn Finished Matches</strong> to start the engine.</p>
                </div>
            )}
        </div>
    );
}
