import React from 'react'
import { useNavigate } from 'react-router-dom'
import { ROUTES } from '../config/routes'
import { useTheme } from '../contexts/ThemeContext'
import './Sidebar.css'

const Sidebar = ({ activeView }) => {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()

  const handleNav = (view) => {
    navigate(ROUTES[view] || '/')
  }

  return (
    <aside className="flash-sidebar">
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
            TOUS LES MATCHS
          </span>
        </button>

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
      </div>

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

export default Sidebar
