import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import MatchCard from './MatchCard'
import dataService from '../services/dataService'
import { ROUTES, PATH_TO_VIEW } from '../config/routes'
import { filterMatchesInWindow } from '../utils/timeFilter'
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

const FINISHED_STATUSES = new Set(['finished', 'ft', 'ended', 'closed', 'played', 'aet', 'pen'])

// Ligues majeures (différençables par xG fbref/StatsBomb) : priorité d'affichage
// afin de montrer en premier les "vrais pronostics" (objectif b) au lieu des
// amicaux/coupes insuffisants.
const MAJOR_LEAGUE_RE =
  /premier league|championship|champions league|europa league|ligue [12]|bundesliga|serie [ab]|la liga|liga portugal|eredivisie|mls|liga mx|j1 league|k league|scottish premiership|primera division|brasileirão/i
const isMajorLeague = (name) => MAJOR_LEAGUE_RE.test(String(name || ''))

const isFinishedMatch = (m) => {
  const s = String(m.status || '').toLowerCase()
  if (FINISHED_STATUSES.has(s)) return true
  const sh = parseInt(m.scoreHome)
  const sa = parseInt(m.scoreAway)
  if (!isNaN(sh) && !isNaN(sa) && s !== 'scheduled' && s !== 'NOT_STARTED' && s !== 'NS')
    return true
  return false
}

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

const computeRawLines = (m) => {
  if (!m) return []
  const finished = isFinishedMatch(m)
  const score =
    finished && m.scoreHome != null && m.scoreAway != null ? `${m.scoreHome}-${m.scoreAway}` : '--'
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
      '0',
    ]
  }
  const enriched = m.enriched || {}
  const quant = m.quant || enriched?.quant || {}
  const markets = quant.markets || {}
  const normalizePct = (v) => {
    const n = Number(v || 0)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n > 1 ? Math.round(n) : Math.round(n * 100)
  }

  // ── HONESTY GATE: données bookmaker réelles absentes (synthetic/insufficient) → pas de pick ──
  const isInsufficient =
    m.insufficient_data === 1 || m.sufficient === false || quant.market_odds === null

  // ── BTTS → verdict OUI/NON ──
  let bttsLabel = '--'
  let bttsYesPct = 0
  const bttsMkt = markets.btts
  if (bttsMkt && (bttsMkt.YES || bttsMkt.NO)) {
    const yes = normalizePct(bttsMkt.YES?.prob)
    const no = normalizePct(bttsMkt.NO?.prob)
    bttsYesPct = yes
    bttsLabel = yes >= no ? `OUI ${yes}%` : `NON ${no}%`
  } else {
    const bttsPct = normalizePct(quant.probs?.btts || m.btts_prob || enriched?.btts_prob || 0)
    bttsYesPct = bttsPct
    bttsLabel = bttsPct > 0 ? (bttsPct >= 50 ? `OUI ${bttsPct}%` : `NON ${100 - bttsPct}%`) : '--'
  }

  // ── O/U 2.5 → proba Over (barre) ──
  const ouMkt = markets.over_under
  let ouPct = normalizePct(quant.probs?.over25 || m.ou_25_prob || enriched?.ou_25_prob || 0)
  if (ouMkt && (ouMkt['O2.5'] || ouMkt['U2.5'])) {
    const o25 = normalizePct(ouMkt['O2.5']?.prob)
    const u25 = normalizePct(ouMkt['U2.5']?.prob)
    ouPct = o25 > 0 ? o25 : u25 > 0 ? 100 - u25 : ouPct
  }

  // ── GAGNANT → base solide (≥65%) ou double chance si douteux ──
  const mr = markets.match_result || {}
  const dc = markets.double_chance || {}
  const mainPickRaw = (quant.main_pick || '').toString().trim().toUpperCase()
  const pickProbOf = (pick) => {
    if (!pick) return null
    const found = (quant.all_picks || []).find((p) => String(p.val).toUpperCase() === pick)
    if (found && normalizePct(found.prob) > 0) return normalizePct(found.prob)
    if (dc[pick]) return normalizePct(dc[pick].prob)
    if (mr[pick]) return normalizePct(mr[pick].prob)
    return null
  }

  const hPct = mr['1']?.prob
    ? normalizePct(mr['1'].prob)
    : normalizePct(m.home_win_probability || enriched?.home_win_probability || 0)
  const dPct = mr['X']?.prob
    ? normalizePct(mr['X'].prob)
    : normalizePct(m.draw_probability || enriched?.draw_probability || 0)
  const aPct = mr['2']?.prob
    ? normalizePct(mr['2'].prob)
    : normalizePct(m.away_win_probability || enriched?.away_win_probability || 0)
  const hasProbs = hPct + dPct + aPct > 0

  let winner = mainPickRaw || '?'
  let winnerProb = pickProbOf(winner)
  if (hasProbs) {
    const maxP = Math.max(hPct, dPct, aPct)
    if (maxP >= 65) {
      // Favori net → base solide (pick simple)
      winner = maxP === hPct ? '1' : maxP === aPct ? '2' : 'X'
      winnerProb = maxP
    } else if (['1', 'X', '2'].includes(winner)) {
      // Pick simple mais match douteux → meilleure double chance selon les données
      const combos = [
        { k: '1X', p: hPct + dPct },
        { k: '12', p: hPct + aPct },
        { k: 'X2', p: dPct + aPct },
      ].sort((a, b) => b.p - a.p)
      winner = combos[0].k
      winnerProb = combos[0].p
    }
  }
  const winnerLabel = winnerProb ? `${winner} ${Math.round(winnerProb)}%` : winner

  // ── BASE SOLIDE GAGNANT → pick simple 1/2 à ≥65% (seuil du front) ──
  const solidGagnant =
    ['1', '2'].includes(String(winner)) && typeof winnerProb === 'number' && winnerProb >= 65

  // ── CORNERS → verdict O/U (nombre total attendu) ──
  const cornersVerdict = m.cornersVerdict || m.enriched?.cornersVerdict || null
  let cornersLabel = '--'
  if (cornersVerdict && typeof cornersVerdict.expectedTotal === 'number') {
    const line = cornersVerdict.line ?? 10.5
    const over = Number(cornersVerdict.over ?? 0)
    const under = Number(cornersVerdict.under ?? 0)
    const verdict = over >= under ? 'O' : 'U'
    const pct = Math.round(Math.max(over, under) * 100)
    cornersLabel = `${verdict} ${line.toFixed(1)} ${pct}%`
  }

  // ── HANDICAP (indice de score / score attendu) ──
  const htPct = Math.min(89, Math.round((ouPct + bttsYesPct) / 2 + 5))

  // ── HONESTY GATE OPTIONNELLE (user "je veux voir le prono côtout") ──
  // Pour un match sans cotes bookmaker réelles (isInsufficient), on n'expose le
  // pronostic que si le modèle produit des PROBABILITÉS RÉELLEMENT DIFFÉRENTIÉES
  // (max >= 50 et écart >= 20 points) — i.e. un vrai signal Poisson/xG, pas le
  // fallback uniforme ~33/33/33. Badge "🔮 modèle — sans cotes (pas d'EV)" pour
  // rester honnête : aucune valeur probatte ni EV n'est affichée sans cotes.
  const rawHPct = normalizePct(m.home_win_probability || enriched?.home_win_probability || 0)
  const rawAPct = normalizePct(m.away_win_probability || enriched?.away_win_probability || 0)
  const rawDPct = normalizePct(m.draw_probability || enriched?.draw_probability || 0)
  const modelMax = Math.max(rawHPct, rawAPct, rawDPct)
  const modelMin = Math.min(rawHPct, rawAPct, rawDPct)
  const hasRealModelSignal =
    isInsufficient &&
    modelMax >= 50 &&
    modelMax - modelMin >= 20 &&
    (hPct + aPct > 0 || rawHPct > 0)
  const modelWinner =
    rawHPct >= rawAPct && rawHPct >= rawDPct ? '1' : rawAPct >= rawDPct ? '2' : 'X'
  const modelWinnerProb = modelWinner === '1' ? rawHPct : modelWinner === '2' ? rawAPct : rawDPct

  // ── MODEL-ONLY PICK: le backend a validé un signal modèle (sufficient=true) mais
  // sans cotes bookmaker réelles → on affiche le pick avec le badge 🔮 pour ne pas le
  // faire passer pour un pronostic avec cotes/EV. (Le "bon chemin" : honnête, pas masqué.)
  const hasRealOddsShown =
    parseFloat(m.odds_home) > 0 && parseFloat(m.odds_draw) > 0 && parseFloat(m.odds_away) > 0
  const isModelOnlyPick =
    !isInsufficient && !hasRealOddsShown && String(m.prediction || '').trim() !== ''
  const pickLabel = winnerProb ? `${winner} ${Math.round(winnerProb)}%` : winner

  // ── HONENETE: aucune donnée bookmaker réelle → pas de verdict par défaut ──
  if (isModelOnlyPick) {
    return [
      `${m.league || m.tournament_name || ''} 🔮 modèle — sans cotes (pas d'EV)`,
      m.homeTeam || '',
      m.awayTeam || '',
      bttsLabel,
      `${ouPct}%`,
      pickLabel,
      `${htPct}%`,
      cornersLabel,
      null,
      solidGagnant ? '1' : '0',
    ]
  }
  if (hasRealModelSignal) {
    return [
      `${m.league || m.tournament_name || ''} 🔮 modèle`,
      m.homeTeam || '',
      m.awayTeam || '',
      bttsLabel,
      `${ouPct}%`,
      `${modelWinner} ${Math.round(modelWinnerProb)}%`,
      `${htPct}%`,
      cornersLabel,
      null,
      solidGagnant ? '1' : '0',
    ]
  }
  if (isInsufficient) {
    // 🔮 Estimation statistique (Poisson/xG) — pas de cotes bookmaker réelles,
    // donc aucune EV/valeur affichée. Badge distinct pour rester honnête.
    const totalP = hPct + dPct + aPct
    let statWinner = '--'
    let statWinnerProb = 0
    if (totalP > 0) {
      const maxP = Math.max(hPct, dPct, aPct)
      if (maxP >= 65) {
        statWinner = maxP === hPct ? '1' : maxP === aPct ? '2' : 'X'
        statWinnerProb = maxP
      } else {
        const combos = [
          { k: '1X', p: hPct + dPct },
          { k: '12', p: hPct + aPct },
          { k: 'X2', p: dPct + aPct },
        ].sort((a, b) => b.p - a.p)
        statWinner = combos[0].k
        statWinnerProb = combos[0].p
      }
    }
    return [
      `${m.league || m.tournament_name || ''} 🔮 estimation sans cotes`,
      m.homeTeam || '',
      m.awayTeam || '',
      bttsLabel,
      ouPct > 0 ? `${ouPct}%` : '--',
      statWinnerProb > 0 ? `${statWinner} ${Math.round(statWinnerProb)}%` : '--',
      totalP > 0 ? `${htPct}%` : '--',
      cornersLabel,
      null,
      '0',
    ]
  }
  // ── Cas normal : cotes suffisantes → verdict complet ──
  return [
    m.league || m.tournament_name || '',
    m.homeTeam || '',
    m.awayTeam || '',
    bttsLabel,
    `${ouPct}%`,
    winnerLabel,
    `${htPct}%`,
    cornersLabel,
    null,
    solidGagnant ? '1' : '0',
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
