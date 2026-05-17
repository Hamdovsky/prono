import React, { useState, useEffect, useCallback } from 'react';
import { getApiUrl } from '../config/apiConfig';
import './MarketLab.css';

export default function MarketLab() {
    const [opportunities, setOpportunities] = useState([]);
    const [loading, setLoading] = useState(true);
    const [bankroll, setBankroll] = useState(1000);
    const [filter, setFilter] = useState('ALL');

    const fetchDeals = useCallback(async () => {
        try {
            const res = await fetch(getApiUrl('/api/market/edge'));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setOpportunities(data);
        } catch (e) {
            console.error('Failed to fetch market edge:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchDeals(); }, [fetchDeals]);

    const filteredDeals = opportunities.filter(o => 
        filter === 'ALL' || o.integrity.status === filter
    );

    if (loading) return (
        <div className="market-loading">
            <div className="market-spinner"></div>
            <p>جارٍ البحث عن فجوات في السوق وتحليل النزاهة...</p>
        </div>
    );

    return (
        <div className="market-lab">
            {/* Top Bar / Header */}
            <div className="market-header">
                <div className="market-info">
                    <span className="market-badge">TITANIUM MARKET EDGE</span>
                    <h1>قناص القيمة السوقية (Value Hunter)</h1>
                    <p>استغلال أخطاء البوكميكر بناءً على احتمالات الذكاء الاصطناعي</p>
                </div>
                <div className="bankroll-manager">
                    <label>حجم رأس المال ($)</label>
                    <input 
                        type="number" 
                        value={bankroll} 
                        onChange={(e) => setBankroll(Number(e.target.value))} 
                    />
                </div>
            </div>

            {/* Filters */}
            <div className="market-filters">
                <button className={filter === 'ALL' ? 'active' : ''} onClick={() => setFilter('ALL')}>الكل</button>
                <button className={filter === 'GREEN' ? 'active' : ''} onClick={() => setFilter('GREEN')}>🛡️ آمن (نزاهة عالية)</button>
                <button className={filter === 'YELLOW' ? 'active' : ''} onClick={() => setFilter('YELLOW')}>⚠️ حذر</button>
            </div>

            {/* Opportunities List */}
            <div className="opportunities-grid">
                {filteredDeals.length === 0 ? (
                    <div className="market-empty">لا توجد فرصة حالية تطابق المعايير.</div>
                ) : (
                    filteredDeals.map(deal => (
                        <div key={deal.id} className={`deal-card ${deal.integrity.status.toLowerCase()}`}>
                            <div className="deal-header">
                                <span className="league">{deal.league}</span>
                                <span className={`integrity-tag ${deal.integrity.status}`}>
                                    {deal.integrity.status === 'GREEN' ? 'نزاهة مستقرة' : 'اشتباه تلاعب'}
                                </span>
                            </div>
                            
                            <div className="deal-match">{deal.match}</div>
                            
                            <div className="deal-metrics">
                                <div className="metric">
                                    <span className="label">اختيار الـ AI</span>
                                    <span className="val">{deal.analysis.label}</span>
                                </div>
                                <div className="metric">
                                    <span className="label">الفجوة (Edge)</span>
                                    <span className="val highlight">+{deal.analysis.edge}%</span>
                                </div>
                                <div className="metric">
                                    <span className="label">السعر (Market)</span>
                                    <span className="val">@{deal.analysis.odds}</span>
                                </div>
                            </div>

                            <div className="kelly-box">
                                <div className="kelly-stake">
                                    <span className="l">مبلغ الرهان المقترح (Kelly)</span>
                                    <span className="v">${((bankroll * deal.kelly) / 100).toFixed(2)}</span>
                                    <span className="p">({deal.kelly}%)</span>
                                </div>
                                <div className="kelly-bar-container">
                                    <div className="kelly-bar" style={{ width: `${deal.kelly * 10}%` }}></div>
                                </div>
                            </div>

                            <div className="integrity-recom">
                                <strong>توصية المخاطر:</strong> {deal.integrity.recommendation}
                                {deal.integrity.tags.length > 0 && (
                                    <div className="tags">
                                        {deal.integrity.tags.map(t => <span key={t} className="tag">{t}</span>)}
                                    </div>
                                )}
                            </div>

                            {deal.market_signals && deal.market_signals.length > 0 && (
                                <div className="sharp-signals">
                                    {deal.market_signals.map((sig, i) => (
                                        <div key={i} className={`sharp-signal ${sig.type.toLowerCase()}`}>
                                            <span className="sig-icon">🕵️‍♂️</span>
                                            <span className="sig-msg">{sig.msg}</span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {deal.sharp_score > 50 && (
                                <div className="sharp-meter">
                                    <div className="meter-label">SHARP SCORE: {deal.sharp_score}%</div>
                                    <div className="meter-bar-bg">
                                        <div className="meter-bar" style={{ width: `${deal.sharp_score}%` }}></div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
