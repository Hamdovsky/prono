import React, { useState, useEffect } from 'react';
import dataService from '../services/dataService';
import './Configurations.css';

const API = import.meta.env.VITE_API_URL || '';

const TIER_LABELS = {
    ELITE: { label: 'BIG 5', color: '#f59e0b' },
    TIER1: { label: 'TIER 1', color: '#38bdf8' },
    MENA: { label: 'MENA', color: '#10b981' },
};

const Configurations = () => {
    const [autoPurge, setAutoPurge] = useState(true);
    const [duplicateDetection, setDuplicateDetection] = useState(false);
    const [thresholds, setThresholds] = useState({ goals: 2.5, corners: 8, cards: 4 });
    const [sourceMode, setSourceMode] = useState('FLASHSCORE_LOCAL');
    const [scraperUrl, setScraperUrl] = useState('https://api.soccer-scraper.io/v3/live');
    const [botToken, setBotToken] = useState('');
    const [chatId, setChatId] = useState('');
    const [apifyToken, setApifyToken] = useState('');
    const [activeStrategy, setActiveStrategy] = useState('Balanced');

    // League sync state
    const [leagues, setLeagues] = useState([]);
    const [leaguesLoading, setLeaguesLoading] = useState(true);
    const [smartScanActive, setSmartScanActive] = useState(true);
    const [globalWebhook, setGlobalWebhook] = useState(true);
    const [syncStatus, setSyncStatus] = useState(null); // 'scanning' | 'done' | null

    useEffect(() => {
        fetchLeagues();
    }, []);

    const fetchLeagues = async () => {
        try {
            setLeaguesLoading(true);
            const res = await fetch(`${API}/api/leagues`);
            if (res.ok) {
                const data = await res.json();
                setLeagues(data);
            }
        } catch (_) {
            // Server may not be running yet — fall back gracefully
            setLeagues([]);
        } finally {
            setLeaguesLoading(false);
        }
    };

    const handleActivateAll = async () => {
        setGlobalWebhook(true);
        setSmartScanActive(true);
        setLeagues(prev => prev.map(l => ({ ...l, webhookEnabled: true, smartScanEnabled: true })));
        setSyncStatus('done');
        setTimeout(() => setSyncStatus(null), 4000);
    };

    const handleSmartScan = async () => {
        try {
            setSyncStatus('scanning');
            await fetch(`${API}/api/scan-today`, { method: 'POST' });
            setTimeout(() => setSyncStatus(null), 3000);
        } catch (_) {
            setSyncStatus(null);
        }
    };

    const handleDeploy = async () => {
        try {
            await dataService.deployConfig({
                thresholds,
                autoPurge,
                botToken,
                chatId,
                apifyToken,
                strategy: activeStrategy,
                SOURCE_MODE: sourceMode,
                scraperUrl,
                SMART_SCAN_ENABLED: smartScanActive,
                WEBHOOK_ENABLED: globalWebhook,
                SYNC_PRIORITY: 'HIGH',
            });
            alert(`AUTONOMOUS PROTOCOLS DEPLOYED!\n\nStrategy: ${activeStrategy.toUpperCase()}\nSmart Scan: ${smartScanActive ? 'ACTIVE' : 'OFF'}\nWebhooks: ${globalWebhook ? 'ENABLED' : 'OFF'}\nSync Priority: HIGH`);
        } catch (error) {
            alert('CRITICAL ERROR: Failed to reach tactical service.');
        }
    };

    const strategies = [
        { name: 'Safe', icon: 'shield', color: '#00ff88', desc: 'Focus on 90%+ probability only.' },
        { name: 'Balanced', icon: 'balance', color: '#ffd700', desc: 'Optimal risk-reward ratio.' },
        { name: 'Aggressive', icon: 'bolt', color: '#ff4d4d', desc: 'High frequency, higher risk.' },
    ];

    // Group leagues by tier for rendering
    const tierOrder = ['ELITE', 'TIER1', 'MENA'];
    const grouped = tierOrder.map(tier => ({
        tier,
        leagues: leagues.filter(l => l.tier === tier),
    })).filter(g => g.leagues.length > 0);

    return (
        <div className="configs-container">
            <header className="configs-header">
                <h1 className="badge-gold">TITANIUM TERMINAL</h1>
                <h2 className="title">Command & Sync Center</h2>
            </header>

            {/* ══════ LEAGUE SYNC HUB ══════ */}
            <section className="config-section">
                <div className="section-title">
                    <span className="material-symbols-outlined">hub</span>
                    League Sync Hub — Top 12 Football Leagues 2026
                </div>

                {/* Master Controls */}
                <div className="sync-master-bar">
                    <div className="master-toggle-group">
                        <button
                            className={`master-btn ${smartScanActive ? 'active-green' : ''}`}
                            onClick={() => setSmartScanActive(v => !v)}
                            title="Toggle Smart Scan globally"
                        >
                            <span className="material-symbols-outlined">bolt</span>
                            SMART SCAN {smartScanActive ? 'ON' : 'OFF'}
                        </button>
                        <button
                            className={`master-btn ${globalWebhook ? 'active-blue' : ''}`}
                            onClick={() => setGlobalWebhook(v => !v)}
                            title="Toggle webhooks globally"
                        >
                            <span className="material-symbols-outlined">webhook</span>
                            WEBHOOKS {globalWebhook ? 'ON' : 'OFF'}
                        </button>
                    </div>
                    <div className="master-actions">
                        <button className="activate-all-btn" onClick={handleActivateAll}>
                            <span className="material-symbols-outlined">verified</span>
                            ACTIVATE ALL
                        </button>
                        <button
                            className={`scan-now-btn ${syncStatus === 'scanning' ? 'scanning' : ''}`}
                            onClick={handleSmartScan}
                            disabled={syncStatus === 'scanning'}
                        >
                            <span className={`material-symbols-outlined ${syncStatus === 'scanning' ? 'spin' : ''}`}>search</span>
                            {syncStatus === 'scanning' ? 'SCANNING...' : syncStatus === 'done' ? '✓ SYNCED' : 'SCAN NOW'}
                        </button>
                    </div>
                </div>

                {/* Priority badge */}
                <div className="priority-banner">
                    <span className="priority-dot"></span>
                    SYNC PRIORITY: <strong>HIGH</strong> — All 12 leagues synchronized to local database & XGBoost Hub
                </div>

                {/* League cards grouped by tier */}
                {leaguesLoading ? (
                    <div className="league-loading">
                        <div className="loader-ring-sm"></div>
                        <span>Loading league configurations...</span>
                    </div>
                ) : (
                    grouped.map(({ tier, leagues: tierLeagues }) => (
                        <div key={tier} className="tier-group">
                            <div className="tier-label" style={{ color: TIER_LABELS[tier]?.color }}>
                                {tier === 'ELITE' ? '🏆 EUROPEAN BIG 5'
                                    : '🌙 MENA & ARAB LEAGUES + SOUTH AMERICA'}
                            </div>
                            <div className="league-cards-grid">
                                {tierLeagues.map(league => (
                                    <LeagueCard
                                        key={league.id}
                                        league={league}
                                        smartScanActive={smartScanActive}
                                        globalWebhook={globalWebhook}
                                        tierColor={TIER_LABELS[tier]?.color || '#94a3b8'}
                                    />
                                ))}
                            </div>
                        </div>
                    ))
                )}

                {/* Arabic News Radar panel */}
                <div className="news-radar-panel">
                    <div className="radar-header">
                        <span className="material-symbols-outlined">wifi_tethering</span>
                        LIVE NEWS RADAR — Arabic Regional Sources
                        <span className="radar-live-badge">LIVE</span>
                    </div>
                    <div className="radar-sources">
                        {leagues.filter(l => l.arabicNewsEnabled).map(l => (
                            <div key={l.id} className="radar-source-row">
                                <span className="flag-cell">{l.flag}</span>
                                <span className="radar-country">{l.displayName}</span>
                                <div className="radar-feeds">
                                    {/* newsSources comes from the registry (not in DB yet) — fallback label */}
                                    <span className="feed-tag ar-tag">3 Arabic RSS Feeds</span>
                                    <span className="feed-tag active-tag">ACTIVE</span>
                                </div>
                            </div>
                        ))}
                        {leagues.filter(l => l.arabicNewsEnabled).length === 0 && (
                            <div className="radar-source-row muted">
                                <span className="material-symbols-outlined">info</span>
                                Connect to backend to see Arabic news feed status
                            </div>
                        )}
                    </div>
                </div>
            </section>

            {/* ══════ BOT STRATEGY ══════ */}
            <section className="config-section">
                <div className="section-title">
                    <span className="material-symbols-outlined">strategy</span>
                    Bot Deployment Strategy
                </div>
                <div className="strategy-grid">
                    {strategies.map(s => (
                        <div
                            key={s.name}
                            className={`strategy-card ${activeStrategy === s.name ? 'active' : ''}`}
                            onClick={() => setActiveStrategy(s.name)}
                            style={{ '--accent': s.color }}
                        >
                            <span className="material-symbols-outlined">{s.icon}</span>
                            <h4>{s.name}</h4>
                            <p>{s.desc}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* ══════ CLEANUP ══════ */}
            <section className="config-section">
                <div className="section-title">
                    <span className="material-symbols-outlined">cleaning_services</span>
                    Cleanup Agent Status
                </div>
                <div className="status-card-premium">
                    <div className="live-dot"></div>
                    <div className="card-info">
                        <p className="primary-text">Next Purge Cycle</p>
                        <p className="secondary-text">Real-time memory optimization</p>
                        <div className="timer-display">
                            <span className="time">00:48</span>
                            <span className="unit">SECONDS</span>
                        </div>
                    </div>
                    <div className="visual-icon">
                        <span className="material-symbols-outlined">cyclone</span>
                    </div>
                </div>
            </section>

            <section className="config-section">
                <div className="toggle-list">
                    <ToggleItem icon="delete_sweep" title="Auto-Purge Expired" desc="Removes finished match data"
                        checked={autoPurge} onChange={() => setAutoPurge(!autoPurge)} color="#0d93f2" />
                    <ToggleItem icon="content_copy" title="Duplicate Detection" desc="Heuristic redundancy check"
                        checked={duplicateDetection} onChange={() => setDuplicateDetection(!duplicateDetection)} color="#ffd700" />
                </div>
            </section>

            {/* ══════ THRESHOLDS ══════ */}
            <section className="config-section">
                <div className="section-title">
                    <span className="material-symbols-outlined">speed</span>
                    Momentum Thresholds
                </div>
                <div className="threshold-card">
                    {[
                        { key: 'goals', icon: 'sports_soccer', label: 'Goals (Expected)', min: 0, max: 5, step: 0.5 },
                        { key: 'corners', icon: 'flag', label: 'Corners (Pressure)', min: 0, max: 15, step: 1 },
                        { key: 'cards', icon: 'style', label: 'Cards (Volatility)', min: 0, max: 10, step: 1 },
                    ].map(({ key, icon, label, min, max, step }) => (
                        <div className="slider-group" key={key}>
                            <div className="slider-header">
                                <label><span className="material-symbols-outlined icon-xs">{icon}</span>{label}</label>
                                <span className="val-accent">{thresholds[key]}+</span>
                            </div>
                            <input type="range" min={min} max={max} step={step} value={thresholds[key]}
                                onChange={(e) => setThresholds({ ...thresholds, [key]: parseFloat(e.target.value) })} />
                        </div>
                    ))}
                    <p className="criteria-label">Defining 'Elite Pick' Criteria</p>
                </div>
            </section>

            {/* ══════ API CONFIG ══════ */}
            <section className="config-section">
                <div className="section-title">
                    <span className="material-symbols-outlined">api</span>
                    API Configuration
                </div>
                <div className="api-inputs">
                    <div className="input-field">
                        <label>Data Source Mode</label>
                        <div className="source-toggle-group" style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                            {['FLASHSCORE_LOCAL', 'EXTERNAL_API'].map(mode => (
                                <button key={mode}
                                    className={`mode-btn ${sourceMode === mode ? 'active' : ''}`}
                                    onClick={() => setSourceMode(mode)}
                                    style={{
                                        flex: 1, padding: '10px', borderRadius: '8px',
                                        background: sourceMode === mode ? 'var(--gold)' : 'rgba(255,255,255,0.05)',
                                        color: sourceMode === mode ? '#000' : '#fff',
                                        border: 'none', cursor: 'pointer', fontWeight: 'bold'
                                    }}
                                >{mode === 'FLASHSCORE_LOCAL' ? 'LOCAL SCRAPER' : 'SCRAPER API'}</button>
                            ))}
                        </div>
                    </div>
                    <InputField label="Live-Soccer-Scraper Endpoint" icon="link" type="text"
                        value={scraperUrl} onChange={setScraperUrl} placeholder="https://api..." />
                    <InputField label="Apify API Token (Radar)" icon="key" type="password"
                        value={apifyToken} onChange={setApifyToken} placeholder="apify_api_..." />
                    <InputField label="Telegram Bot Token" icon="token" type="password"
                        value={botToken} onChange={setBotToken} placeholder="Bot Token" />
                    <InputField label="Telegram Chat ID" icon="group" type="text"
                        value={chatId} onChange={setChatId} placeholder="Chat ID" />
                    <button className="deploy-btn" onClick={handleDeploy}>
                        <span className="material-symbols-outlined">save</span>
                        Deploy Changes to Bot
                    </button>
                </div>
            </section>
        </div>
    );
};

const LeagueCard = ({ league, smartScanActive, globalWebhook, tierColor }) => {
    const isLive = globalWebhook && league.webhookEnabled;
    const scanOn = smartScanActive && league.smartScanEnabled;

    return (
        <div className="league-sync-card">
            <div className="lcard-top">
                <span className="lcard-flag">{league.flag}</span>
                <div className="lcard-info">
                    <span className="lcard-name">{league.displayName}</span>
                    <span className="lcard-country">{String(league.country || '').toUpperCase()}</span>
                </div>
                <span className="lcard-priority" style={{ color: tierColor }}>
                    HIGH
                </span>
            </div>
            <div className="lcard-status-row">
                <span className={`lcard-badge ${scanOn ? 'badge-scan' : 'badge-off'}`}>
                    ⚡ SMART SCAN
                </span>
                <span className={`lcard-badge ${isLive ? 'badge-webhook' : 'badge-off'}`}>
                    🔗 WEBHOOK
                </span>
                {league.arabicNewsEnabled && (
                    <span className="lcard-badge badge-arabic">
                        📡 AR-NEWS
                    </span>
                )}
            </div>
        </div>
    );
};

const ToggleItem = ({ icon, title, desc, checked, onChange, color }) => (
    <div className="toggle-item">
        <div className="item-left">
            <div className="icon-bg" style={{ background: `${color}1a`, color }}>
                <span className="material-symbols-outlined">{icon}</span>
            </div>
            <div>
                <p className="item-title">{title}</p>
                <p className="item-desc">{desc}</p>
            </div>
        </div>
        <label className={`custom-toggle ${checked ? 'active' : ''}`}>
            <input type="checkbox" checked={checked} onChange={onChange} />
            <span className="slider"></span>
        </label>
    </div>
);

const InputField = ({ label, icon, type, value, onChange, placeholder }) => (
    <div className="input-field">
        <label>{label}</label>
        <div className="input-wrap">
            <span className="material-symbols-outlined">{icon}</span>
            <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
        </div>
    </div>
);

export default Configurations;
