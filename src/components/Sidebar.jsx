import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROUTES, NAV_ITEMS } from '../config/routes'
import { useTheme } from '../contexts/ThemeContext'
import { useI18n } from '../contexts/I18nContext'
import { selectEligibleMatches } from '../utils/timeFilter'
import { PINNED_LEAGUES, MENA_LEAGUES } from '../data/leagues'
import { norm } from '../utils/dashboardFilters'
import dataService from '../services/dataService'
import './Sidebar.css'

// PINNED_LEAGUES / MENA_LEAGUES : source de vérité déplacée dans
// src/data/leagues.js (partagée avec dashboardFilters.js pour le filtre ligue).
const Sidebar = ({
  activeLeague,
  onLeagueChange,
  matches = [],
  activeView,
  activeDate,
  onDateChange,
  isOpen = true,
  favorites = [],
  onToggleFavorite,
}) => {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()
  const { locale, setLocale, t } = useI18n()

  const handleNav = (view) => {
    navigate(ROUTES[view] || '/')
  }

  const [scanBusy, setScanBusy] = useState(false)
  const handleForceScan = async () => {
    if (scanBusy) return
    setScanBusy(true)
    try {
      await dataService.triggerScanToday()
      setTimeout(() => dataService.refreshAllData(), 30000)
    } catch {
      /* le polling 60s rattrape le refresh */
    }
    setTimeout(() => setScanBusy(false), 70000)
  }

  // 🧠 [PERF] Calculs mémoïsés : ne se recalculent que si les matches ou la
  // fenêtre temporelle changent réellement (pas à chaque render de parent).
  const { activeCounts, pinnedWithCounts, menaWithCounts, otherLeagues, totalFilteredMatches } =
    useMemo(() => {
      const counts = {}

      // Compteurs restreints à la fenêtre temporelle active (jours locaux).
      // Logique partagée avec Dashboard (src/utils/timeFilter.js) — corrige
      // l'off-by-one des bornes 3/7 jours ("N jours incluant aujourd'hui").
      // On applique aussi isMatchEligible : le total du Sidebar est alors
      // TOUJOURS égal au nombre de matchs réellement listés dans le Dashboard.
      // selectEligibleMatches retombe sur les prochains matchs (7 jours)
      // quand la fenêtre active est vide → compteurs synchronisés.
      const nowMs = Date.now()
      selectEligibleMatches(matches, activeDate, nowMs)
        .forEach((m) => {
          const l = (m.league || 'Unknown').toLowerCase()
          counts[l] = (counts[l] || 0) + 1
        })

      const pinnedWithCounts = PINNED_LEAGUES.map((pinned) => {
        let count = 0
        Object.keys(counts).forEach((activeLeagueName) => {
          const isMena = MENA_LEAGUES.some((mena) =>
            mena.keywords.some((kw) => activeLeagueName.includes(kw))
          )
          if (!isMena && pinned.keywords.some((kw) => activeLeagueName.includes(kw))) {
            count += counts[activeLeagueName]
          }
        })
        return { ...pinned, count }
      })

      const menaWithCounts = MENA_LEAGUES.map((mena) => {
        let count = 0
        Object.keys(counts).forEach((activeLeagueName) => {
          if (mena.keywords.some((kw) => activeLeagueName.includes(kw))) {
            count += counts[activeLeagueName]
          }
        })
        return { ...mena, count }
      })

      const isPinnedOrMena = (leagueName) => {
        const lower = leagueName.toLowerCase()
        return (
          PINNED_LEAGUES.some((p) => p.keywords.some((kw) => lower.includes(kw))) ||
          MENA_LEAGUES.some((m) => m.keywords.some((kw) => lower.includes(kw)))
        )
      }

      const getCountryForOther = (name) => {
        const lower = name.toLowerCase()
        if (lower.includes('algerian')) return '🇩🇿 Algérie : '
        if (lower.includes('tunisian')) return '🇹🇳 Tunisie : '
        if (lower.includes('egyptian')) return '🇪🇬 Égypte : '
        if (lower.includes('moroccan') || lower.includes('botola')) return '🇲🇦 Maroc : '
        if (lower.includes('premier league')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Angleterre : '
        if (lower.includes('laliga')) return '🇪🇸 Espagne : '
        if (lower.includes('serie a')) return '🇮🇹 Italie : '
        if (lower.includes('bundesliga')) return '🇩🇪 Allemagne : '
        if (lower.includes('brazil')) return '🇧🇷 Brésil : '
        if (lower.includes('usa') || lower.includes('mls')) return '🇺🇸 USA : '
        return '⚽ '
      }

      const otherLeagues = Object.entries(counts)
        .filter(([name]) => !isPinnedOrMena(name))
        .map(([name, count]) => {
          // Troncature centrée : on garde le DÉBUT (drapeau + nom) et la FIN
          // (suffixe distinctif "GROUP A/B", "ROUND OF 32"…) pour éviter que
          // deux ligues différentes ne deviennent identiques une fois coupées.
          const label = (
            getCountryForOther(name) + name.replace(/^([A-Za-z]+ )(\1)/i, '$1').toUpperCase()
          )
          const short = (s) => {
            if (s.length <= 34) return s
            return s.slice(0, 15) + '…' + s.slice(-16)
          }
          return { id: name, name: short(label), count }
        })
        .sort((a, b) => a.name.localeCompare(b.name))

      const totalFilteredMatches = Object.values(counts).reduce((a, b) => a + b, 0)

      return { activeCounts: counts, pinnedWithCounts, menaWithCounts, otherLeagues, totalFilteredMatches }
    }, [matches, activeDate])

  // Fenetre temporelle courante, reusee pour compter les matchs des equipes favorites.
  const favEligible = useMemo(
    () => (favorites.length ? selectEligibleMatches(matches || [], activeDate, Date.now()) : []),
    [favorites, matches, activeDate]
  )

  return (
    <aside className={`flash-sidebar ${isOpen ? '' : 'collapsed'}`}>
      <div className="flash-sidebar-header">
        <h2>Laboratoire Hamdi</h2>
        <div
          style={{
            fontSize: '8px',
            color: '#1e3a4a',
            fontWeight: '700',
            letterSpacing: '1.5px',
            marginTop: '3px',
            textTransform: 'uppercase',
          }}
        >
          ⚡ TITANIUM NEURAL-X v3.0
        </div>
      </div>

      <div className="flash-nav-section">
        {/* ── LIVE NOW ─────────────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'live' ? 'active' : ''}`}
          onClick={() => handleNav('live')}
          style={{
            marginBottom: '8px',
            background:
              activeView === 'live'
                ? 'linear-gradient(90deg, rgba(239,68,68,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'live' ? '2px solid #ef4444' : 'none',
            color: '#ef4444',
          }}
        >
          <span className="flash-icon">🔴</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            LIVE NOW
          </span>
        </button>

        {/* ── ALL MATCHES SCANNER ────────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'all-matches' ? 'active' : ''}`}
          onClick={() => handleNav('all-matches')}
          style={{
            background:
              activeView === 'all-matches'
                ? 'linear-gradient(90deg, rgba(148,163,184,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'all-matches' ? '2px solid #94a3b8' : 'none',
            color: '#94a3b8',
            marginBottom: '8px',
          }}
        >
          <span className="flash-icon">📊</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            {t('sidebar.allMatches')}
          </span>
          <span
            className="flash-count"
            style={{
              background: '#334155',
              color: '#fff',
              padding: '1px 6px',
              borderRadius: '4px',
            }}
          >
            {totalFilteredMatches}
          </span>
        </button>

        {/* ── TOP PICKS DU JOUR ─────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'millionaire' ? 'active' : ''}`}
          onClick={() => handleNav('millionaire')}
          style={{
            marginTop: '4px',
            background:
              activeView === 'millionaire'
                ? 'linear-gradient(90deg, rgba(251,191,36,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'millionaire' ? '2px solid #fbbf24' : 'none',
            color: '#fbbf24',
          }}
        >
          <span className="flash-icon">🎯</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            TOP PICKS DU JOUR
          </span>
        </button>

        {/* ── PROMOSPORT ─────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'promosport' ? 'active' : ''}`}
          onClick={() => handleNav('promosport')}
          style={{
            marginTop: '4px',
            background:
              activeView === 'promosport'
                ? 'linear-gradient(90deg, rgba(16,185,129,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'promosport' ? '2px solid #10b981' : 'none',
            color: '#10b981',
          }}
        >
          <span className="flash-icon">💰</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            PROMOSPORT
          </span>
        </button>

        {/* ── MARCHÉS ─────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'markets' ? 'active' : ''}`}
          onClick={() => handleNav('markets')}
          style={{
            marginTop: '4px',
            background:
              activeView === 'markets'
                ? 'linear-gradient(90deg, rgba(168,85,247,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'markets' ? '2px solid #a855f7' : 'none',
            color: '#a855f7',
          }}
        >
          <span className="flash-icon">📊</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            MARCHÉS
          </span>
        </button>

        {/* ── SUIVI DES PARIS ─────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'bets' ? 'active' : ''}`}
          onClick={() => handleNav('bets')}
          style={{
            marginTop: '4px',
            background:
              activeView === 'bets'
                ? 'linear-gradient(90deg, rgba(245,158,11,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'bets' ? '2px solid #f59e0b' : 'none',
            color: '#f59e0b',
          }}
        >
          <span className="flash-icon">📈</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            SUIVI DES PARIS
          </span>
        </button>

        {/* ── ENTRAÎNEMENT ─────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'training' ? 'active' : ''}`}
          onClick={() => handleNav('training')}
          style={{
            marginTop: '4px',
            background:
              activeView === 'training'
                ? 'linear-gradient(90deg, rgba(139,92,246,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'training' ? '2px solid #8b5cf6' : 'none',
            color: '#8b5cf6',
          }}
        >
          <span className="flash-icon">🧠</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            ENTRAÎNEMENT
          </span>
        </button>

        {/* ── FIABILITÉ (métrique honnête) ─────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'accuracy' ? 'active' : ''}`}
          onClick={() => handleNav('accuracy')}
          style={{
            marginTop: '4px',
            background:
              activeView === 'accuracy'
                ? 'linear-gradient(90deg, rgba(244,63,94,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'accuracy' ? '2px solid #f43f5e' : 'none',
            color: '#f43f5e',
          }}
        >
          <span className="flash-icon">🎛️</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            FIABILITÉ
          </span>
        </button>

        {/* ── FLASH ODDS / LIVE ODDS ─────────────────── */}
        <button
          className={`flash-nav-item ${activeView === 'flash-odds' ? 'active' : ''}`}
          onClick={() => handleNav('flash-odds')}
          style={{
            marginTop: '4px',
            background:
              activeView === 'flash-odds'
                ? 'linear-gradient(90deg, rgba(99,102,241,0.15) 0%, transparent 100%)'
                : 'transparent',
            borderLeft: activeView === 'flash-odds' ? '2px solid #6366f1' : 'none',
            color: '#6366f1',
          }}
        >
          <span className="flash-icon">⚡</span>
          <span className="flash-label" style={{ fontWeight: 'bold' }}>
            FLASH ODDS / LIVE ODDS
          </span>
        </button>
      </div>

      <div className="flash-nav-section">
        <h3 className="flash-section-title" style={{ color: '#64748b' }}>
          📅 {t('sidebar.filterTemporal')}
        </h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px',
            padding: '4px 10px 10px',
          }}
        >
          {['Today', 'Tomorrow', 'Next 3 Days', 'Next 7 Days'].map((date) => {
            const labels = {
              Today: "AUJOURD'HUI",
              Tomorrow: 'DEMAIN',
              'Next 3 Days': '3 JOURS',
              'Next 7 Days': '7 JOURS',
            }
            const isActive = activeDate === date
            return (
              <button
                key={date}
                className={`date-filter-btn ${isActive ? 'active' : ''}`}
                onClick={() => onDateChange?.(date)}
                style={{
                  padding: '7px 5px',
                  fontSize: '9.5px',
                  background: isActive
                    ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                    : 'rgba(255,255,255,0.04)',
                  color: isActive ? '#000' : '#64748b',
                  border: isActive ? 'none' : '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: isActive ? '900' : '600',
                  letterSpacing: '0.4px',
                  transition: 'all 0.18s ease',
                  fontFamily: "'JetBrains Mono', monospace",
                  boxShadow: isActive ? '0 2px 10px rgba(245,158,11,0.3)' : 'none',
                }}
              >
                {labels[date]}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flash-nav-section">
        <h3
          className="flash-section-title"
          style={{ color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          🏆 LIGUES ACTIVES
        </h3>

        {/* 1. Merged Fixed/Best Leagues at top if active */}
        {pinnedWithCounts
          .filter((l) => l.count > 0)
          .map((league) => (
            <button
              key={league.id}
              className={`flash-nav-item ${activeLeague === league.keywords[0] ? 'active' : ''}`}
              onClick={() => {
                handleNav('matches')
                onLeagueChange(league.keywords[0])
              }}
              style={{
                borderLeft: activeLeague === league.keywords[0] ? '2px solid #f59e0b' : 'none',
              }}
            >
              <span className="flash-icon">{league.flag}</span>
              <span className="flash-label" style={{ fontWeight: '600' }}>
                {league.name}
              </span>
              <span className="flash-count">{league.count}</span>
            </button>
          ))}

        {/* 2. All other active leagues sorted alphabetically */}
        {otherLeagues.map((league) => (
          <button
            key={league.id}
            className={`flash-nav-item ${activeLeague === league.id ? 'active' : ''}`}
            onClick={() => {
              handleNav('matches')
              onLeagueChange(league.id)
            }}
          >
            <span className="flash-icon">⚽</span>
            <span className="flash-label">{league.name}</span>
            <span className="flash-count">{league.count}</span>
          </button>
        ))}
      </div>

      {menaWithCounts.some((l) => l.count > 0) && (
        <div className="flash-nav-section">
          <h3
            className="flash-section-title"
            style={{
              color: '#10b981',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginTop: '10px',
            }}
          >
            🌙 MENA / MONDE ARABE
          </h3>

          {menaWithCounts
            .filter((l) => l.count > 0)
            .map((league) => (
              <button
                key={league.id}
                className={`flash-nav-item ${activeLeague === league.keywords[0] ? 'active' : ''}`}
                onClick={() => {
                  handleNav('matches')
                  onLeagueChange(league.keywords[0])
                }}
                style={{
                  borderLeft: activeLeague === league.keywords[0] ? '2px solid #10b981' : 'none',
                }}
              >
                <span className="flash-icon">{league.flag}</span>
                <span className="flash-label" style={{ fontWeight: '600' }}>
                  {league.name}
                </span>
                <span className="flash-count">{league.count}</span>
              </button>
            ))}
        </div>
      )}

      <div className="flash-nav-section">
        {/* 3. Show fallback if absolutely no leagues are active */}
        {pinnedWithCounts.every((l) => l.count === 0) &&
          menaWithCounts.every((l) => l.count === 0) &&
          otherLeagues.length === 0 && (
            <div
              style={{
                padding: '20px',
                fontSize: '11px',
                color: '#64748b',
                textAlign: 'center',
                background: 'rgba(0,0,0,0.2)',
                borderRadius: '8px',
              }}
            >
              Aucune ligue active pour cette date.
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={handleForceScan}
                  disabled={scanBusy}
                  style={{
                    fontSize: '10px',
                    fontWeight: 800,
                    padding: '5px 12px',
                    borderRadius: '8px',
                    border: '1px solid #10b981',
                    background: 'rgba(16,185,129,0.12)',
                    color: '#10b981',
                    cursor: scanBusy ? 'wait' : 'pointer',
                    letterSpacing: '0.4px',
                  }}
                >
                  {scanBusy ? '⏳ Scan…' : '⚡ Forcer le scan'}
                </button>
              </div>
            </div>
          )}
      </div>

      {favorites.length > 0 && (
        <div className="flash-nav-section">
          <h3
            className="flash-section-title"
            style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            ⭐ MES ÉQUIPES
          </h3>
          {favorites.map((team) => {
            const k = norm(team)
            const n = (favEligible || []).filter(
              (m) => norm(m.homeTeam) === k || norm(m.awayTeam) === k
            ).length
            return (
              <div
                key={team}
                className="flash-nav-item"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'default' }}
              >
                <span className="flash-label" title={team} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {team}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="flash-count">{n}</span>
                  {onToggleFavorite && (
                    <button
                      onClick={() => onToggleFavorite(team, '')}
                      title={`Ne plus suivre ${team}`}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#64748b',
                        cursor: 'pointer',
                        fontSize: '11px',
                        padding: 0,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div
        className="flash-nav-section"
        style={{
          marginTop: 'auto',
          paddingTop: '8px',
          borderTop: '1px solid var(--sidebar-border)',
        }}
      >
        <button
          onClick={toggleTheme}
          className="flash-nav-item"
          style={{
            background: 'transparent',
            color: 'var(--text-muted)',
            borderLeft: 'none',
          }}
        >
          <span className="flash-icon">{theme === 'dark' ? '☀️' : '🌙'}</span>
          <span className="flash-label" style={{ fontWeight: '600' }}>
            {theme === 'dark' ? 'MODE CLAIR' : 'MODE SOMBRE'}
          </span>
        </button>
      </div>
    </aside>
  )
}

export default React.memo(Sidebar)
