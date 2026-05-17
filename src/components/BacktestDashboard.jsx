import React, { useState } from 'react';
import './BacktestDashboard.css';

const BacktestDashboard = () => {
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [limit, setLimit] = useState(200);
    const [period, setPeriod] = useState('all');

    const runBacktest = () => {
        setLoading(true);
        fetch(`/api/backtest?limit=${limit}&period=${period}`)
            .then(res => {
                if (!res.ok) throw new Error(`Server Error: ${res.status}`);
                const contentType = res.headers.get("content-type");
                if (!contentType || !contentType.includes("application/json")) {
                    throw new Error("Received non-JSON response from server. Please restart the backend.");
                }
                return res.json();
            })
            .then(data => {
                setResults(data);
                setLoading(false);
            })
            .catch(err => {
                console.error('Backtest Error:', err);
                setResults({ error: err.message });
                setLoading(false);
            });
    };

    return (
        <div className="backtest-container" dir="rtl">
            <header className="backtest-header">
                <div className="bt-title">
                    <h1>محاكي الاختبار التاريخي (Backtest) <span>Alpha V41</span></h1>
                    <p>اختبر كفاءة الخوارزمية على أرشيف المباريات المنتهية</p>
                </div>
                <div className="bt-controls">
                    <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                        <option value="all">كل الأوقات</option>
                        <option value="1m">آخر شهر</option>
                        <option value="3m">آخر 3 أشهر</option>
                        <option value="1y">آخر سنة</option>
                    </select>
                    <input 
                        type="number" 
                        value={limit} 
                        onChange={(e) => setLimit(e.target.value)} 
                        min="50" max="1000"
                        title="عدد المباريات"
                    />
                    <button onClick={runBacktest} disabled={loading}>
                        {loading ? 'جاري المحاكاة...' : 'ابدأ الاختبار العكسي'}
                    </button>
                </div>
            </header>

            {!results && !loading && (
                <div className="bt-empty">
                    <div className="bt-icon">📜</div>
                    <h3>جاهز لبدء المحاكاة</h3>
                    <p>اختر عدد المباريات التاريخية التي ترغب في تحليلها واضغط على الزر أعلاه.</p>
                </div>
            )}

            {loading && <div className="bt-loading">جاري تحليل البيانات ومقارنة التوقعات بالنتائج الفعلية... ⏳</div>}

            {results && !results.error && (
                <div className="bt-grid">
                    {/* Summary Cards */}
                    <div className="bt-card highlight">
                        <span className="bt-l">دقة إشارات النخبة (ELITE)</span>
                        <span className="bt-v">{results.summary.eliteAccuracy}%</span>
                        <div className="bt-sub">موثوقية عالية جداً</div>
                    </div>
                    <div className="bt-card">
                        <span className="bt-l">دقة سوق الفوز (1X2)</span>
                        <span className="bt-v">{results.summary.accuracy1X2}%</span>
                    </div>
                    <div className="bt-card">
                        <span className="bt-l">دقة سوق الأهداف</span>
                        <span className="bt-v">{results.summary.accuracyGoals}%</span>
                    </div>
                    <div className="bt-card roi">
                        <span className="bt-l">العائد المحاكي (ROI)</span>
                        <span className="bt-v">{results.summary.roi > 0 ? '+' : ''}{results.summary.roi} وحدة</span>
                        <div className="bt-sub">بناءً على 100 وحدة مراهنة</div>
                    </div>

                    {/* Insights */}
                    <div className="bt-card full-width insights">
                        <h3>💡 رؤى المحاكاة (Insights)</h3>
                        <ul>
                            {results.insights.map((ins, i) => <li key={i}>{ins}</li>)}
                        </ul>
                    </div>

                    {/* Performance Grade */}
                    <div className="bt-card full-width rating-section">
                        <h3>التقييم الفني للخوارزمية</h3>
                        <div className="grade-bar">
                            <div className="grade-fill" style={{width: `${results.summary.eliteAccuracy}%`}}></div>
                        </div>
                        <p>بناءً على {results.summary.totalMatches} مباراة سابقة، النظام يحصل على تقييم <strong>{results.summary.rating}/10</strong> من حيث الكفاءة التاريخية.</p>
                    </div>
                </div>
            )}

            {results && results.error && <div className="bt-error">{results.error}</div>}
        </div>
    );
};

export default BacktestDashboard;
