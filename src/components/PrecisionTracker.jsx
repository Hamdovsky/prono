import React, { useState, useEffect } from 'react';
import { getApiUrl } from '../config/apiConfig';
import './PrecisionTracker.css';

const PrecisionTracker = () => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchPrecision = async () => {
            try {
                const response = await fetch(getApiUrl('/api/news-watch'));
                if (!response.ok) throw new Error('فشل جلب البيانات');
                const result = await response.json();
                setData(result.precision);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };

        fetchPrecision();
    }, []);

    if (loading) return <div className="precision-loading">جاري تحميل بيانات الدقة...</div>;
    if (error) return <div className="precision-error">خطأ: {error}</div>;

    return (
        <div className="precision-container">
            <div className="precision-header">
                <div className="cyber-title">متتبع دقة الذكاء الاصطناعي (أخبار عالية التأثير)</div>
                <div className="accuracy-badge">
                    <span className="label">الدقة الإجمالية:</span>
                    <span className="val">{data?.accuracy || 0}%</span>
                </div>
            </div>

            <div className="precision-stats">
                <div className="stat-box">
                    <span className="val">{data?.total || 0}</span>
                    <span className="label">إجمالي التوقعات</span>
                </div>
                <div className="stat-box success">
                    <span className="val">{data?.matches?.filter(m => m.success).length || 0}</span>
                    <span className="label">ناجح</span>
                </div>
                <div className="stat-box failed">
                    <span className="val">{data?.matches?.filter(m => !m.success).length || 0}</span>
                    <span className="label">فاشل</span>
                </div>
            </div>

            <div className="precision-list">
                <div className="list-header">
                    <span>التاريخ</span>
                    <span>المباراة</span>
                    <span>تأثير الخبر</span>
                    <span>النتيجة</span>
                    <span>الحالة</span>
                </div>
                {data?.matches?.map((match, idx) => (
                    <div key={idx} className={`precision-row ${match.success ? 'success' : 'failed'}`}>
                        <span className="date">{new Date(match.date).toLocaleDateString('ar-EG')}</span>
                        <span className="match-teams">{match.homeTeam} × {match.awayTeam}</span>
                        <span className="impact">{match.impact > 0 ? `+${match.impact}` : match.impact}</span>
                        <span className="score">{match.score}</span>
                        <span className="status-icon">{match.success ? '✅' : '❌'}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default PrecisionTracker;
