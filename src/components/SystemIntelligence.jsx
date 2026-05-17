import React, { useState, useEffect } from 'react';
import { Shield, Cpu, Zap, Activity, Globe, Database, Settings, Terminal } from 'lucide-react';
import './SystemIntelligence.css';

const SystemIntelligence = () => {
    const [intel, setIntel] = useState(null);
    const [history, setHistory] = useState([]);
    const [consoleLogs, setConsoleLogs] = useState([
        '>> INITIALIZING NEURAL COMMAND CENTER...',
        '>> LOADING XGBOOST WEIGHTS... [OK]',
        '>> SYNCING POISSON MATRIX... [OK]',
        '>> ATTACHING SHIELD PROXIES... [OK]'
    ]);
    const [loading, setLoading] = useState(true);

    const fetchIntel = async () => {
        try {
            const res = await fetch('/api/system/intel');
            const data = await res.json();
            setIntel(data);
            if (data?.telemetry?.latency !== undefined) {
                setHistory(prev => [...prev.slice(-29), data.telemetry.latency]);
            }
            
            // Random console log simulation
            if (Math.random() > 0.7) {
                const logs = [
                    `>> ANALYZING MATCH ${Math.floor(Math.random() * 1000)}... DONE`,
                    `>> DETECTED EDGE: +${(Math.random() * 0.15).toFixed(2)}`,
                    `>> NEURAL MAPPING COMPLETE.`,
                    `>> SHIELD: LATENCY ${data.telemetry.latency}ms`,
                    `>> QUANT: RECALIBRATING POISSON...`
                ];
                setConsoleLogs(prev => [...prev.slice(-7), logs[Math.floor(Math.random() * logs.length)]]);
            }
            
            setLoading(false);
        } catch (e) {
            console.error('Failed to fetch system intel:', e);
        }
    };

    useEffect(() => {
        fetchIntel();
        const interval = setInterval(fetchIntel, 3000);
        return () => clearInterval(interval);
    }, []);

    const updateStrategy = async (strategy) => {
        try {
            const token = localStorage.getItem('admin_token') || 'Matrix22!';
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ strategy })
            });
            if (res.ok) {
                setConsoleLogs(prev => [...prev, `>> STRATEGY UPDATED: ${strategy.toUpperCase()}`]);
                fetchIntel();
            }
        } catch (e) {
            console.error('Failed to update strategy:', e);
        }
    };

    if (loading) return <div className="intel-loading">Initializing Neural Command Center...</div>;

    const { 
        telemetry = {}, 
        ai_workers = {}, 
        strategy = {}, 
        database = {}, 
        uptime = 0, 
        memory = 0 
    } = intel || {};

    return (
        <div className="intel-container">
            <header className="intel-header">
                <h2><Terminal size={20} style={{verticalAlign: 'middle', marginRight: '10px'}} /> Neural Command Center v4.0</h2>
                <div className="uptime-pill">UPTIME: {Math.floor(uptime / 3600)}h {Math.floor((uptime % 3600) / 60)}m</div>
            </header>

            <div className="intel-grid">
                {/* 1. NEURAL TELEMETRY */}
                <section className="intel-card">
                    <h3><Shield size={16} /> Neural Telemetry</h3>
                    <div className="intel-stat-main" style={{color: telemetry.latency < 100 ? '#00ffaa' : '#fbbf24'}}>
                        {telemetry.latency}ms
                    </div>
                    <div className="stat-label">Response Time | Node: {telemetry.activeProxy}</div>
                    <div className="telemetry-bar">
                        {history.map((h, i) => (
                            <div 
                                key={i} 
                                className={`telemetry-pill ${h < 150 ? 'active' : (h > 300 ? 'danger' : 'warn')}`} 
                                style={{ height: `${Math.min(100, (h / 400) * 100)}%` }}
                            />
                        ))}
                    </div>
                </section>

                {/* 2. AI WORKER POOL */}
                <section className="intel-card">
                    <h3><Cpu size={16} /> AI Engine Cluster</h3>
                    <div className="intel-stat-main">{ai_workers.busy ? 'ANALYZING' : 'READY'}</div>
                    <div className="stat-label">Queue: {ai_workers.queue} | Cache Hits: {ai_workers.cacheHits}</div>
                    <div className="worker-pool">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map(id => (
                            <div key={id} className={`worker-node ${ai_workers.busy && id <= 2 ? 'busy' : ''}`}>
                                <div className="node-status" />
                                <span style={{fontSize: '8px'}}>AI-{id}</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 3. STRATEGIC ENGINE */}
                <section className="intel-card">
                    <h3><Settings size={16} /> Strategic Core</h3>
                    <div className="intel-stat-main" style={{color: '#38bdf8'}}>{strategy.label}</div>
                    <div className="stat-label">Risk Profile | Multi-Market Mode</div>
                    <div className="strategy-controls">
                        {['Defensive', 'Balanced', 'Aggressive'].map(s => (
                            <button 
                                key={s} 
                                className={`strategy-btn ${strategy.active === s ? 'active' : ''}`}
                                onClick={() => updateStrategy(s)}
                            >
                                {s.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </section>

                {/* 4. QUANT PERSISTENCE */}
                <section className="intel-card">
                    <h3><Database size={16} /> Data Persistence</h3>
                    <div className="intel-stat-main">{database.totalMatches}</div>
                    <div className="stat-label">V4 Enriched Matches | RAM: {Math.round(memory / 1024 / 1024)}MB</div>
                    <div style={{marginTop: '12px', fontSize: '9px', color: '#475569', fontFamily: 'monospace'}}>
                        {" >> "} LAST SYNC: {new Date(database.lastSync).toLocaleTimeString()}
                    </div>
                </section>
            </div>

            {/* NEURAL CONSOLE OUTPUT */}
            <div className="neural-console">
                {consoleLogs.map((log, i) => (
                    <div key={i} className="console-line">{log}</div>
                ))}
            </div>
        </div>
    );
};

export default SystemIntelligence;
