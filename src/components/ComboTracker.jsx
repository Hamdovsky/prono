import React, { useState, useEffect, useCallback } from 'react';
import { getApiUrl } from '../config/apiConfig';
import './ComboTracker.css';

const STATUS_COLORS = {
    WON:     '#2ecc71',
    LOST:    '#e74c3c',
    PENDING: '#f39c12',
    PARTIAL: '#3498db',
};

const STATUS_ICONS = { WON: '✅', LOST: '❌', PENDING: '⏳', PARTIAL: '⚡' };

function ROIBadge({ roi }) {
    const color = roi > 0 ? '#2ecc71' : roi < 0 ? '#e74c3c' : '#888';
    return <span className="ct-roi" style={{ color }}>{roi > 0 ? '+' : ''}{roi?.toFixed(1)}%</span>;
}

export default function ComboTracker() {
    const [today,   setToday]   = useState(null);
    const [history, setHistory] = useState(null);
    const [tab,     setTab]     = useState('today');
    const [loading, setLoading] = useState(true);
    const [error,   setError]   = useState(null);

    const fetchAll = useCallback(async () => {
        setLoading(true);
        try {
            const [r1, r2] = await Promise.all([
                fetch(getApiUrl('/api/combos/today')),
                fetch(getApiUrl('/api/combos/history'))
            ]);
            setToday(await r1.json());
            setHistory(await r2.json());
            setError(null);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // Weekly ROI stats from history
    const weekEntries = (history?.entries || []).slice(0, 7);
    const wonCombos  = weekEntries.filter(e => e.status === 'WON').length;
    const totalEntry = weekEntries.length;
    const weekHitRate = totalEntry > 0 ? Math.round((wonCombos / totalEntry) * 100) : null;
    const weekROI = weekEntries.reduce((s, e) => s + (e.roi || 0), 0);

    if (loading) return (
        <div className="ct-loading">
            <div className="ct-spinner" />
            <p>Chargement des combos...</p>
        </div>
    );
    if (error) return (
        <div className="ct-error">
            <span>⚠️ {error}</span>
            <button onClick={fetchAll}>Réessayer</button>
        </div>
    );

    const todayCombos   = today?.combos   || [];
    const histCombos    = history?.entries || [];

    return (
        <div className="ct-dashboard">
            {/* Header */}
            <div className="ct-header">
                <div className="ct-header-left">
                    <span className="ct-icon">🎯</span>
                    <div>
                        <h1>Combo Tracker</h1>
                        <p>Suivi de vos combinés & performance ROI</p>
                    </div>
                </div>
                <button className="ct-refresh-btn" onClick={fetchAll}>🔄 Rafraîchir</button>
            </div>

            {/* Week Stats */}
            <div className="ct-week-stats">
                <div className="ct-stat-card">
                    <div className="ct-stat-val" style={{ color: '#6c63ff' }}>{totalEntry}</div>
                    <div className="ct-stat-label">Combos (7j)</div>
                </div>
                <div className="ct-stat-card">
                    <div className="ct-stat-val" style={{ color: '#2ecc71' }}>{wonCombos}</div>
                    <div className="ct-stat-label">✅ Gagnés</div>
                </div>
                <div className="ct-stat-card">
                    <div className="ct-stat-val" style={{ color: weekHitRate >= 50 ? '#2ecc71' : '#e74c3c' }}>
                        {weekHitRate !== null ? `${weekHitRate}%` : '–'}
                    </div>
                    <div className="ct-stat-label">Taux de réussite</div>
                </div>
                <div className="ct-stat-card">
                    <div className="ct-stat-val" style={{ color: weekROI >= 0 ? '#2ecc71' : '#e74c3c' }}>
                        {weekROI >= 0 ? '+' : ''}{weekROI.toFixed(1)}%
                    </div>
                    <div className="ct-stat-label">ROI hebdo</div>
                </div>
            </div>

            {/* Tabs */}
            <div className="ct-tabs">
                <button className={`ct-tab ${tab === 'today' ? 'active' : ''}`} onClick={() => setTab('today')}>
                    📅 Aujourd'hui ({todayCombos.length})
                </button>
                <button className={`ct-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
                    📋 Historique ({histCombos.length})
                </button>
            </div>

            {/* Today's Combos */}
            {tab === 'today' && (
                <div className="ct-combos-list">
                    {todayCombos.length === 0 ? (
                        <div className="ct-empty">
                            <p>🎯 Aucun combo généré pour aujourd'hui.</p>
                            <p className="ct-empty-sub">Les combos apparaissent automatiquement après le scraping.</p>
                        </div>
                    ) : todayCombos.map((combo, i) => (
                        <ComboCard key={i} combo={combo} />
                    ))}
                </div>
            )}

            {/* History */}
            {tab === 'history' && (
                <div className="ct-combos-list">
                    {histCombos.length === 0 ? (
                        <div className="ct-empty"><p>📋 Aucun historique disponible.</p></div>
                    ) : histCombos.map((combo, i) => (
                        <ComboCard key={i} combo={combo} showDate />
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Combo Card ────────────────────────────────────────────────────────────────
function ComboCard({ combo, showDate }) {
    const [expanded, setExpanded] = useState(false);
    const status  = combo.status || 'PENDING';
    const color   = STATUS_COLORS[status] || '#888';
    const icon    = STATUS_ICONS[status]  || '⏳';

    return (
        <div className="ct-combo-card" style={{ borderTopColor: color }}>
            <div className="ct-combo-top" onClick={() => setExpanded(e => !e)}>
                <div className="ct-combo-left">
                    <span className="ct-status-badge" style={{ background: `${color}22`, color }}>
                        {icon} {status}
                    </span>
                    {showDate && <span className="ct-date">{combo.date}</span>}
                    <span className="ct-combo-type">{combo.type || 'ACCA'}</span>
                    <span className="ct-odds">📊 Cote: <strong>{combo.totalOdds?.toFixed(2) || '–'}</strong></span>
                </div>
                <div className="ct-combo-right">
                    {combo.roi !== undefined && <ROIBadge roi={combo.roi} />}
                    <span className="ct-expand">{expanded ? '▲' : '▼'}</span>
                </div>
            </div>

            {expanded && (
                <div className="ct-combo-legs">
                    {(combo.legs || combo.matches || []).map((leg, i) => (
                        <div key={i} className="ct-leg">
                            <span className="ct-leg-match">{leg.homeTeam} vs {leg.awayTeam}</span>
                            <span className="ct-leg-pick">{leg.pick || leg.prediction}</span>
                            <span className="ct-leg-odds">{leg.odds?.toFixed(2)}</span>
                            <span className="ct-leg-result" style={{
                                color: leg.result === 'WON' ? '#2ecc71' : leg.result === 'LOST' ? '#e74c3c' : '#f39c12'
                            }}>
                                {leg.result || '–'}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
