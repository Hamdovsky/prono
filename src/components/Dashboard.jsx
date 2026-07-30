import React, { useState, useEffect, useMemo, Suspense, lazy } from 'react'
import { useLocation } from 'react-router-dom'
import MatchCard from './MatchCard'
import dataService from '../services/dataService'
import { PATH_TO_VIEW } from '../config/routes'
import LoadingSkeleton from './LoadingSkeleton'

import './Dashboard.css'

const Promosport = lazy(() => import('./Promosport'))

const toRawLines = (m) => {
  if (!m) return []
  const quant = m.quant || m.enriched?.quant || {}
  const normalizePct = (v) => {
    const n = Number(v || 0)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n > 1 ? Math.round(n) : Math.round(n * 100)
  }
  const bttsPct = normalizePct(quant.probs?.btts || m.btts_prob || m.enriched?.btts_prob || 0)
  const over25Pct = normalizePct(quant.probs?.over25 || m.ou_25_prob || m.enriched?.ou_25_prob || 0)
  const htPct = Math.min(89, Math.round((over25Pct + bttsPct) / 2 + 5))

  return [
    m.league || m.tournament_name || '',
    m.homeTeam || '',
    m.awayTeam || '',
    `${bttsPct}%`,
    `${over25Pct}%`,
    `${htPct}%`,
  ]
}

const MatchRowMemo = React.memo(({ index, style, list, onClick }) => {
  const m = list[index]
  if (!m) return null
  return <MatchCard rawData={toRawLines(m)} onClick={onClick} style={style} />
})

const Dashboard = () => {
  const [matches, setMatches] = useState([])
  const [status, setStatus] = useState('idle')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMatch, setSelectedMatch] = useState(null)
  const activeView = PATH_TO_VIEW[useLocation().pathname] || 'matches'

  useEffect(() => {
    const unsubUpcoming = dataService.subscribeUpcoming((data) => {
      if (Array.isArray(data)) setMatches(data)
    })
    const unsubStatus = dataService.subscribeStatus(setStatus)
    return () => { unsubUpcoming(); unsubStatus() }
  }, [])

  const handleRefresh = () => dataService.refreshAllData()

  const filteredMatches = useMemo(() => {
    return matches.filter((m) => {
      const s = String(m.status || '').toLowerCase()
      if (['finished', 'ft', 'ended', 'closed', 'played', 'aet', 'pen', 'postponed', 'canceled'].includes(s)) return false
      if (m.actualResult && m.actualResult !== 'N/A' && m.actualResult.trim() !== '') return false

      if (searchQuery) {
        const q = searchQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        const home = (m.homeTeam || '').toLowerCase()
        const away = (m.awayTeam || '').toLowerCase()
        const league = (m.league || m.tournament_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        if (!home.includes(q) && !away.includes(q) && !league.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      const aTime = a.startTimestamp ? (a.startTimestamp > 1e11 ? a.startTimestamp : a.startTimestamp * 1000) : 0
      const bTime = b.startTimestamp ? (b.startTimestamp > 1e11 ? b.startTimestamp : b.startTimestamp * 1000) : 0
      return aTime - bTime
    })
  }, [matches, searchQuery])

  if (activeView === 'promosport') return (
    <Suspense fallback={<LoadingSkeleton type="table" label="Promosport IA..." />}>
      <Promosport />
    </Suspense>
  )

  const renderMatchList = (list) => {
    if (list.length === 0) return null
    const ROW_H = 62
    const HEADER_H = 36
    const listHeight = Math.min(list.length * ROW_H, window.innerHeight - 200)
    const virtualHeight = Math.max(listHeight - HEADER_H, 100)

    return (
      <div>
        <div style={{
          display: 'flex', borderBottom: '2px solid #1e293b', padding: '6px 14px',
          fontSize: '10px', color: '#64748b', textTransform: 'uppercase', fontWeight: '800',
          letterSpacing: '0.8px', background: 'rgba(0,0,0,0.3)',
        }}>
          <div style={{ flex: 1, minWidth: '120px', padding: '0 8px' }}>MATCH</div>
          <div style={{ width: '76px', padding: '0 8px', textAlign: 'center' }}>O/U</div>
          <div style={{ width: '66px', padding: '0 8px', textAlign: 'center' }}>BTTS</div>
          <div style={{ width: '76px', padding: '0 8px', textAlign: 'center' }}>HANDICAP</div>
        </div>
        <div style={{ height: virtualHeight }}>
          <div style={{ height: '100%', overflowY: 'auto' }}>
            {list.map((m, i) => (
              <div key={m.id || i} style={{ height: ROW_H + 'px' }}>
                <MatchCard rawData={toRawLines(m)} onClick={() => setSelectedMatch(m)} style={{ height: '100%' }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (status === 'loading' && matches.length === 0)
    return <div className="titanium-layout"><main className="titanium-main"><LoadingSkeleton type="page" label="CHARGEMENT..." /></main></div>

  if (status === 'error' && matches.length === 0)
    return (
      <div className="titanium-layout">
        <main className="titanium-main">
          <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
            <div style={{ fontSize: '18px', fontWeight: '700', marginBottom: '16px' }}>CONNEXION INTERROMPUE</div>
            <button onClick={() => dataService.refreshAllData()} style={{
              padding: '10px 24px', background: 'rgba(0,255,170,0.1)', border: '1px solid #00ffaa',
              borderRadius: '6px', color: '#00ffaa', fontWeight: '700', cursor: 'pointer', fontSize: '13px',
            }}>RECONNECTER</button>
          </div>
        </main>
      </div>
    )

  return (
    <div className="titanium-layout">
      <main className="titanium-main">
        <div style={{ padding: '8px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
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
          {renderMatchList(filteredMatches)}
        </div>
      </main>
    </div>
  )
}

export default Dashboard
