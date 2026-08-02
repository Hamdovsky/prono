import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import UltimateMatchCenter from './UltimateMatchCenter/UltimateMatchCenter'
import MatchCard from './MatchCard'
import dataService from '../services/dataService'
import { ROUTES, PATH_TO_VIEW } from '../config/routes'
import LoadingSkeleton from './LoadingSkeleton'
import { List } from 'react-window'

import './Dashboard.css'

const Promosport = lazy(() => import('./Promosport'))

const FINISHED_STATUSES = new Set([
  'finished',
  'ft',
  'ended',
  'closed',
  'played',
  'aet',
  'pen',
])

const isFinishedMatch = (m) => {
  const s = String(m.status || '').toLowerCase()
  if (FINISHED_STATUSES.has(s)) return true
  const sh = parseInt(m.scoreHome)
  const sa = parseInt(m.scoreAway)
  if (!isNaN(sh) && !isNaN(sa) && s !== 'scheduled' && s !== 'NOT_STARTED' && s !== 'NS')
    return true
  return false
}

const toRawLines = (m) => {
  if (!m) return []
  const finished = isFinishedMatch(m)
  const score =
    finished && m.scoreHome != null && m.scoreAway != null
      ? `${m.scoreHome}-${m.scoreAway}`
      : '--'
  if (finished) {
    const sh = parseInt(m.scoreHome) || 0
    const sa = parseInt(m.scoreAway) || 0
    const result = sh > sa ? '1' : sh < sa ? '2' : 'X'
    return [
      m.league || m.tournament_name || '',
      m.homeTeam || '',
      m.awayTeam || '',
      '--',
      '--',
      result,
      score,
      '--',
      score,
    ]
  }
  const enriched = m.enriched || {}
  const quant = m.quant || enriched?.quant || {}
  const normalizePct = (v) => {
    const n = Number(v || 0)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n > 1 ? Math.round(n) : Math.round(n * 100)
  }
  const bttsPct = normalizePct(quant.probs?.btts || m.btts_prob || enriched?.btts_prob || 0)
  const over25Pct = normalizePct(quant.probs?.over25 || m.ou_25_prob || enriched?.ou_25_prob || 0)
  const mainPick = (quant.main_pick || '').toString().trim().toUpperCase() || '?'
  const htGoalPct = normalizePct(quant.probs?.ht_goal || m.ht_goal_prob || enriched?.ht_goal_prob || 0)
  const htPct = Math.min(89, Math.round((over25Pct + bttsPct) / 2 + 5))

  return [
    m.league || m.tournament_name || '',
    m.homeTeam || '',
    m.awayTeam || '',
    `${bttsPct}%`,
    `${over25Pct}%`,
    mainPick,
    `${htPct}%`,
    htGoalPct > 0 ? `${htGoalPct}%` : '--',
  ]
}

const MatchRowMemo = React.memo(({ index, style, list, onClick }) => {
  const m = list[index]
  if (!m) return null
  return <MatchCard rawData={toRawLines(m)} onClick={onClick} style={style} />
})

const Dashboard = () => {
  const location = useLocation()

  const [matches, setMatches] = useState([])
  const [status, setStatus] = useState('idle')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeLeague, setActiveLeague] = useState('ALL')
  const [activeDate, setActiveDate] = useState('Today')
  const [sidebarOpen, setSidebarOpen] = useState(
    typeof window !== 'undefined' ? window.innerWidth > 1024 : true
  )
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768)
  const [selectedMatch, setSelectedMatch] = useState(null)

  const activeView = PATH_TO_VIEW[location.pathname] || 'all-matches'

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 1024) setSidebarOpen(false)
  }, [location.pathname])

  useEffect(() => {
    const unsubUpcoming = dataService.subscribeUpcoming((data) => {
      if (Array.isArray(data)) setMatches(data)
    })
    const unsubStatus = dataService.subscribeStatus(setStatus)
    return () => { unsubUpcoming(); unsubStatus() }
  }, [])

  const handleRefresh = () => dataService.refreshAllData()

  const handleLeagueChange = (league) => {
    setActiveLeague(league)
    if (typeof window !== 'undefined' && window.innerWidth <= 1024) setSidebarOpen(false)
  }

  const handleDateChange = (date) => {
    setActiveDate(date)
    if (typeof window !== 'undefined' && window.innerWidth <= 1024) setSidebarOpen(false)
  }

  const allMatchesList = useMemo(() => {
    return matches
      .filter((m) => {
        const s = String(m.status || '').toLowerCase()
        if (['postponed', 'canceled'].includes(s)) return false

        if (searchQuery) {
          const q = searchQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          const home = (m.homeTeam || '').toLowerCase()
          const away = (m.awayTeam || '').toLowerCase()
          const league = (m.league || m.tournament_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          if (!home.includes(q) && !away.includes(q) && !league.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => {
        const aFin = isFinishedMatch(a)
        const bFin = isFinishedMatch(b)
        if (aFin !== bFin) return aFin ? 1 : -1
        const aTime = a.startTimestamp ? (a.startTimestamp > 1e11 ? a.startTimestamp : a.startTimestamp * 1000) : 0
        const bTime = b.startTimestamp ? (b.startTimestamp > 1e11 ? b.startTimestamp : b.startTimestamp * 1000) : 0
        return aFin ? bTime - aTime : aTime - bTime
      })
  }, [matches, searchQuery])

  const renderMatchList = (list) => {
    if (list.length === 0) return null
    const ROW_H = 56
    const HEADER_H = 42
    const listHeight = Math.min(list.length * ROW_H, 800)
    const virtualHeight = listHeight - HEADER_H

    return (
      <div className="onyx-list-section">
        <div className="onyx-section-title global">
          📊 TOUS LES MATCHS ({list.length})
        </div>
        <div style={{ width: '100%' }}>
          <div style={{
            display: 'flex', borderBottom: '2px solid #1e293b', padding: '8px 0',
            fontSize: '11px', color: '#64748b', textTransform: 'uppercase',
            fontWeight: '800', letterSpacing: '0.8px', background: 'rgba(0,0,0,0.3)',
          }}>
            <div style={{ width: '18%', minWidth: '140px', padding: '0 8px' }}>MATCH / FORME</div>
            <div style={{ width: '14%', minWidth: '80px', padding: '0 8px', textAlign: 'center' }}>BTTS</div>
            <div style={{ width: '14%', minWidth: '80px', padding: '0 8px', textAlign: 'center' }}>O/U</div>
            <div style={{ width: '18%', minWidth: '100px', padding: '0 8px', textAlign: 'center' }}>GAGNANT</div>
            <div style={{ width: '18%', minWidth: '90px', padding: '0 8px', textAlign: 'center' }}>HANDICAP</div>
            <div style={{ width: '18%', minWidth: '90px', padding: '0 8px', textAlign: 'center' }}>MI-TEMPS</div>
          </div>
          <div style={{ height: virtualHeight }}>
            <List
              height={virtualHeight}
              rowCount={list.length}
              rowHeight={ROW_H}
              rowProps={{ list, onClick: setSelectedMatch }}
              width="100%"
              className="titanium-virtual-list"
              style={{ overflowX: 'hidden' }}
              rowComponent={MatchRowMemo}
            />
          </div>
        </div>
      </div>
    )
  }

  if (status === 'loading' && matches.length === 0)
    return (
      <div className="titanium-layout">
        <Sidebar activeView={activeView} matches={matches} isOpen={sidebarOpen}
          activeLeague={activeLeague} onLeagueChange={handleLeagueChange}
          activeDate={activeDate} onDateChange={handleDateChange} />
        <main className="titanium-main">
          <LoadingSkeleton type="page" label="SYNCING GLOBAL DATA SENSORS..." />
        </main>
      </div>
    )

  if (status === 'error' && matches.length === 0)
    return (
      <div className="titanium-layout">
        <Sidebar activeView={activeView} matches={matches} isOpen={sidebarOpen}
          activeLeague={activeLeague} onLeagueChange={handleLeagueChange}
          activeDate={activeDate} onDateChange={handleDateChange} />
        <main className="titanium-main">
          <div className="onyx-error-container">
            <div className="onyx-error-icon">⚠️</div>
            <div className="onyx-error-title">CONNECTION INTERRUPTED</div>
            <button className="onyx-retry-btn" onClick={() => dataService.refreshAllData()}>RECONNECT SYSTEM</button>
          </div>
        </main>
      </div>
    )

  return (
    <div className="titanium-layout">
      <Sidebar
        matches={matches}
        activeView={activeView}
        isOpen={sidebarOpen}
        activeLeague={activeLeague}
        onLeagueChange={handleLeagueChange}
        activeDate={activeDate}
        onDateChange={handleDateChange}
      />
      {isMobile && sidebarOpen && (
        <div
          className="sidebar-backdrop active"
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 9998, WebkitTapHighlightColor: 'transparent',
          }}
        />
      )}

      <main className="titanium-main">
        <div className="onyx-status-header" style={{
          background: 'linear-gradient(90deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
          borderBottom: '1px solid rgba(0, 255, 170, 0.3)', padding: '8px 20px', height: '45px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button onClick={() => setSidebarOpen((s) => !s)} style={{
              background: 'transparent', border: 'none', color: '#64748b', fontSize: '16px',
              cursor: 'pointer', padding: '2px 6px', borderRadius: '4px', lineHeight: '1',
            }}>
              {sidebarOpen ? '◀' : '▶'}
            </button>
            <div className="status-dot live" style={{ width: '8px', height: '8px', boxShadow: '0 0 10px #00ffaa' }} />
            <span style={{ fontSize: '11px', fontWeight: '900', letterSpacing: '1px', color: '#f8fafc' }}>
              TITANIUM <span style={{ color: '#00ffaa' }}>SENSOR COMMAND</span> v3.0
            </span>
          </div>

          <div className="onyx-header-center" style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <span style={{ fontSize: '9px', color: '#64748b', fontWeight: '900' }}>MOTEUR:</span>
              <span style={{ fontSize: '10px', color: '#fbbf24', fontWeight: '900' }}>NEURAL-X</span>
            </div>
          </div>

          <div className="onyx-header-right" style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: '8px', color: '#64748b', fontWeight: '900', textTransform: 'uppercase' }}>Capteurs Actifs</span>
              <span style={{ fontSize: '14px', color: '#00ffaa', fontWeight: '900', fontFamily: "'JetBrains Mono', monospace" }}>{matches.length}</span>
            </div>
          </div>
        </div>

        <div className="titanium-scroll">
          {activeView === 'promosport' ? (
            <Suspense fallback={<LoadingSkeleton type="table" label="Promosport IA..." />}>
              <Promosport />
            </Suspense>
          ) : (
            <div className="onyx-grid-container" style={{ padding: '16px 18px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px',
                background: 'rgba(0,0,0,0.25)', borderRadius: '8px', marginBottom: '8px',
              }}>
                <div style={{ position: 'relative', flex: '1 1 200px', minWidth: '100px' }}>
                  <input type="text" placeholder="🔍 Rechercher une équipe..." value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      width: '100%', padding: '6px 12px', background: 'rgba(15,23,42,0.8)',
                      border: '1px solid #334155', borderRadius: '6px', color: '#f1f5f9',
                      fontSize: '12px', outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                  {searchQuery && (
                    <span onClick={() => setSearchQuery('')} style={{
                      position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
                      cursor: 'pointer', color: '#64748b', fontSize: '14px', fontWeight: '700',
                    }}>✕</span>
                  )}
                </div>
                <button onClick={handleRefresh} style={{
                  padding: '4px 10px', background: 'rgba(0,255,170,0.08)',
                  border: '1px solid rgba(0,255,170,0.2)', borderRadius: '6px',
                  color: '#00ffaa', fontWeight: '700', fontSize: '10px', cursor: 'pointer',
                }}>🔄</button>
              </div>
              {renderMatchList(allMatchesList)}
            </div>
          )}
        </div>
      </main>

      {selectedMatch && (
        <UltimateMatchCenter
          match={selectedMatch}
          onClose={() => setSelectedMatch(null)}
        />
      )}
    </div>
  )
}

export default Dashboard
