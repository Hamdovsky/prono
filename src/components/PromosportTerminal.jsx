import React, { useState, useEffect, useRef } from 'react'
import './PromosportTerminal.css'

const PromosportTerminal = ({ matches, onGenerateReduced }) => {
    const [selectedMatch, setSelectedMatch] = useState(null)
    const [systemStatus, setSystemStatus] = useState(null)
    const logsRef = useRef([])

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const res = await fetch('/api/system/intel')
                const data = await res.json()
                setSystemStatus(data)
                const ts = new Date().toLocaleTimeString()
                logsRef.current = [
                    ...logsRef.current.slice(-19),
                    `[${ts}] SYSTEM HEALTH: ${data?.telemetry?.latency ? `${data.telemetry.latency}ms` : 'OK'}`,
                    `[${ts}] DB: ${data?.database?.totalMatches || '?'} matches indexés`,
                    `[${ts}] WORKERS: ${data?.ai_workers?.busy ? 'ANALYZING' : 'READY'} | Queue: ${data?.ai_workers?.queue || 0}`,
                ]
            } catch {
                const ts = new Date().toLocaleTimeString()
                logsRef.current = [...logsRef.current.slice(-19), `[${ts}] ⚠️ API indisponible`]
            }
        }
        fetchStatus()
        const interval = setInterval(fetchStatus, 10000)
        return () => clearInterval(interval)
    }, [])

    useEffect(() => {
        if (matches?.length > 0) {
            const ts = new Date().toLocaleTimeString()
            const real = matches.filter(m => m.home && m.away && m.home !== 'Home' && m.away !== 'Away').length
            logsRef.current = [
                ...logsRef.current.slice(-19),
                `[${ts}] 📊 ${matches.length} matchs chargés (${real} réels)`,
            ]
        }
    }, [matches])

    const logs = logsRef.current.length > 0 ? logsRef.current : [
        'SYSTEME EN ATTENTE DE DONNEES...',
        'Veuillez patienter pendant le chargement des matchs',
    ]

    if (!matches || matches.length === 0) {
        return (
            <div className="pro-terminal-container">
                <div className="terminal-header">
                    <div className="terminal-title">
                        <div className="status-glow" />
                        TERMINAL PROMOSPORT
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                        {new Date().toLocaleTimeString()}
                    </div>
                </div>
                <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
                    Aucun match chargé
                </div>
            </div>
        )
    }

    const getSignalTag = (m) => {
        if (!m.probs && !m.p1) return null
        const h = parseFloat(m.probs?.h || m.p1 || 0)
        const a = parseFloat(m.probs?.a || m.p2 || 0)
        const x = parseFloat(m.probs?.x || m.px || 0)
        if (h > 60) return <span className="indicator-tag tag-sharp">FAVORI</span>
        if (a > 60) return <span className="indicator-tag tag-sharp">FAVORI EXT</span>
        if (x > 35) return <span className="indicator-tag tag-value">NUL PROBABLE</span>
        if (Math.abs(h - a) < 5) return <span className="indicator-tag tag-steam">EQUILIBRE</span>
        return null
    }

    return (
        <div className="pro-terminal-container">
            <div className="terminal-header">
                <div className="terminal-title">
                    <div className="status-glow" />
                    TERMINAL PROMOSPORT
                </div>
                <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    MATCHS: {matches.length} | {new Date().toLocaleTimeString()}
                </div>
            </div>

            {selectedMatch && (
                <div className="score-matrix-overlay" onClick={() => setSelectedMatch(null)}>
                    <div className="score-matrix-modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h4>PROBABILITES: {selectedMatch.home} vs {selectedMatch.away}</h4>
                            <button onClick={() => setSelectedMatch(null)}>×</button>
                        </div>
                        <div className="matrix-footer">
                            <span>1: {selectedMatch.probs?.h || selectedMatch.p1 || '?'}%</span>
                            <span>X: {selectedMatch.probs?.x || selectedMatch.px || '?'}%</span>
                            <span>2: {selectedMatch.probs?.a || selectedMatch.p2 || '?'}%</span>
                        </div>
                        <p style={{ color: '#64748b', fontSize: '0.75rem', marginTop: '10px' }}>
                            Probabilités basées sur le modèle Neural-X
                        </p>
                    </div>
                </div>
            )}

            <table className="pro-matrix">
                <thead>
                    <tr>
                        <th>N°</th>
                        <th>MATCH</th>
                        <th>PROB 1</th>
                        <th>X</th>
                        <th>PROB 2</th>
                        <th>SIGNAL</th>
                    </tr>
                </thead>
                <tbody>
                    {matches.map(m => {
                        const h = parseFloat(m.probs?.h || m.p1 || 0)
                        const x = parseFloat(m.probs?.x || m.px || 0)
                        const a = parseFloat(m.probs?.a || m.p2 || 0)
                        return (
                            <tr key={m.id} className="pro-row" onClick={() => setSelectedMatch(m)} style={{ cursor: 'pointer' }}>
                                <td style={{ color: '#64748b' }}>{String(m.id || '').padStart(2, '0')}</td>
                                <td style={{ fontWeight: 'bold' }}>
                                    <span>{m.home?.toUpperCase()} v {m.away?.toUpperCase()}</span>
                                </td>
                                <td>
                                    <div className="prob-cell">
                                        <span style={{ fontSize: '0.7rem' }}>{h}%</span>
                                        <div className="prob-bar-bg">
                                            <div className="prob-bar-fill" style={{ width: `${h}%`, background: h > 50 ? '#34d399' : '#fbbf24' }} />
                                        </div>
                                    </div>
                                </td>
                                <td style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{x}%</td>
                                <td style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{a}%</td>
                                <td>
                                    <div style={{ display: 'flex', gap: '5px' }}>
                                        {getSignalTag(m)}
                                    </div>
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>

            <div className="terminal-controls">
                <div className="control-group">
                    <h4>GENERATEUR GRILLE</h4>
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button className="pro-btn" onClick={() => onGenerateReduced('N-1')}>REDUIT N-1</button>
                        <button className="pro-btn" onClick={() => onGenerateReduced('N-2')}>REDUIT N-2</button>
                    </div>
                </div>
                <div className="control-group">
                    <h4>SYSTEM_HEALTH</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                            <span>API</span>
                            <span style={{ color: systemStatus ? '#10b981' : '#f87171' }}>
                                {systemStatus ? '● ONLINE' : '● OFFLINE'}
                            </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                            <span>MATCHS</span>
                            <span style={{ color: matches.length > 0 ? '#10b981' : '#f87171' }}>
                                {matches.length > 0 ? `● ${matches.length}` : '● 0'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="scrolling-brief">
                {logs.map((log, i) => (
                    <div key={i} className="brief-line">{log}</div>
                ))}
            </div>
        </div>
    )
}

export default PromosportTerminal
