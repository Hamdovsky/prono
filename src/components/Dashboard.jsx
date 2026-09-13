import React, { useState, useEffect, useMemo, useCallback, useRef, Suspense, lazy } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import MatchCard from './MatchCard'
import dataService from '../services/dataService'
import { PATH_TO_VIEW } from '../config/routes'
import { selectEligibleMatches } from '../utils/timeFilter'
import { isFinishedMatch } from '../utils/matchAnalysis'
import {
  toRawLines,
  marketPct,
  computeChipCounts,
  applyBaseFilters,
  applyMarketFilter,
  parseFilterSearch,
  buildFilterSearch,
  leagueDisplayLabel,
  applyQualityFilters,
  computeQualitySummary,
  buildCsv,
  norm,
} from '../utils/dashboardFilters'
import { loadFavorites, saveFavorites, matchHasFavorite } from '../utils/favorites'
import { TABLE_COLUMNS, mcColumnsCss, MC_COLS_FALLBACK } from '../utils/tableColumns'
import LoadingSkeleton from './LoadingSkeleton'
import { List } from 'react-window'

import './Dashboard.css'

// 🧠 [PERF] Composants lourds chargés à la demande (code-splitting)
const Promosport = lazy(() => import('./Promosport'))
const TopPicksWidget = lazy(() => import('./TopPicksWidget'))
const ProPlanWidget = lazy(() => import('./ProPlanWidget'))
const UltimateMatchCenter = lazy(() => import('./UltimateMatchCenter/UltimateMatchCenter'))
const FlashOddsView = lazy(() => import('./FlashOddsView'))

// 🧠 [PERF] Header extrait en sous-composant mémoïsé : il ne se re-rend que si
// son nombre de matches (compteur) ou l'état du toggle change réellement.
const StatusHeader = React.memo(({ count, liveCount = 0, onGoLive, sidebarOpen, onToggleSidebar }) => (
  <header className="sh-bar">
    <div className="sh-left">
      <button className="sh-toggle" onClick={onToggleSidebar} aria-label="Menu">
        <span className="sh-burger">{sidebarOpen ? '✕' : '☰'}</span>
      </button>
      <span className="sh-dot" />
      <span className="sh-title">
        TITANIUM <span className="sh-accent">SENSOR</span>
      </span>
    </div>

    <div className="sh-center">
      <span className="sh-mute">MOTEUR:</span>
      <span className="sh-engine">NEURAL-X</span>
    </div>

    <div className="sh-right">
      {liveCount > 0 && onGoLive && (
        <button
          onClick={onGoLive}
          aria-label={`${liveCount} match en direct`}
          style={{
            marginRight: '10px',
            fontSize: '9px',
            fontWeight: 900,
            padding: '3px 9px',
            borderRadius: '10px',
            border: '1px solid #ef4444',
            background: 'rgba(239,68,68,0.14)',
            color: '#ef4444',
            cursor: 'pointer',
            letterSpacing: '0.5px',
            animation: 'goldenPulse 2s ease-in-out infinite',
          }}
        >
          🔴 {liveCount} LIVE
        </button>
      )}
      <span className="sh-cap-label">Capteurs Actifs</span>
      <span className="sh-cap-count">{count}</span>
    </div>
  </header>
))

// Ligues majeures (différençables par xG fbref/StatsBomb) : priorité d'affichage
// afin de montrer en premier les "vrais pronostics" (objectif b) au lieu des
// amicaux/coupes insuffisants.
const MAJOR_LEAGUE_RE =
  /premier league|championship|champions league|europa league|ligue [12]|bundesliga|serie [ab]|la liga|liga portugal|eredivisie|mls|liga mx|j1 league|k league|scottish premiership|primera division|brasileirão/i
const isMajorLeague = (name) => MAJOR_LEAGUE_RE.test(String(name || ''))

// Bande de confiance → précision réelle issue du backtest (bracketAccuracy).
const bandOf = (conf) => {
  const c = Number(conf)
  if (!c) return null
  if (c < 50) return '0-50'
  if (c < 60) return '50-60'
  if (c < 70) return '60-70'
  if (c < 80) return '70-80'
  if (c < 90) return '80-90'
  return '90+'
}

// Logique de filtrage (recherche/ligue/marché + compteurs + cache rawLines)
// extraite dans utils/dashboardFilters.js — corrigée session E18 : le filtre
// ligue (activeLeague) était réglé par la Sidebar mais jamais appliqué, et les
// compteurs d'onglets variaient avec l'onglet actif.

const MatchRowMemo = React.memo(({ index, style, list, onClick, compact, bracketMap, activeMarket, activeIndex, favorites, onToggleFavorite }) => {
  const m = list[index]
  if (!m) return null
  const ts = m.startTimestamp
  const statusUpper = (m.status || '').toUpperCase()
  const isLive = statusUpper === 'LIVE' || (m.minute && m.minute !== '0' && statusUpper !== 'FINISHED' && statusUpper !== 'FT')
  const liveMinute = isLive ? m.minute : null
  const liveScore = isLive && m.scoreHome != null && m.scoreAway != null ? `${m.scoreHome}-${m.scoreAway}` : null
  const timeLabel = ts
    ? new Date(ts > 1e11 ? ts : ts * 1000).toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  const raw = toRawLines(m)
  const band = m?.confidence ? bandOf(m.confidence) : null
  const reliability = bracketMap && band ? bracketMap[band] : undefined
  const liveStats = m.liveStats || null
  const goalPrediction = m.goalPrediction || null
  return (
    <MatchCard
      rawData={raw}
      onClick={onClick}
      style={style}
      timeLabel={isLive ? null : timeLabel}
      compact={compact}
      reliability={reliability}
      isLive={isLive}
      liveMinute={liveMinute}
      liveScore={liveScore}
      liveStats={liveStats}
      goalPrediction={goalPrediction}
      activeMarket={activeMarket}
      contextualInfo={m.contextual}
      divergenceInfo={m.market_divergence}
      favoriteOn={matchHasFavorite(m, favorites)}
      onToggleFavorite={onToggleFavorite}
      active={index === activeIndex}
    />
  )
})

const Dashboard = () => {
  const location = useLocation()
  const navigate = useNavigate()

  // État initial des filtres lu depuis l'URL (E19) — un lien
  // « /?ligue=...&date=...&marche=...&q=... » reproduit exactement la vue.
  const initialFilters =
    typeof window !== 'undefined' ? parseFilterSearch(window.location.search) : null

  const [matches, setMatches] = useState([])
  const [status, setStatus] = useState('idle')
  const [searchQuery, setSearchQuery] = useState(initialFilters?.searchQuery ?? '')
  const [activeLeague, setActiveLeague] = useState(initialFilters?.activeLeague ?? 'ALL')
  const [activeDate, setActiveDate] = useState(initialFilters?.activeDate ?? 'Today')
  const [sidebarOpen, setSidebarOpen] = useState(
    typeof window !== 'undefined' ? window.innerWidth > 1024 : true
  )
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768)
  const [selectedMatch, setSelectedMatch] = useState(null)
  const [bracketMap, setBracketMap] = useState({})
  const [dominantFilter, setDominantFilter] = useState(initialFilters?.dominantFilter ?? 'ALL')
  const [onlyRealOdds, setOnlyRealOdds] = useState(initialFilters?.onlyRealOdds ?? false)
  const [hideNoBet, setHideNoBet] = useState(initialFilters?.hideNoBet ?? false)
  const [onlyFavorites, setOnlyFavorites] = useState(initialFilters?.onlyFavorites ?? false)
  const [favorites, setFavorites] = useState(() => loadFavorites())
  const [activeIndex, setActiveIndex] = useState(-1)
  const [liveMatches, setLiveMatches] = useState([])
  const [containerWidth, setContainerWidth] = useState(0)
  const listRef = useRef(null)
  const containerRef = useRef(null)
  const searchRef = useRef(null)

  // Étoile « Mes équipes » (E21-B) : suit les DEUX équipes du match (ajoute
  // ou retire les deux ensemble) — persistée en localStorage.
  const handleToggleFavorite = useCallback((home, away) => {
    setFavorites((prev) => {
      const teams = [home, away].filter(Boolean)
      const keys = teams.map(norm)
      const isFav = keys.length > 0 && keys.every((k) => prev.some((t) => norm(t) === k))
      const next = isFav
        ? prev.filter((t) => !keys.includes(norm(t)))
        : [...prev, ...teams.filter((team) => !prev.some((t) => norm(t) === norm(team)))]
      saveFavorites(next)
      return next
    })
  }, [])

  // Export CSV de la vue courante (E21-D) — BOM UTF-8 pour Excel FR.
  const exportCsv = useCallback((list) => {
    try {
      const csv = String.fromCharCode(0xfeff) + buildCsv(list)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `hamdi-pronos-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e) {
      console.warn('[CSV] export impossible:', e?.message || e)
    }
  }, [])

  // Sync filtres -> URL (replace, pas d'historique spam) — E19/E20/E21.
  // Le match ouvert (modale) fait partie de l'état partageable (E20-C).
  useEffect(() => {
    const qs = buildFilterSearch({
      activeLeague,
      activeDate,
      dominantFilter,
      searchQuery,
      onlyRealOdds,
      hideNoBet,
      onlyFavorites,
      matchId: selectedMatch?.id ?? null,
    })
    if (window.location.search !== qs) {
      navigate({ search: qs }, { replace: true })
    }
  }, [
    activeLeague,
    activeDate,
    dominantFilter,
    searchQuery,
    onlyRealOdds,
    hideNoBet,
    onlyFavorites,
    selectedMatch,
    navigate,
  ])

  // Deep link ?match=<id> (E20-C) : ouvre la modale dès que la liste est là.
  const [pendingMatchId] = useState(initialFilters?.matchId ?? null)
  useEffect(() => {
    if (!pendingMatchId || selectedMatch) return
    const m = matches.find((x) => String(x.id) === String(pendingMatchId))
    if (m) setSelectedMatch(m)
  }, [pendingMatchId, matches, selectedMatch])

  // Raccourci clavier : '/' focus recherche, Échap vide + désactive (E19).
  useEffect(() => {
    const onKey = (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearchQuery('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const measure = () => setContainerWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const activeView = PATH_TO_VIEW[location.pathname] || 'all-matches'

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => setIsMobile(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // 🧠 Verrouillage du scroll body quand le drawer mobile est ouvert
  useEffect(() => {
    if (isMobile && sidebarOpen) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = prev
      }
    }
  }, [isMobile, sidebarOpen])

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

  // Subscription live PERMANENTE (E20-D) : alimente la vue /live mais aussi
  // le badge 🔴 du header (visible de toutes les vues). dataService met déjà
  // à jour les matchs terminés → la liste se vide d'elle-même.
  useEffect(() => {
    const unsub = dataService.subscribeLive((data) => {
      setLiveMatches(Array.isArray(data) ? data : [])
    })
    return unsub
  }, [])

  // Précision réelle par bracket de confiance (backtest /api/accuracy/report).
  // Honnête : un match à 72% de confiance affiche la précision RÉELLE du
  // bracket 70-80 (≈53%) au lieu d'un % rassurant jamais atteint.
  useEffect(() => {
    let cancelled = false
    dataService
      .fetchAccuracyReport()
      .then((report) => {
        if (cancelled || !report) return
        const map = {}
        const brackets = report?.latest?.bracketAccuracy
        if (brackets && typeof brackets === 'object') {
          for (const [band, v] of Object.entries(brackets)) {
            if (!v || typeof v.accuracy !== 'number') continue
            map[band] = {
              pct: v.accuracy,
              n: v.count || 0,
              correct: Math.round((v.count || 0) * (v.accuracy / 100)),
            }
          }
        }
        setBracketMap(map)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleRefresh = useCallback(() => dataService.refreshAllData(), [])
  const [scanBusy, setScanBusy] = useState(false)
  const handleForceScan = useCallback(async () => {
    if (scanBusy) return
    setScanBusy(true)
    try {
      await dataService.triggerScanToday()
      setTimeout(() => dataService.refreshAllData(), 30000)
      setTimeout(() => {
        dataService.refreshAllData()
        setScanBusy(false)
      }, 70000)
    } catch {
      setScanBusy(false)
    }
  }, [scanBusy])
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

  const baseList = useMemo(() => {
    // Filtre temporel (AUJOURD'HUI/DEMAIN/3 J/7 J) — jours calendaires locaux.
    // selectEligibleMatches retombe sur les prochains matchs (7 jours) quand la
    // fenêtre active est vide (ex. fin de soirée) afin de ne jamais être vide.
    // Masque reportés/annulés et matchs déjà joués — logique partagée avec
    // Sidebar (timeFilter.js). Puis recherche + LIGUE (corrigé E18 : avant,
    // activeLeague n'était jamais appliqué).
    const nowMs = Date.now()
    const dateFiltered = selectEligibleMatches(matches, activeDate, nowMs)
    return applyQualityFilters(
      applyBaseFilters(dateFiltered, { searchQuery, activeLeague, onlyFavorites, favorites }),
      { onlyRealOdds, hideNoBet }
    )
  }, [
    matches,
    activeDate,
    searchQuery,
    activeLeague,
    onlyRealOdds,
    hideNoBet,
    onlyFavorites,
    favorites,
  ])

  const allMatchesList = useMemo(() => {
    return applyMarketFilter(baseList, dominantFilter)
      .sort((a, b) => {
        // Onglet marché actif : la confiance du marché domine le tri (meilleurs
        // picks d'abord), les critères généraux servent de tie-break.
        if (dominantFilter !== 'ALL' && dominantFilter !== 'corners') {
          const pa = marketPct(toRawLines(a), dominantFilter)
          const pb = marketPct(toRawLines(b), dominantFilter)
          if (pa !== pb) return pb - pa
        }
        // (b) Prioriser en tête les matchs avec vraies probabilités + ligues
        // majeures, afin d'afficher des "vrais pronostics" au lieu des amicaux
        // insuffisants. Le tri par heure reste le tie-break.
        const aProbs =
          parseFloat(a.home_win_probability || a.away_win_probability || a.draw_probability || 0) >
          0
        const bProbs =
          parseFloat(b.home_win_probability || b.away_win_probability || b.draw_probability || 0) >
          0
        const aHasOdds =
          parseFloat(a.odds_home) > 0 && parseFloat(a.odds_draw) > 0 && parseFloat(a.odds_away) > 0
        const bHasOdds =
          parseFloat(b.odds_home) > 0 && parseFloat(b.odds_draw) > 0 && parseFloat(b.odds_away) > 0
        const aInsuff =
          (a.insufficient_data === 1 || a.sufficient === false || a.quant?.market_odds === null) &&
          !aHasOdds
        const bInsuff =
          (b.insufficient_data === 1 || b.sufficient === false || b.quant?.market_odds === null) &&
          !bHasOdds
        const aMajor = isMajorLeague(a.league || a.tournament_name)
        const bMajor = isMajorLeague(b.league || b.tournament_name)
        const aScore = (aProbs && !aInsuff ? 1 : 0) + (aMajor ? 1 : 0) + (aHasOdds ? 2 : 0)
        const bScore = (bProbs && !bInsuff ? 1 : 0) + (bMajor ? 1 : 0) + (bHasOdds ? 2 : 0)
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
  }, [baseList, dominantFilter])

  // Vue LIVE : mêmes filtres que la liste principale (corrigé E18 : avant,
  // recherche/ligue/onglet marché étaient ignorés sur les matchs en direct).
  const liveBaseList = useMemo(
    () =>
      applyQualityFilters(
        applyBaseFilters(liveMatches, { searchQuery, activeLeague, onlyFavorites, favorites }),
        {
          onlyRealOdds,
          hideNoBet,
        }
      ),
    [liveMatches, searchQuery, activeLeague, onlyRealOdds, hideNoBet, onlyFavorites, favorites]
  )
  const liveFilteredList = useMemo(
    () => applyMarketFilter(liveBaseList, dominantFilter),
    [liveBaseList, dominantFilter]
  )
  const liveChipCounts = useMemo(() => computeChipCounts(liveBaseList), [liveBaseList])

  // 🧠 [PERF] Props stables pour la liste virtuelle : le React.memo des rangées
  // ne re-rend que si la liste (contenu) ou le handler changent réellement.
  const matchRowProps = useMemo(
    () => ({
      list: allMatchesList,
      onClick: handleSelectMatch,
      compact: isMobile,
      bracketMap,
      activeMarket: dominantFilter === 'ALL' ? null : dominantFilter,
      activeIndex,
      favorites,
      onToggleFavorite: handleToggleFavorite,
    }),
    [
      allMatchesList,
      handleSelectMatch,
      isMobile,
      bracketMap,
      dominantFilter,
      activeIndex,
      favorites,
      handleToggleFavorite,
    ]
  )

  // Navigation clavier de la liste (E21-A) : ↑/↓ déplacent la surbrillance,
  // Entrée ouvre la modale. Désactivée modale ouverte (elle a ses ←/→) et
  // dans les champs de saisie.
  useEffect(() => {
    const onKey = (e) => {
      if (selectedMatch) return
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return
      const len = allMatchesList.length
      if (!len) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const n = Math.min(activeIndex + 1, len - 1)
        setActiveIndex(n)
        listRef.current?.scrollToRow?.({ index: n, align: 'auto' })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const n = Math.max(activeIndex - 1, 0)
        setActiveIndex(n)
        listRef.current?.scrollToRow?.({ index: n, align: 'auto' })
      } else if (e.key === 'Enter' && activeIndex >= 0 && allMatchesList[activeIndex]) {
        setSelectedMatch(allMatchesList[activeIndex])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [allMatchesList, activeIndex, selectedMatch])

  // Changement de vue : la sélection clavier repart à zéro.
  useEffect(() => {
    setActiveIndex(-1)
  }, [activeDate, activeLeague, dominantFilter, searchQuery, onlyFavorites, onlyRealOdds, hideNoBet])

  // Compteurs d'onglets TOUJOURS calculés sur la liste de base (sans filtre
  // marché) — sinon ils variaient à chaque clic d'onglet (corrigé E18).
  const chipCount = useMemo(() => computeChipCounts(baseList), [baseList])

  const resetAllFilters = useCallback(() => {
    setSearchQuery('')
    setActiveLeague('ALL')
    setDominantFilter('ALL')
    setOnlyRealOdds(false)
    setHideNoBet(false)
    setOnlyFavorites(false)
  }, [])
  const anyFilterActive =
    activeLeague !== 'ALL' ||
    !!searchQuery ||
    dominantFilter !== 'ALL' ||
    onlyRealOdds ||
    hideNoBet ||
    onlyFavorites

  const renderMatchList = (list, counts = chipCount, title = '📊 TOUS LES MATCHS') => {
    const ROW_H = isMobile ? 124 : 56
    const HEADER_H = isMobile ? 0 : 42
    const listHeight = Math.min(list.length * ROW_H, 800)
    const virtualHeight = listHeight - HEADER_H

    const filters = ['ALL', 'ou', 'win', 'btts', 'ht', 'corners']
    const filterLabels = { ALL: 'Tous', ou: 'Over/Under', win: '1X2', btts: 'BTTS', ht: '1er MT', corners: 'Corners' }
    const filterColors = { ALL: '#94a3b8', ou: '#10b981', win: '#00ffaa', btts: '#f87171', ht: '#fbbf24', corners: '#60a5fa' }
    const qualityPillStyle = (active, color) => ({
      fontSize: '9px',
      fontWeight: 800,
      padding: '3px 8px',
      borderRadius: '12px',
      border: `1px solid ${active ? color : 'rgba(255,255,255,0.1)'}`,
      background: active ? `${color}18` : 'rgba(255,255,255,0.03)',
      color: active ? color : '#64748b',
      cursor: 'pointer',
      letterSpacing: '0.4px',
      textTransform: 'uppercase',
      flexShrink: 0,
    })

    const stats = computeQualitySummary(list)

    return (
      <div className="onyx-list-section">
        <div
          className="onyx-section-title global"
          style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}
        >
          <span>{title} ({list.length})</span>
          <span
            style={{ fontSize: '9px', color: '#64748b', fontWeight: 700, letterSpacing: '0.3px', textTransform: 'none' }}
            title="Santé de la vue : matchs avec les 3 cotes 1X2 réelles / sous veto du moteur (E17) / CAC appliqué (E16)"
          >
            · {stats.realOdds} cotes réelles · {stats.vetoed} vetés
            {stats.cacApplied > 0 ? ` · ${stats.cacApplied} CAC` : ''}
          </span>
          <button
            onClick={() => exportCsv(list)}
            disabled={list.length === 0}
            title="Exporter la vue courante (CSV, séparateur ';' Excel, BOM UTF-8)"
            style={{
              marginLeft: 'auto',
              fontSize: '9px',
              fontWeight: 800,
              padding: '2px 8px',
              borderRadius: '8px',
              border: '1px solid rgba(56,189,248,0.35)',
              background: 'rgba(56,189,248,0.08)',
              color: '#38bdf8',
              cursor: list.length === 0 ? 'not-allowed' : 'pointer',
              opacity: list.length === 0 ? 0.4 : 1,
            }}
          >
            ⬇ CSV
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', padding: '6px 8px', flexWrap: 'wrap', alignItems: 'center', overflowX: 'visible', whiteSpace: 'nowrap' }}>
          {filters.map((f) => {
            const count = f === 'ALL' ? list.length : (counts[f] || 0)
            const active = dominantFilter === f
            return (
              <button
                key={f}
                onClick={() => setDominantFilter(f)}
                style={{
                  fontSize: '9px',
                  fontWeight: '800',
                  padding: '3px 8px',
                  borderRadius: '12px',
                  border: `1px solid ${active ? filterColors[f] : 'rgba(255,255,255,0.1)'}`,
                  background: active ? `${filterColors[f]}18` : 'rgba(255,255,255,0.03)',
                  color: active ? filterColors[f] : '#64748b',
                  cursor: 'pointer',
                  letterSpacing: '0.4px',
                  textTransform: 'uppercase',
                  transition: 'all 0.15s',
                  flexShrink: 0,
                }}
              >
                {filterLabels[f]} {count > 0 && `(${count})`}
              </button>
            )
          })}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '6px', flexShrink: 0 }}>
            <button
              onClick={() => setOnlyRealOdds((v) => !v)}
              style={qualityPillStyle(onlyRealOdds, '#a78bfa')}
              title="Ne garder que les matchs avec cotes 1X2 réelles (écarte le mode « est. modèle »)"
            >
              🎯 Cotes réelles
            </button>
            <button
              onClick={() => setHideNoBet((v) => !v)}
              style={qualityPillStyle(hideNoBet, '#34d399')}
              title="Masquer les matchs sous veto du moteur (divergence marché E17 / NO BET)"
            >
              ✅ Sans veto
            </button>
            {favorites.length > 0 && (
              <button
                onClick={() => setOnlyFavorites((v) => !v)}
                style={qualityPillStyle(onlyFavorites, '#fbbf24')}
                title={`Mes équipes (${favorites.length} suivies) — ${favorites.slice(0, 12).join(', ')}${favorites.length > 12 ? '…' : ''}`}
              >
                ⭐ Mes équipes{onlyFavorites ? '' : ` (${favorites.length})`}
              </button>
            )}
          </span>
        </div>
        {anyFilterActive && (
          <div style={{ display: 'flex', gap: '6px', padding: '0 8px 6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '9px', color: '#475569', fontWeight: 800, letterSpacing: '0.4px' }}>
              FILTRES ACTIFS :
            </span>
            {activeLeague !== 'ALL' && (
              <button
                onClick={() => setActiveLeague('ALL')}
                title="Retirer le filtre ligue"
                style={{
                  fontSize: '9px',
                  fontWeight: 800,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  border: '1px solid #f59e0b',
                  background: 'rgba(245,158,11,0.12)',
                  color: '#f59e0b',
                  cursor: 'pointer',
                }}
              >
                🏆 {leagueDisplayLabel(activeLeague)} ✕
              </button>
            )}
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                title="Effacer la recherche"
                style={{
                  fontSize: '9px',
                  fontWeight: 800,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  border: '1px solid #38bdf8',
                  background: 'rgba(56,189,248,0.12)',
                  color: '#38bdf8',
                  cursor: 'pointer',
                }}
              >
                🔍 {searchQuery} ✕
              </button>
            )}
            {onlyFavorites && (
              <button
                onClick={() => setOnlyFavorites(false)}
                title="Retirer le filtre favoris"
                style={{
                  fontSize: '9px',
                  fontWeight: 800,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  border: '1px solid #fbbf24',
                  background: 'rgba(251,191,36,0.12)',
                  color: '#fbbf24',
                  cursor: 'pointer',
                }}
              >
                ⭐ Mes équipes ✕
              </button>
            )}
            {dominantFilter !== 'ALL' && (
              <button
                onClick={() => setDominantFilter('ALL')}
                title="Retirer le filtre marché"
                style={{
                  fontSize: '9px',
                  fontWeight: 800,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  border: `1px solid ${filterColors[dominantFilter]}`,
                  background: `${filterColors[dominantFilter]}18`,
                  color: filterColors[dominantFilter],
                  cursor: 'pointer',
                }}
              >
                {filterLabels[dominantFilter]} ✕
              </button>
            )}
            <button
              onClick={resetAllFilters}
              style={{
                fontSize: '9px',
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: '#64748b',
                cursor: 'pointer',
              }}
            >
              ↺ tout
            </button>
          </div>
        )}
        {list.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 16px', color: '#64748b', fontSize: '12px' }}>
            {activeLeague !== 'ALL'
              ? `Aucun match pour la ligue « ${leagueDisplayLabel(activeLeague)} » dans cette période.`
              : dominantFilter !== 'ALL'
                ? `Aucun match pour le marché "${filterLabels[dominantFilter]}"`
                : searchQuery
                  ? `Aucun résultat pour "${searchQuery}"`
                  : matches.length > 0
                    ? 'Les matchs reçus sont déjà joués — aucun match à venir en base. Lancez un scan pour rafraîchir.'
                    : 'Aucune donnée de match reçue du serveur.'}
            {anyFilterActive && (
              <div style={{ marginTop: 12 }}>
                <button
                  onClick={resetAllFilters}
                  style={{
                    fontSize: '11px',
                    fontWeight: 800,
                    padding: '6px 14px',
                    borderRadius: '8px',
                    border: '1px solid #38bdf8',
                    background: 'rgba(56,189,248,0.12)',
                    color: '#38bdf8',
                    cursor: 'pointer',
                    letterSpacing: '0.4px',
                  }}
                >
                  ↺ Réinitialiser les filtres
                </button>
              </div>
            )}
            {!anyFilterActive && (
              <div style={{ marginTop: 12 }}>
                <button
                  onClick={handleForceScan}
                  disabled={scanBusy}
                  style={{
                    fontSize: '11px',
                    fontWeight: 800,
                    padding: '6px 14px',
                    borderRadius: '8px',
                    border: '1px solid #10b981',
                    background: 'rgba(16,185,129,0.12)',
                    color: '#10b981',
                    cursor: scanBusy ? 'wait' : 'pointer',
                    letterSpacing: '0.4px',
                  }}
                >
                  {scanBusy ? '⏳ Scan en cours…' : '⚡ Forcer le scan'}
                </button>
              </div>
            )}
          </div>
        )}
        <div style={{ width: '100%', '--mc-cols': mcColumnsCss() }} ref={containerRef}>
          {!isMobile && containerWidth > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `var(--mc-cols, ${MC_COLS_FALLBACK})`,
                width: containerWidth,
                borderBottom: '2px solid #1e293b',
                padding: '8px 0',
                fontSize: '11px',
                color: '#64748b',
                textTransform: 'uppercase',
                fontWeight: '800',
                letterSpacing: '0.8px',
                background: 'rgba(0,0,0,0.3)',
                flexShrink: 0,
                boxSizing: 'border-box',
              }}
            >
              {TABLE_COLUMNS.map((c) => (
                <div key={c.key} style={{ minWidth: c.min, padding: '0 8px', boxSizing: 'border-box' }}>
                  {c.label}
                </div>
              ))}
            </div>
          )}
          <div style={{ height: virtualHeight }}>
            <List
              ref={listRef}
              height={virtualHeight}
              rowCount={list.length}
              rowHeight={ROW_H}
              rowProps={matchRowProps}
              width={containerWidth > 0 ? containerWidth : '100%'}
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
          favorites={favorites}
          onToggleFavorite={handleToggleFavorite}
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
          favorites={favorites}
          onToggleFavorite={handleToggleFavorite}
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
        favorites={favorites}
        onToggleFavorite={handleToggleFavorite}
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
          count={allMatchesList.length}
          liveCount={liveMatches.length}
          onGoLive={() => navigate('/live')}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
        />

          <div className="titanium-scroll">
            {activeView === 'live' && liveMatches.length > 0 && (
              <div className="onyx-grid-container" style={{ padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', background: 'rgba(239,68,68,0.08)', borderRadius: '8px', marginBottom: '8px', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <span style={{ fontSize: '11px', fontWeight: '900', color: '#ef4444', letterSpacing: '0.5px' }}>
                    🔴 {liveMatches.length} MATCH{liveMatches.length > 1 ? 'S' : ''} EN DIRECT
                  </span>
                  <span style={{ fontSize: '9px', color: '#64748b' }}>rafraîchissement toutes les 10s</span>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 0', marginBottom: '4px' }}>
                  <span style={{ fontSize: '10px', color: '#ef4444', fontWeight: '700' }}>
                    ⚽ LIVE STATS
                  </span>
                </div>
                {renderMatchList(liveFilteredList, liveChipCounts, '🔴 MATCHS EN DIRECT')}
              </div>
            )}
            {activeView === 'live' && liveMatches.length === 0 && (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: '#64748b' }}>
                <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚽</div>
                <div style={{ fontSize: '13px', fontWeight: '700', marginBottom: '4px' }}>Aucun match en direct</div>
                <div style={{ fontSize: '11px' }}>Les matchs live apparaîtront automatiquement ici</div>
              </div>
            )}
            {activeView === 'promosport' ? (
            <Suspense fallback={<LoadingSkeleton type="table" label="Promosport IA..." />}>
              <Promosport />
            </Suspense>
          ) : activeView === 'millionaire' ? (
            <Suspense fallback={<LoadingSkeleton type="table" label="Top Picks du Jour..." />}>
              <TopPicksWidget />
              <ProPlanWidget />
            </Suspense>
          ) : activeView === 'flash-odds' ? (
            <Suspense fallback={<LoadingSkeleton type="table" label="Flash Odds..." />}>
              <FlashOddsView />
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
                    ref={searchRef}
                    type="text"
                    placeholder="🔍 Rechercher une équipe… (touche /)"
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
          <UltimateMatchCenter
            match={selectedMatch}
            navList={allMatchesList}
            onNavigate={handleSelectMatch}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            onClose={() => setSelectedMatch(null)}
            reliability={
              selectedMatch?.confidence && bracketMap[bandOf(selectedMatch.confidence)]
                ? bracketMap[bandOf(selectedMatch.confidence)]
                : undefined
            }
          />
        </Suspense>
      )}
    </div>
  )
}

export default Dashboard
