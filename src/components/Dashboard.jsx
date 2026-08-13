import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import MatchCard from './MatchCard'
import dataService from '../services/dataService'
import { ROUTES, PATH_TO_VIEW } from '../config/routes'
import { filterMatchesInWindow } from '../utils/timeFilter'
import { computeRawLines, isFinishedMatch } from '../utils/matchAnalysis'
import LoadingSkeleton from './LoadingSkeleton'
import { List } from 'react-window'

import './Dashboard.css'

// 🧠 [PERF] Composants lourds chargés à la demande (code-splitting)
const Promosport = lazy(() => import('./Promosport'))
const UltimateMatchCenter = lazy(() => import('./UltimateMatchCenter/UltimateMatchCenter'))

// 🧠 [PERF] Header extrait en sous-composant mémoïsé : il ne se re-rend que si
// son nombre de matches (compteur) ou l'état du toggle change réellement.
const StatusHeader = React.memo(({ count, sidebarOpen, onToggleSidebar }) => (
  <div
    className="onyx-status-header"
    style={{
      background: 'linear-gradient(90deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
      borderBottom: '1px solid rgba(0, 255, 170, 0.3)',
      padding: '8px 20px',
      height: '45px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <button
        onClick={onToggleSidebar}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#64748b',
          fontSize: '16px',
          cursor: 'pointer',
          padding: '2px 6px',
          borderRadius: '4px',
          lineHeight: '1',
        }}
      >
        {sidebarOpen ? '◀' : '▶'}
      </button>
      <div
        className="status-dot live"
        style={{ width: '8px', height: '8px', boxShadow: '0 0 10px #00ffaa' }}
      />
      <span
        style={{
          fontSize: '11px',
          fontWeight: '900',
          letterSpacing: '1px',
          color: '#f8fafc',
        }}
      >
        TITANIUM <span style={{ color: '#00ffaa' }}>SENSOR COMMAND</span> v3.0
      </span>
    </div>

    <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <span style={{ fontSize: '9px', color: '#64748b', fontWeight: '900' }}>MOTEUR:</span>
        <span style={{ fontSize: '10px', color: '#fbbf24', fontWeight: '900' }}>NEURAL-X</span>
      </div>
    </div>

    <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <span
          style={{
            fontSize: '8px',
            color: '#64748b',
            fontWeight: '900',
            textTransform: 'uppercase',
          }}
        >
          Capteurs Actifs
        </span>
        <span
          style={{
            fontSize: '14px',
            color: '#00ffaa',
            fontWeight: '900',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {count}
        </span>
      </div>
    </div>
  </div>
))

// Ligues majeures (différençables par xG fbref/StatsBomb) : priorité d'affichage
// afin de montrer en premier les "vrais pronostics" (objectif b) au lieu des
// amicaux/coupes insuffisants.
const MAJOR_LEAGUE_RE =
  /premier league|championship|champions league|europa league|ligue [12]|bundesliga|serie [ab]|la liga|liga portugal|eredivisie|mls|liga mx|j1 league|k league|scottish premiership|primera division|brasileirão/i
const isMajorLeague = (name) => MAJOR_LEAGUE_RE.test(String(name || ''))

// 🧠 [PERF] Cache par objet match : une même référence de match produit toujours
// la même liste "raw", évitant de recomputer la normalisation à chaque render
// (et permettant au React.memo de MatchCard de sauter les re-renders).
const rawLinesCache = new WeakMap()
const toRawLines = (m) => {
  if (!m) return []
  const cached = rawLinesCache.get(m)
  if (cached) return cached
  const lines = computeRawLines(m)
  rawLinesCache.set(m, lines)
  return lines
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
    return () => {
      unsubUpcoming()
      unsubStatus()
    }
  }, [])

  const handleRefresh = useCallback(() => dataService.refreshAllData(), [])
  const handleSelectMatch = useCallback((m) => setSelectedMatch(m), [])

  const handleLeagueChange = useCallback(
    (league) => {
      setActiveLeague(league)
      if (typeof window !== 'undefined' && window.innerWidth <= 1024) setSidebarOpen(false)
    },
    []
  )

  const handleDateChange = useCallback(
    (date) => {
      setActiveDate(date)
      if (typeof window !== 'undefined' && window.innerWidth <= 1024) setSidebarOpen(false)
    },
    []
  )

  const allMatchesList = useMemo(() => {
    // Filtre temporel (AUJOURD'HUI/DEMAIN/3 J/7 J) — jours calendaires locaux
    const dateFiltered = filterMatchesInWindow(matches, activeDate, Date.now())
    return dateFiltered
      .filter((m) => {
        const s = String(m.status || '').toLowerCase()
        if (['postponed', 'canceled'].includes(s)) return false

        if (searchQuery) {
          const q = searchQuery
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
          const home = (m.homeTeam || '').toLowerCase()
          const away = (m.awayTeam || '').toLowerCase()
          const league = (m.league || m.tournament_name || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
          if (!home.includes(q) && !away.includes(q) && !league.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => {
        // (b) Prioriser en tête les matchs avec vraies probabilités + ligues
        // majeures, afin d'afficher des "vrais pronostics" au lieu des amicaux
        // insuffisants. Le tri par heure reste le tie-break.
        const aProbs =
          parseFloat(a.home_win_probability || a.away_win_probability || a.draw_probability || 0) >
          0
        const bProbs =
          parseFloat(b.home_win_probability || b.away_win_probability || b.draw_probability || 0) >
          0
        const aInsuff =
          a.insufficient_data === 1 || a.sufficient === false || a.quant?.market_odds === null
        const bInsuff =
          b.insufficient_data === 1 || b.sufficient === false || b.quant?.market_odds === null
        const aMajor = isMajorLeague(a.league || a.tournament_name)
        const bMajor = isMajorLeague(b.league || b.tournament_name)
        const aScore = (aProbs && !aInsuff ? 1 : 0) + (aMajor ? 1 : 0)
        const bScore = (bProbs && !bInsuff ? 1 : 0) + (bMajor ? 1 : 0)
        if (aScore !== bScore) return bScore - aScore
        const aFin = isFinishedMatch(a)
        const bFin = isFinishedMatch(b)
        if (aFin !== bFin) return aFin ? 1 : -1
        const aTime = a.startTimestamp
          ? a.startTimestamp > 1e11
            ? a.startTimestamp
            : a.startTimestamp * 1000
          : 0
        const bTime = b.startTimestamp
          ? b.startTimestamp > 1e11
            ? b.startTimestamp
            : b.startTimestamp * 1000
          : 0
        return aFin ? bTime - aTime : aTime - bTime
      })
  }, [matches, activeDate, searchQuery])

  // 🧠 [PERF] Props stables pour la liste virtuelle : le React.memo des rangées
  // ne re-rend que si la liste (contenu) ou le handler changent réellement.
  const matchRowProps = useMemo(
    () => ({ list: allMatchesList, onClick: handleSelectMatch }),
    [allMatchesList, handleSelectMatch]
  )

  const renderMatchList = (list) => {
    if (list.length === 0) return null
    const ROW_H = 56
    const HEADER_H = 42
    const listHeight = Math.min(list.length * ROW_H, 800)
    const virtualHeight = listHeight - HEADER_H

    return (
      <div className="onyx-list-section">
        <div className="onyx-section-title global">📊 TOUS LES MATCHS ({list.length})</div>
        <div style={{ width: '100%' }}>
          <div
            style={{
              display: 'flex',
              borderBottom: '2px solid #1e293b',
              padding: '8px 0',
              fontSize: '11px',
              color: '#64748b',
              textTransform: 'uppercase',
              fontWeight: '800',
              letterSpacing: '0.8px',
              background: 'rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ width: '18%', minWidth: '140px', padding: '0 8px' }}>MATCH / FORME</div>
            <div style={{ width: '14%', minWidth: '80px', padding: '0 8px', textAlign: 'center' }}>
              BTTS
            </div>
            <div style={{ width: '14%', minWidth: '80px', padding: '0 8px', textAlign: 'center' }}>
              O/U
            </div>
            <div style={{ width: '18%', minWidth: '100px', padding: '0 8px', textAlign: 'center' }}>
              GAGNANT
            </div>
            <div style={{ width: '18%', minWidth: '90px', padding: '0 8px', textAlign: 'center' }}>
              HANDICAP
            </div>
            <div style={{ width: '18%', minWidth: '90px', padding: '0 8px', textAlign: 'center' }}>
              CORNERS
            </div>
          </div>
          <div style={{ height: virtualHeight }}>
            <List
              height={virtualHeight}
              rowCount={list.length}
              rowHeight={ROW_H}
              rowProps={matchRowProps}
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
        <Sidebar
          activeView={activeView}
          matches={matches}
          isOpen={sidebarOpen}
          activeLeague={activeLeague}
          onLeagueChange={handleLeagueChange}
          activeDate={activeDate}
          onDateChange={handleDateChange}
        />
        <main className="titanium-main">
          <LoadingSkeleton type="page" label="SYNCING GLOBAL DATA SENSORS..." />
        </main>
      </div>
    )

  if (status === 'error' && matches.length === 0)
    return (
      <div className="titanium-layout">
        <Sidebar
          activeView={activeView}
          matches={matches}
          isOpen={sidebarOpen}
          activeLeague={activeLeague}
          onLeagueChange={handleLeagueChange}
          activeDate={activeDate}
          onDateChange={handleDateChange}
        />
        <main className="titanium-main">
          <div className="onyx-error-container">
            <div className="onyx-error-icon">⚠️</div>
            <div className="onyx-error-title">CONNECTION INTERRUPTED</div>
            <button className="onyx-retry-btn" onClick={() => dataService.refreshAllData()}>
              RECONNECT SYSTEM
            </button>
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
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 9998,
            WebkitTapHighlightColor: 'transparent',
          }}
        />
      )}

      <main className="titanium-main">
        <StatusHeader
          count={matches.length}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
        />

        <div className="titanium-scroll">
          {activeView === 'promosport' ? (
            <Suspense fallback={<LoadingSkeleton type="table" label="Promosport IA..." />}>
              <Promosport />
            </Suspense>
          ) : (
            <div className="onyx-grid-container" style={{ padding: '16px 18px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 14px',
                  background: 'rgba(0,0,0,0.25)',
                  borderRadius: '8px',
                  marginBottom: '8px',
                }}
              >
                <div style={{ position: 'relative', flex: '1 1 200px', minWidth: '100px' }}>
                  <input
                    type="text"
                    placeholder="🔍 Rechercher une équipe..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 12px',
                      background: 'rgba(15,23,42,0.8)',
                      border: '1px solid #334155',
                      borderRadius: '6px',
                      color: '#f1f5f9',
                      fontSize: '12px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  {searchQuery && (
                    <span
                      onClick={() => setSearchQuery('')}
                      style={{
                        position: 'absolute',
                        right: '6px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        cursor: 'pointer',
                        color: '#64748b',
                        fontSize: '14px',
                        fontWeight: '700',
                      }}
                    >
                      ✕
                    </span>
                  )}
                </div>
                <button
                  onClick={handleRefresh}
                  style={{
                    padding: '4px 10px',
                    background: 'rgba(0,255,170,0.08)',
                    border: '1px solid rgba(0,255,170,0.2)',
                    borderRadius: '6px',
                    color: '#00ffaa',
                    fontWeight: '700',
                    fontSize: '10px',
                    cursor: 'pointer',
                  }}
                >
                  🔄
                </button>
              </div>
              {renderMatchList(allMatchesList)}
            </div>
          )}
        </div>
      </main>

      {selectedMatch && (
        <Suspense fallback={null}>
          <UltimateMatchCenter match={selectedMatch} onClose={() => setSelectedMatch(null)} />
        </Suspense>
      )}
    </div>
  )
}

export default Dashboard
