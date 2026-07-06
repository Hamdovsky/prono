import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy, useRef } from "react"
import { useLocation } from "react-router-dom"
import Sidebar from "./Sidebar"
import UltimateMatchCenter from "./UltimateMatchCenter/UltimateMatchCenter"
import MatchRow from "./MatchRow"
import TicketDuJour from "./TicketDuJour"
import MarketTerminal from "./MarketTerminal"
import PerformanceHub from "./PerformanceHub.jsx"
import dataService from "../services/dataService"
import { List } from 'react-window'
import { ROUTES, PATH_TO_VIEW } from "../config/routes"
import LoadingSkeleton from "./LoadingSkeleton"

import "./Dashboard.css"

// Lazy-loaded route components
const Promosport = lazy(() => import("./Promosport"))

const MatchRowMemo = React.memo(({ index, style, list, isElite, onClick, now: nowProp }) => {
    const m = list[index];
    if (!m) return null;
    return (
        <MatchRow
            match={m}
            isElite={isElite}
            onClick={onClick}
            style={style}
            now={nowProp}
        />
    );
});

const UnifiedRowMemo = React.memo(({ index, style, unifiedList, onClick, now: nowProp }) => {
    const item = unifiedList[index];
    if (!item) return null;
    if (item.type === 'header') {
        return (
            <div style={{
                ...style,
                display: 'flex',
                alignItems: 'center',
                padding: '0 18px',
                background: item.isMillionaire ? 'rgba(251, 191, 36, 0.15)' : (item.isElite ? 'rgba(0, 255, 170, 0.1)' : 'rgba(30, 41, 59, 0.5)'),
                borderLeft: item.isMillionaire ? '4px solid #fbbf24' : (item.isElite ? '4px solid #00ffaa' : '4px solid #334155'),
                color: item.isMillionaire ? '#fbbf24' : (item.isElite ? '#00ffaa' : '#cbd5e1'),
                fontSize: '13px',
                fontWeight: '900',
                letterSpacing: '1px',
                textTransform: 'uppercase',
                zIndex: 10
            }}>
                {item.label}
            </div>
        );
    }
    return (
        <MatchRow 
            match={item} 
            style={style} 
            isElite={item._isElite} 
            onClick={onClick} 
            now={nowProp}
        />
    );
});

const Dashboard = () => {
    const location = useLocation()

    // State
    const [activeSignal, setActiveSignal] = useState("ALL")
    const [activeSort, setActiveSort] = useState("POWER")
    const [sortDir, setSortDir] = useState('desc')
    const [matches, setMatches] = useState([])
    const [activeLeague, setActiveLeague] = useState("ALL")
    const [activeDate, setActiveDate] = useState("Today")
    const [selectedMatchForUltimateView, setSelectedMatchForUltimateView] = useState(null)
    const [surgicalMode, setSurgicalMode] = useState(false)
    const [sidebarOpen, setSidebarOpen] = useState(typeof window !== 'undefined' ? window.innerWidth > 1024 : true)
    const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768)
    const [viewportHeight, setViewportHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 800)
    const [apiHealth, setApiHealth] = useState(null)
    const [autoRefresh, setAutoRefresh] = useState(false)

    useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth < 768)
            setViewportHeight(window.innerHeight)
        }
        window.addEventListener('resize', handleResize)
        handleResize()
        return () => window.removeEventListener('resize', handleResize)
    }, [])

    useEffect(() => {
        if (typeof window !== 'undefined' && window.innerWidth <= 1024) {
            setSidebarOpen(false)
        }
    }, [location.pathname])

    const handleLeagueChange = (league) => {
        setActiveLeague(league)
        if (typeof window !== 'undefined' && window.innerWidth <= 1024) {
            setSidebarOpen(false)
        }
    }

    const handleDateChange = (date) => {
        setActiveDate(date)
        if (typeof window !== 'undefined' && window.innerWidth <= 1024) {
            setSidebarOpen(false)
        }
    }

    const [status, setStatus] = useState('idle')
    const [scraperProgress, setScraperProgress] = useState(null)
    const [isScraping, setIsScraping] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")
    const [now, setNow] = useState(Date.now())

    // 1-second timer for countdowns
    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(interval)
    }, [])

    const handleSort = (field) => {
        setActiveSort(prev => {
            if (prev === field) {
                setSortDir(d => d === 'desc' ? 'asc' : 'desc')
                return prev
            }
            setSortDir('desc')
            return field
        })
    }

    // Derive activeView from URL path
    const activeView = PATH_TO_VIEW[location.pathname] || 'matches'

    // Fast client-side enrichment (0 blocking time)
    const fastEnrichMatch = useCallback((m) => {
        return m; // 🚀 [TITANIUM PATCH] We now strictly trust the backend (Neural-X). No more fake frontend fallback probabilities.
    }, []);

    // Fetch data
    useEffect(() => {
        const unsubUpcoming = dataService.subscribeUpcoming((data) => {
            if (Array.isArray(data)) {
                // ENRICHISSEMENT INSTANTANÉ CÔTÉ CLIENT < 10ms
                const fastMatches = data.map(m => fastEnrichMatch(m));
                setMatches(fastMatches);
            }
        });
        const unsubStatus = dataService.subscribeStatus((s) => {
            setStatus(s);
        });
        
        // Initial check for scraper progress
        dataService.getScraperProgress().then(progress => {
            if (progress && progress.isRunning) {
                setIsScraping(true);
                setScraperProgress(progress);
            }
        });

        return () => {
            unsubUpcoming();
            unsubStatus();
        };
    }, []);

    // API Health check
    const checkApiHealth = useCallback(async () => {
        try {
            const res = await fetch('/health')
            const data = await res.json()
            setApiHealth(data.apis || null)
        } catch { /* ignore */ }
    }, [])

    useEffect(() => {
        checkApiHealth()
        const interval = setInterval(checkApiHealth, 120000)
        return () => clearInterval(interval)
    }, [checkApiHealth])

    // Auto-refresh every 60s
    useEffect(() => {
        if (!autoRefresh) return
        const interval = setInterval(() => dataService.refreshAllData(), 60000)
        return () => clearInterval(interval)
    }, [autoRefresh])

    // Scraper Polling Effect
    useEffect(() => {
        let pollInterval;
        if (isScraping) {
            pollInterval = setInterval(async () => {
                const progress = await dataService.getScraperProgress();
                if (progress) {
                    setScraperProgress(progress);
                    if (!progress.isRunning) {
                        setIsScraping(false);
                        dataService.refreshAllData(); // Refresh matches when done
                    }
                }
            }, 3000);
        }
        return () => {
            if (pollInterval) clearInterval(pollInterval);
        };
    }, [isScraping]);

    const handleSync = async () => {
        if (isScraping) return;
        try {
            await dataService.triggerScanToday();
            setIsScraping(true);
        } catch (e) {
            console.error("Failed to start sync:", e);
        }
    };

    const handleRefresh = () => {
        dataService.refreshAllData()
    }

    const handleExportCSV = () => {
        const rows = [['Date','Ligue','Domicile','Extérieur','CS','Confiance','BTTS','O/U','EV','Force','Valeur Score']]
        const exportList = activeView === 'all-matches' ? allMatchesList : sortedMatches
        exportList.forEach(m => {
            const ev = parseFloat(m.quant?.ev_score || m.ev_score || 0)
            const conf = m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0
            const valueScore = ((ev || 0) * (conf || 0) / 100).toFixed(2)
            rows.push([
                new Date(m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000).toLocaleDateString('fr-FR'),
                m.league || m.tournament_name || '',
                m.homeTeam || '',
                m.awayTeam || '',
                m.quant?.expected_score || m.expected_score || '',
                conf,
                Math.round(Number(m.btts_prob || m.quant?.probs?.btts || 0)) + '%',
                Math.round(Number(m.ou_25_prob || m.quant?.probs?.over25 || 0)) + '%',
                ev.toFixed(2),
                m.enriched?.power_score || m.power_score || '',
                valueScore
            ])
        })
        const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n')
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `matches_${new Date().toISOString().slice(0,10)}.csv`
        a.click()
        URL.revokeObjectURL(url)
    }

    // League accuracy derived from matches
    const leagueAccuracy = useMemo(() => {
        const groups = {}
        matches.forEach(m => {
            const league = m.league || m.tournament_name || 'Unknown'
            if (!groups[league]) groups[league] = { total: 0, sum: 0 }
            groups[league].total++
            const conf = m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0
            groups[league].sum += conf > 1 ? conf : conf * 100
        })
        return Object.entries(groups)
            .map(([league, data]) => ({ league, pct: Math.round(data.sum / data.total) }))
            .sort((a, b) => b.total - a.total || b.pct - a.pct)
            .slice(0, 5)
    }, [matches])

    // Date Constants for filtering
    const getToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); };
    const getTomorrow = () => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + 1); return d.getTime(); };

    const getMatchDate = useCallback((m) => {
        let dateMs = null;
        if (m.startTimestamp) {
            dateMs = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
        } else if (m.timestamp) {
            dateMs = new Date(m.timestamp).getTime();
        } else if (m.startTime) {
            dateMs = new Date(m.startTime).getTime();
        } else if (m.date) {
            dateMs = new Date(m.date).getTime();
        }

        if (!dateMs) return null;
        const d = new Date(dateMs);
        // Robust YYYY-MM-DD format
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }, []);

    // Optimized date cache for filters - Updated to refresh on matches change
    const dateCache = useMemo(() => {
        const now = Date.now();
        const serverToday = new Date(); // In a real app, we might get this from the server
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        
        const toKey = (d) => {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const threeDays = now + (3 * 24 * 60 * 60 * 1000);
        const sevenDays = now + (7 * 24 * 60 * 60 * 1000);
        
        return {
            now,
            todayStr: toKey(serverToday),
            tomorrowStr: toKey(tomorrow),
            threeDays,
            sevenDays,
            twelveHours: 12 * 60 * 60 * 1000
        };
    }, [matches.length]); // Refresh when matches change (or periodically)

    // Team-Strength (Power Score) Sorting Logic - OPTIMISÉ x10
    const sortedMatches = useMemo(() => {
        const { now, todayStr, tomorrowStr, threeDays, sevenDays, twelveHours } = dateCache;

        const filtered = matches.filter(m => {
            // 🔍 Search filter on team/league (raw + normalized)
            if (searchQuery) {
                const q = searchQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                const home = (m.homeTeam || '').toLowerCase()
                const away = (m.awayTeam || '').toLowerCase()
                const rawHome = (m.rawHomeTeam || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                const rawAway = (m.rawAwayTeam || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                const league = (m.league || m.tournament_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                if (!home.includes(q) && !away.includes(q) && !rawHome.includes(q) && !rawAway.includes(q) && !league.includes(q)) return false
            }

            if (activeLeague !== "ALL") {
                if (!(m.league || '').toLowerCase().includes(activeLeague.toLowerCase())) return false;
            }

            const matchDayStr = getMatchDate(m);
            const matchTime = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
            
            if (activeDate === "Today" && matchDayStr !== todayStr) return false;
            if (activeDate === "Tomorrow" && matchDayStr !== tomorrowStr) return false;
            if (activeDate === "Next 3 Days" && (matchTime < now - 3600000 || matchTime > threeDays)) return false;
            if (activeDate === "Next 7 Days" && (matchTime < now - 3600000 || matchTime > sevenDays)) return false;

            if (activeSignal === "CONFIRMED" && (m.confidence || 0) <= 85) return false;

            // 🚫 [LIVE FILTER] Auto-remove finished matches from view
            const s = String(m.status || '').toLowerCase();
            const isLive = s === 'live' || m.isLive || (m.minute && String(m.minute).includes("'"));
            
            // Filter finished matches to show only unplayed/live ones as requested
            if (['finished', 'ft', 'ended', 'closed', 'played', 'aet', 'pen', 'postponed', 'canceled'].includes(s)) return false;
            if (m.actualResult && m.actualResult !== 'N/A' && m.actualResult.trim() !== '') return false;

            // Remove matches that started more than 12 hours ago (to avoid stale matches), but keep today's matches visible
            if (!isLive && matchTime > 0 && matchTime < now - (12 * 60 * 60 * 1000) && matchDayStr !== todayStr) return false;

            return true;
        });

        // TRI OPTIMISÉ: Moins de calculs, plus rapide
        return filtered.sort((a, b) => {
            const aTime = a._ts || (a._ts = a.startTimestamp ? (a.startTimestamp > 1e11 ? a.startTimestamp : a.startTimestamp * 1000) : 0);
            const bTime = b._ts || (b._ts = b.startTimestamp ? (b.startTimestamp > 1e11 ? b.startTimestamp : b.startTimestamp * 1000) : 0);
            
            const aIsSoon = aTime >= now && aTime <= now + twelveHours;
            const bIsSoon = bTime >= now && bTime <= now + twelveHours;

            if (aIsSoon !== bIsSoon) return aIsSoon ? -1 : 1;

            const chaosA = a.chaos_score || a.enriched?.chaos_score || 0;
            const chaosB = b.chaos_score || b.enriched?.chaos_score || 0;
            
            if (chaosB !== chaosA) return chaosB - chaosA;
            
            const powerA = a.enriched?.power_score || a.power_score || 0;
            const powerB = b.enriched?.power_score || b.power_score || 0;
            
            if (powerB !== powerA) return powerB - powerA;
            
            return aTime - bTime;
        });
    }, [matches, activeLeague, activeDate, activeSignal, activeSort, searchQuery, getMatchDate, dateCache]);

    // Separate list for all-matches view: no date/league/signal filter, only search + finished removal
    const allMatchesList = useMemo(() => {
        return matches.filter(m => {
            // 🔍 Search filter on team/league (raw + normalized)
            if (searchQuery) {
                const q = searchQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                const home = (m.homeTeam || '').toLowerCase()
                const away = (m.awayTeam || '').toLowerCase()
                const rawHome = (m.rawHomeTeam || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                const rawAway = (m.rawAwayTeam || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                const league = (m.league || m.tournament_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                if (!home.includes(q) && !away.includes(q) && !rawHome.includes(q) && !rawAway.includes(q) && !league.includes(q)) return false
            }
            // Remove finished/completed matches
            const s = String(m.status || '').toLowerCase()
            if (['finished', 'ft', 'ended', 'closed', 'played', 'aet', 'pen', 'postponed', 'canceled'].includes(s)) return false
            if (m.actualResult && m.actualResult !== 'N/A' && m.actualResult.trim() !== '') return false
            return true
        }).sort((a, b) => {
            const aTime = a._ts || (a._ts = a.startTimestamp ? (a.startTimestamp > 1e11 ? a.startTimestamp : a.startTimestamp * 1000) : 0)
            const bTime = b._ts || (b._ts = b.startTimestamp ? (b.startTimestamp > 1e11 ? b.startTimestamp : b.startTimestamp * 1000) : 0)
            return aTime - bTime
        })
    }, [matches, searchQuery])

    const renderMatchList = (list, title, isElite = false) => {
        if (list.length === 0) return null

        const ROW_H = isMobile ? 110 : 65
        const HEADER_H = isMobile ? 0 : 42
        const listHeight = isElite
            ? Math.min(list.length * ROW_H, 600)
            : Math.min(list.length * ROW_H, 800)
        const virtualHeight = listHeight - HEADER_H

        return (
            <div className="onyx-list-section">
                <div className={`onyx-section-title ${!isElite ? 'global' : ''}`}>
                    {title} ({list.length})
                </div>
                <div style={{ width: '100%' }}>
                    {/* ✅ Column Header Row */}
                    {!isMobile && (
                        <div style={{
                            display: 'flex',
                            borderBottom: '2px solid #1e293b',
                            padding: '8px 0',
                            fontSize: '11px',
                            color: '#64748b',
                            textTransform: 'uppercase',
                            fontWeight: '800',
                            letterSpacing: '0.8px',
                            background: 'rgba(0,0,0,0.3)',
                            cursor: 'pointer'
                        }}>
                            <div style={{width:"20%", minWidth: "160px", padding:"0 8px"}}>MATCH / FORME</div>
                            <div style={{width:"26%", minWidth: "190px", padding:"0 8px"}}>PRONOSTIC</div>
                            <div style={{width:"14%", minWidth: "100px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('AI_SCORE')}>
                                AI SCORE / FT {activeSort === 'AI_SCORE' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                            <div style={{width:"16%", minWidth: "120px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('MARCHES')}>
                                MARCHÉS (DC) {activeSort === 'MARCHES' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                            <div style={{width:"14%", minWidth: "100px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('EV')}>
                                SIGNAL + EV {activeSort === 'EV' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                            <div style={{width:"10%", minWidth: "60px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('STRENGTH')}>
                                FORCE {activeSort === 'STRENGTH' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                        </div>
                    )}
                    <div style={{ height: virtualHeight }}>
                        <List
                            height={virtualHeight}
                            rowCount={list.length}
                            rowHeight={ROW_H}
                            rowProps={{ list, isElite, onClick: setSelectedMatchForUltimateView, now }}
                            width="100%"
                            className="titanium-virtual-list"
                            style={{ overflowX: 'hidden' }}
                            rowComponent={MatchRowMemo}
                        />
                    </div>
                </div>
            </div>
        );
    };

    const renderMainContent = () => {
        if (status === 'loading' && matches.length === 0) {
            return <LoadingSkeleton type="page" label="SYNCING GLOBAL DATA SENSORS..." />
        }

        if (status === 'error' && matches.length === 0) {
            return (
                <div className="onyx-error-container">
                    <div className="onyx-error-icon">⚠️</div>
                    <div className="onyx-error-title">CONNECTION INTERRUPTED</div>
                    <button className="onyx-retry-btn" onClick={() => dataService.refreshAllData()}>RECONNECT SYSTEM</button>
                </div>
            );
        }

        if (activeView === 'promosport') return <Suspense fallback={<LoadingSkeleton type="table" label="Promosport IA..." />}><Promosport /></Suspense>;

        if (activeView === 'markets') return <MarketTerminal matches={sortedMatches} />;

        if (activeView === 'all-matches') {
            return (
                <div className="onyx-grid-container">
                    {/* Toolbar: Search + Refresh + CSV + League Accuracy */}
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '8px 14px', background: 'rgba(0,0,0,0.25)',
                        borderRadius: '8px', marginBottom: '10px', flexWrap: 'wrap'
                    }}>
                        <input
                            type="text"
                            placeholder="🔍 Équipe / Ligue..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            autoFocus
                            style={{
                                flex: '1 1 160px', minWidth: '120px', padding: '6px 10px',
                                background: 'rgba(15,23,42,0.8)', border: '1px solid #334155',
                                borderRadius: '6px', color: '#f1f5f9', fontSize: '12px', outline: 'none'
                            }}
                        />
                        <button onClick={handleRefresh} style={{
                            padding: '6px 12px', background: 'rgba(0,255,170,0.08)',
                            border: '1px solid rgba(0,255,170,0.2)', borderRadius: '6px',
                            color: '#00ffaa', fontWeight: '700', fontSize: '11px', cursor: 'pointer'
                        }}>
                            🔄 RAFRAÎCHIR
                        </button>
                        <button onClick={handleExportCSV} style={{
                            padding: '6px 12px', background: 'rgba(56,189,248,0.08)',
                            border: '1px solid rgba(56,189,248,0.2)', borderRadius: '6px',
                            color: '#38bdf8', fontWeight: '700', fontSize: '11px', cursor: 'pointer'
                        }}>
                            📥 CSV
                        </button>
                        {leagueAccuracy.length > 0 && (
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: '6px',
                                padding: '4px 8px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', flexWrap: 'wrap'
                            }}>
                                <span style={{fontSize: '10px', color: '#64748b', fontWeight: '700'}}>🎯</span>
                                {leagueAccuracy.slice(0, 5).map((la, i) => (
                                    <span key={i} style={{
                                        fontSize: '10px', fontWeight: '700',
                                        color: la.pct >= 70 ? '#00ffaa' : la.pct >= 55 ? '#fbbf24' : '#f87171',
                                        background: `${la.pct >= 70 ? 'rgba(0,255,170,0.08)' : la.pct >= 55 ? 'rgba(251,191,36,0.08)' : 'rgba(248,113,113,0.08)'}`,
                                        padding: '1px 5px', borderRadius: '4px', whiteSpace: 'nowrap'
                                    }}>
                                        {la.league.split(' ').slice(0, 2).join(' ')}: {la.pct}%
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    {renderMatchList(allMatchesList, `📊 TOUS LES MATCHS`, false)}
                </div>
            );
        }

        if (sortedMatches.length === 0 && status !== 'loading') {
            return <div className="flash-empty">AUCUN MATCH DISPONIBLE POUR CETTE SÉLECTION.</div>;
        }

        // ────────────────────────────────────────────────────────────────
        // 🔥 SURGICAL INTELLIGENCE ENGINE — Only High-Confidence Winners
        // ────────────────────────────────────────────────────────────────
        const getConf    = (m) => m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0;
        const isVolatile = (m) => !!(m.detailed_analysis?.Volatility || m.enriched?.detailed_analysis?.Volatility);

        const SURGICAL_MIN_CONF = 60; // Lowered from 65 to be more inclusive
        const SURGICAL_MAX_CHAOS = 9; // Increased from 8

    const isSurgicalQualified = (m) => {
        const conf = getConf(m);
        const chaos = Math.round((m.chaos_score || m.chaos_level || 50) / 10);
        const hasTrap = m.isTrap || m.enriched?.isTrap || false;
        const quant = m.quant || (m.enriched && m.enriched.quant);
        
        // 1. STRICT QUANT FILTER
        if (quant && (quant.risk_label === 'SAFE' || quant.risk_label === 'EXTREME VALUE')) return true;

        const prob = Math.max(
            parseFloat(m.home_win_probability || 0),
            parseFloat(m.away_win_probability || 0)
        );
        
        // 2. SURGICAL REQUIREMENTS: High Confidence, No Trap, Low Chaos, and REAL DATA
        return conf >= 75 && !hasTrap && chaos <= 7 && prob >= 55 && m.insufficient_data !== 1;
    };

        const millionaireMatches = sortedMatches
            .filter(m => {
                const conf = getConf(m);
                const pred = m.prediction || m.verdict || '';
                const isUnderAnalysis = pred.includes('UNDER ANALYSIS') || pred.includes('WAITING') || pred.includes('NO BET');
                return conf > 60 && !isUnderAnalysis;
            })
            .sort((a, b) => {
                const confA = getConf(a) || 0;
                const confB = getConf(b) || 0;
                
                const evHomeA = a.quant?.ev_home || a.enriched?.ev_home || 0;
                const evAwayA = a.quant?.ev_away || a.enriched?.ev_away || 0;
                const evA = Math.max(evHomeA, evAwayA);

                const evHomeB = b.quant?.ev_home || b.enriched?.ev_home || 0;
                const evAwayB = b.quant?.ev_away || b.enriched?.ev_away || 0;
                const evB = Math.max(evHomeB, evAwayB);
                
                const scoreA = confA * 100 + (evA * 50);
                const scoreB = confB * 100 + (evB * 50);
                
                return scoreB - scoreA;
            })
            .slice(0, 30);

        const millionaireIds = new Set(millionaireMatches.map(m => m.id));

        const eliteMatches = sortedMatches
            .filter(m => !millionaireIds.has(m.id))
            .filter(m => {
                const conf = getConf(m);
                const minConf = surgicalMode ? SURGICAL_MIN_CONF : 55;
                return conf >= minConf;
            })
            .filter(m => !surgicalMode || isSurgicalQualified(m))
            .sort((a, b) => getConf(b) - getConf(a))
            .slice(0, 100);

        const eliteIds = new Set(eliteMatches.map(m => m.id));
        const globalMatches = sortedMatches
            .filter(m => !millionaireIds.has(m.id) && !eliteIds.has(m.id))
            .sort((a, b) => getConf(b) - getConf(a));

        const surgicalCount = sortedMatches.filter(m => isSurgicalQualified(m)).length;

        const unifiedList = [];

        if (activeView === 'millionaire') {
            if (millionaireMatches.length > 0) {
                unifiedList.push({ type: 'header', label: `🎯 TOP PICKS DU JOUR (${activeDate.toUpperCase()}) - TOP 30 (CONF & EV SORTED)`, isElite: true, isMillionaire: true });
                millionaireMatches.forEach(m => unifiedList.push({ ...m, type: 'match', _isElite: true, _isMillionaire: true }));
            } else {
                unifiedList.push({ type: 'header', label: `💰 AUCUN TOP PICK DISPONIBLE POUR CETTE DATE`, isElite: false, isMillionaire: true });
            }
        } else {
            if (millionaireMatches.length > 0) {
                unifiedList.push({ type: 'header', label: `🎯 TOP PICKS DU JOUR (${activeDate.toUpperCase()}) - TOP 30`, isElite: true, isMillionaire: true });
                millionaireMatches.forEach(m => unifiedList.push({ ...m, type: 'match', _isElite: true, _isMillionaire: true }));
            }
            if (eliteMatches.length > 0) {
                unifiedList.push({ type: 'header', label: `💎 TOP ELITE SELECTION (${activeDate.toUpperCase()})`, isElite: true });
                eliteMatches.forEach(m => unifiedList.push({ ...m, type: 'match', _isElite: true }));
            }
            if (globalMatches.length > 0) {
                unifiedList.push({ type: 'header', label: `📊 GLOBAL MARKET SENSORS (${activeDate.toUpperCase()})`, isElite: false });
                globalMatches.forEach(m => unifiedList.push({ ...m, type: 'match', _isElite: false }));
            }
        }

        // Row component is defined outside to prevent hook order violations

        return (
            <div className="onyx-grid-container">
                {activeView === 'matches' && activeDate === 'Today' && (
                    <TicketDuJour matches={sortedMatches} />
                )}

                {/* 🔥 PERFORMANCE & SURGICAL BANNER */}
                {activeView === 'matches' && <PerformanceHub matches={sortedMatches} />}

                {/* Search Bar for matches view */}
                {activeView === 'matches' && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '8px 14px', background: 'rgba(0,0,0,0.25)',
                        borderRadius: '8px', marginBottom: '10px', flexWrap: 'wrap'
                    }}>
                        <input
                            type="text"
                            placeholder="🔍 Équipe / Ligue..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            style={{
                                flex: '1 1 160px', minWidth: '120px', padding: '6px 10px',
                                background: 'rgba(15,23,42,0.8)', border: '1px solid #334155',
                                borderRadius: '6px', color: '#f1f5f9', fontSize: '12px', outline: 'none'
                            }}
                        />
                        {searchQuery && (
                            <button onClick={() => setSearchQuery('')} style={{
                                padding: '6px 10px', background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '6px',
                                color: '#f87171', fontSize: '12px', cursor: 'pointer'
                            }}>
                                ✕
                            </button>
                        )}
                    </div>
                )}

                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    marginBottom: 14,
                    padding: '12px 16px',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: 8,
                    border: '1px solid #1e293b',
                    flexWrap: 'wrap'
                }}>
                    <button
                        onClick={() => setSurgicalMode(s => !s)}
                        style={{
                            padding: '8px 18px',
                            borderRadius: 6,
                            border: `1px solid ${surgicalMode ? '#00ffaa' : '#334155'}`,
                            background: surgicalMode ? 'rgba(0,255,170,0.12)' : 'rgba(255,255,255,0.05)',
                            color: surgicalMode ? '#00ffaa' : '#94a3b8',
                            fontWeight: '700',
                            fontSize: '13px',
                            cursor: 'pointer',
                            letterSpacing: '0.5px',
                            transition: 'all 0.2s',
                            fontFamily: 'inherit',
                            textTransform: 'uppercase'
                        }}
                    >
                        🎯 MODE CHIRURGICAL {surgicalMode ? 'ON' : 'OFF'}
                    </button>
                    {surgicalMode && (
                            <span style={{ fontSize: '13px', color: '#00ffaa', fontWeight: '600', opacity: 0.9 }}>
                                ✅ {surgicalCount} pronostic{surgicalCount !== 1 ? 's' : ''} sûr{surgicalCount !== 1 ? 's' : ''} &nbsp;·&nbsp; ACC ≥ 75% &nbsp;·&nbsp; Sans piège &nbsp;·&nbsp; Données Réelles
                            </span>
                    )}
                    {!surgicalMode && (
                        <span style={{ fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>
                            Activez le mode chirurgical pour n'afficher que les paris les plus sûrs
                        </span>
                    )}
                    <div style={{marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center'}}>
                        <button onClick={() => setAutoRefresh(s => !s)} style={{
                            padding: '4px 10px', borderRadius: '4px',
                            border: `1px solid ${autoRefresh ? '#38bdf8' : '#334155'}`,
                            background: autoRefresh ? 'rgba(56,189,248,0.12)' : 'transparent',
                            color: autoRefresh ? '#38bdf8' : '#64748b',
                            fontSize: '10px', fontWeight: '700', cursor: 'pointer', fontFamily: 'inherit'
                        }}>
                            ↻ AUTO {autoRefresh ? 'ON' : 'OFF'}
                        </button>
                        {apiHealth && (() => {
                            const ok = Object.values(apiHealth).filter(v => v === 'enabled').length
                            const total = Object.keys(apiHealth).length
                            return (
                                <span style={{fontSize: '9px', fontWeight: '700', color: ok === total ? '#00ffaa' : ok > 0 ? '#fbbf24' : '#f87171'}}>
                                    {ok}/{total} API
                                </span>
                            )
                        })()}
                    </div>
                </div>

                {/* Quick counts */}
                {(() => {
                    const total = sortedMatches.length
                    const surgicalCount = sortedMatches.filter(m => isSurgicalQualified(m)).length
                    const millionCount = millionaireMatches.length
                    const eliteCount = eliteMatches.length
                    const insufficientCount = sortedMatches.filter(m => m.insufficient_data === 1).length
                    return (
                        <div style={{
                            display: 'flex', gap: '8px', padding: '4px 14px 8px',
                            fontSize: '10px', fontWeight: '700', flexWrap: 'wrap', alignItems: 'center'
                        }}>
                            <span style={{color: '#94a3b8'}}>📊 {total} matchs</span>
                            <span style={{color: '#fbbf24'}}>💰 {millionCount}</span>
                            <span style={{color: '#00ffaa'}}>💎 {eliteCount}</span>
                            <span style={{color: '#38bdf8'}}>🎯 {surgicalCount} chirurgical</span>
                            {insufficientCount > 0 && (
                                <span style={{color: '#f59e0b'}}>⚠️ {insufficientCount} données faibles</span>
                            )}
                        </div>
                    )
                })()}

                <div className="onyx-unified-list-container" style={{
                    background: 'rgba(15, 23, 42, 0.6)',
                    borderRadius: '12px',
                    border: '1px solid #1e293b',
                    overflowX: 'auto'
                }}>
                    {/* TABLE HEADER */}
                    {!isMobile && (
                        <div style={{
                            display: 'flex',
                            borderBottom: '2px solid #1e293b',
                            padding: '8px 0',
                            fontSize: '11px',
                            color: '#64748b',
                            textTransform: 'uppercase',
                            fontWeight: '800',
                            letterSpacing: '0.8px',
                            background: 'rgba(0,0,0,0.3)',
                            cursor: 'pointer'
                        }}>
                            <div style={{width:"20%", minWidth: "160px", padding:"0 8px"}}>MATCH / FORME</div>
                            <div style={{width:"26%", minWidth: "190px", padding:"0 8px"}}>PRONOSTIC</div>
                            <div style={{width:"14%", minWidth: "100px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('AI_SCORE')}>
                                AI SCORE / FT {activeSort === 'AI_SCORE' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                            <div style={{width:"16%", minWidth: "120px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('MARCHES')}>
                                MARCHÉS (DC) {activeSort === 'MARCHES' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                            <div style={{width:"14%", minWidth: "100px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('EV')}>
                                SIGNAL + EV {activeSort === 'EV' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                            <div style={{width:"10%", minWidth: "60px", padding:"0 8px", textAlign: 'center', cursor: 'pointer'}} onClick={() => handleSort('STRENGTH')}>
                                FORCE {activeSort === 'STRENGTH' ? (sortDir === 'desc' ? '▼' : '▲') : ''}
                            </div>
                        </div>
                    )}

                    <List
                        height={isMobile ? Math.max(420, viewportHeight - 260) : Math.max(520, viewportHeight - 320)}
                        rowCount={unifiedList.length}
                        rowHeight={isMobile ? 110 : 65}
                        width="100%"
                        className="onyx-custom-scrollbar"
                        rowComponent={UnifiedRowMemo}
                        rowProps={{ unifiedList, onClick: setSelectedMatchForUltimateView, now }}
                    />
                </div>
            </div>
        );
    };

    const smtSignals = matches.filter(m => m.smart_money_active).length;

    return (
        <div className="titanium-layout">
            <Sidebar 
                activeLeague={activeLeague} 
                onLeagueChange={handleLeagueChange} 
                matches={matches}
                activeView={activeView}
                activeDate={activeDate}
                onDateChange={handleDateChange}
                isOpen={sidebarOpen}
            />
            
            <main className="titanium-main">
                {/* ONYX STATUS HEADER (BOOSTED) */}
                <div className="onyx-status-header" style={{
                    background: 'linear-gradient(90deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
                    borderBottom: '1px solid rgba(0, 255, 170, 0.3)',
                    padding: '8px 20px',
                    height: '45px'
                }}>
                    <div style={{display:'flex', alignItems:'center', gap:'8px'}}>
                        <button onClick={() => setSidebarOpen(s => !s)} style={{
                            background: 'transparent', border: 'none', color: '#64748b', fontSize: '16px',
                            cursor: 'pointer', padding: '2px 6px', borderRadius: '4px', lineHeight: '1'
                        }} title="Toggle sidebar">{sidebarOpen ? '◀' : '▶'}</button>
                        <div className="status-dot live" style={{width: '8px', height: '8px', boxShadow: '0 0 10px #00ffaa'}}></div>
                        <span style={{fontSize: '11px', fontWeight: '900', letterSpacing: '1px', color: '#f8fafc'}}>
                            TITANIUM <span style={{color: '#00ffaa'}}>SENSOR COMMAND</span> v3.0
                        </span>
                    </div>
                    
                    <div className="onyx-header-center" style={{flex: 1, display: 'flex', justifyContent: 'center'}}>
                        {isScraping ? (
                            <div className="onyx-scraper-status" style={{background: 'rgba(0, 255, 170, 0.1)', padding: '2px 12px', borderRadius: '12px', border: '1px solid rgba(0, 255, 170, 0.3)'}}>
                                <span className="onyx-pulse" style={{marginRight: '8px'}}>📡</span> 
                                <span style={{fontSize: '11px', fontWeight: '800'}}>SYNC LIVE: {scraperProgress?.percent || 0}%</span>
                            </div>
                        ) : (
                            <div style={{display:'flex', gap: '20px', alignItems:'center'}}>
                                <div style={{display: 'flex', gap: '4px', alignItems: 'center'}}>
                                    <span style={{fontSize: '9px', color: '#64748b', fontWeight: '900'}}>MOTEUR:</span>
                                    <span style={{fontSize: '10px', color: '#fbbf24', fontWeight: '900'}}>NEURAL-X</span>
                                </div>
                                <button className="onyx-sync-btn" onClick={handleSync} style={{
                                    background: 'rgba(0, 255, 170, 0.1)',
                                    border: '1px solid #00ffaa',
                                    color: '#00ffaa',
                                    padding: '2px 10px',
                                    borderRadius: '4px',
                                    fontSize: '10px',
                                    fontWeight: '900'
                                }}>⚡ BOOST SYNC</button>
                            </div>
                        )}
                    </div>

                    <div className="onyx-header-right" style={{display: 'flex', gap: '20px', alignItems: 'center'}}>
                        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-end'}}>
                            <span style={{fontSize: '8px', color: '#64748b', fontWeight: '900', textTransform: 'uppercase'}}>Capteurs Actifs</span>
                            <span style={{fontSize: '14px', color: '#00ffaa', fontWeight: '900', fontFamily: "'JetBrains Mono', monospace"}}>{matches.length}</span>
                        </div>
                    </div>
                </div>

                {/* Legacy Titanium Header hidden via CSS, but keeping elements for compatibility if needed */}

                <div className="titanium-scroll">
                    {renderMainContent()}
                </div>
            </main>

            {selectedMatchForUltimateView && (
                <UltimateMatchCenter 
                    match={selectedMatchForUltimateView} 
                    onClose={() => setSelectedMatchForUltimateView(null)} 
                />
            )}
        </div>
    );
};

export default Dashboard;
