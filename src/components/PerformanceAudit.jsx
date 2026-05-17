import React, { useState, useEffect } from 'react';
import './PerformanceAudit.css';

const PerformanceAudit = () => {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/audit/performance')
            .then(res => res.json())
            .then(data => {
                setStats(data);
                setLoading(false);
            })
            .catch(err => {
                console.error('Audit Load Error:', err);
                setLoading(false);
            });
    }, []);

    if (loading) return <div className="audit-loading">جاري تدقيق أداء النظام (8 مراحل)... 📉</div>;
    if (!stats) return <div className="audit-error">فشل تحميل تقرير الأداء.</div>;

    const { global, markets, leagues, timing, signals, errors, evaluation } = stats;

    return (
        <div className="performance-audit-container" dir="rtl">
            <header className="audit-header">
                <div className="rating-circle">
                    <span className="rating-val">{evaluation.rating}</span>
                    <span className="rating-lbl">التقييم العام</span>
                </div>
                <div className="header-text">
                    <h1>تدقيق أداء الذكاء الاصطناعي <span>Alpha V40</span></h1>
                    <p>تحليل إحصائي شامل لـ {global.total} توقع تاريخي</p>
                </div>
            </header>

            <div className="audit-grid">
                {/* 1. Global Performance */}
                <section className="audit-card global-stats">
                    <h3>📈 الأداء الإجمالي</h3>
                    <div className="stat-bars">
                        <div className="stat-bar-item">
                            <div className="bar-label">الدقة العالمية: {global.accuracy}%</div>
                            <div className="bar-bg"><div className="bar-fill" style={{width: `${global.accuracy}%`}}></div></div>
                        </div>
                        <div className="stat-row-mini">
                            <span>✅ صحيح: {global.correct}</span>
                            <span>❌ خاطئ: {global.wrong}</span>
                        </div>
                    </div>
                </section>

                {/* 2. Market Accuracy */}
                <section className="audit-card market-stats">
                    <h3>🎯 دقة الأسواق</h3>
                    <div className="market-list">
                        {Object.entries(markets).map(([key, val]) => (
                            <div className="market-item" key={key}>
                                <span className="m-name">{key}</span>
                                <span className="m-acc">{val.accuracy}%</span>
                                <div className="m-total">{val.total} إشارة</div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 3. Time Analysis */}
                <section className="audit-card timing-stats">
                    <h3>⏱️ التحليل الزمني</h3>
                    <div className="timing-list">
                        {Object.values(timing).map((t, i) => (
                            <div className="timing-item" key={i}>
                                <span className="t-label">{t.label}</span>
                                <span className="t-acc" style={{color: t.accuracy > 70 ? '#10b981' : '#f59e0b'}}>{t.accuracy}%</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 4. League DNA Leaderboard */}
                <section className="audit-card league-dna">
                    <h3>🧬 بصمة الدوريات (الأداء)</h3>
                    <div className="dna-split">
                        <div className="dna-col">
                            <h4>🏆 الأفضل أداءً</h4>
                            {leagues.best.map((l, i) => <div key={i} className="dna-rank">⭐ {l.league} ({Math.round((l.correct/l.total)*100)}%)</div>)}
                        </div>
                        <div className="dna-col">
                            <h4>⚠️ الأضعف أداءً</h4>
                            {leagues.worst.map((l, i) => <div key={i} className="dna-rank red">🚩 {l.league} ({Math.round((l.correct/l.total)*100)}%)</div>)}
                        </div>
                    </div>
                </section>

                {/* 5. Error Patterns */}
                <section className="audit-card error-patterns">
                    <h3>🔎 تشريح الأخطاء (Patterns)</h3>
                    <div className="pattern-list">
                        {errors.map((e, i) => (
                            <div className="pattern-item" key={i}>
                                <span className="p-title">{e.pattern}</span>
                                <span className={`p-freq ${e.frequency === 'مرتفع' ? 'high' : ''}`}>{e.frequency}</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 6. Improvement Plan */}
                <section className="audit-card improvement-plan">
                    <h3>🚀 خطة التحسين المقترحة</h3>
                    <ul className="rec-list">
                        {evaluation.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                </section>

                {/* 7. Critical Issues */}
                <section className="audit-card critical-issues full-width">
                    <h3>🚩 قضايا حرجة (Critical Issues)</h3>
                    <div className="issues-flex">
                        {evaluation.weaknesses.map((w, i) => (
                            <div className="issue-tag" key={i}>⚠️ {w}</div>
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
};

export default PerformanceAudit;
