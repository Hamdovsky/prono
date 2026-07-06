import React, { useMemo, useState } from 'react'

const isFinished = (m) => {
  const st = (m.status || '').toUpperCase()
  if (st === 'NOT_STARTED' || st === 'SCHEDULED' || st === '' || st === 'NS') return false
  if (st === 'IN_PLAY' || st === 'LIVE' || st === '1H' || st === '2H' || st === 'HT') return false
  if (st !== 'FT' && st !== 'FINISHED' && st !== 'ENDED') {
    const sh = m.scoreHome ?? m.score?.home
    const sa = m.scoreAway ?? m.score?.away
    if ((sh === null || sh === undefined) && (sa === null || sa === undefined)) return false
    if (Number(sh) === 0 && Number(sa) === 0) return false
  }
  return true
}

const getScore = (m) => {
  const hRaw = m.scoreHome !== undefined ? m.scoreHome : m.score?.home
  const aRaw = m.scoreAway !== undefined ? m.scoreAway : m.score?.away
  if (hRaw === null || hRaw === undefined || aRaw === null || aRaw === undefined) return null
  const h = Number(hRaw); const a = Number(aRaw)
  if (isNaN(h) || isNaN(a)) return null
  return { h, a, total: h + a }
}

const classifyMarket = (pick) => {
  if (pick.includes('ht:') || pick.includes('first_half') || pick === 'ht: o0.5' || pick === 'ht: o1.5') return 'HT'
  if (pick === '1x' || pick === 'dc: 1x' || pick === 'dc:1x' || pick === 'x2' || pick === 'dc: x2' || pick === 'dc:x2' || pick === '12' || pick === 'dc: 12' || pick === 'dc:12') return 'DC'
  if (pick.includes('home') || pick.includes('dom') || pick === '1' || pick.includes(' 1 ')) return '1X2'
  if (pick.includes('away') || pick.includes('ext') || pick === '2' || pick.includes(' 2 ')) return '1X2'
  if (pick.includes('draw') || pick.includes('nul') || pick === 'x' || pick.includes(' x ')) return '1X2'
  if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui')) return 'BTTS'
  if (pick.includes('+1.5') || pick.includes('-1.5') || pick.includes('+2.5') || pick.includes('-2.5') || pick.includes('+3.5') || pick.includes('-3.5')) return 'O/U'
  if (pick.includes('over25') || pick.includes('under25')) return 'O/U'
  if (pick.includes('handicap') || pick.includes('hcp')) return 'HCP'
  return 'AUTRE'
}

const evaluatePick = (pick, score) => {
  const { h, a, total } = score
  if (pick === '1x' || pick === 'dc: 1x' || pick === 'dc:1x') return h >= a
  if (pick === 'x2' || pick === 'dc: x2' || pick === 'dc:x2') return a >= h
  if (pick === '12' || pick === 'dc: 12' || pick === 'dc:12') return h !== a
  if (pick.includes('home') || pick.includes('dom') || pick === '1') return h > a
  if (pick.includes('away') || pick.includes('ext') || pick === '2') return a > h
  if (pick.includes('draw') || pick.includes('nul') || pick === 'x') return h === a
  if (pick.includes('+1.5') || pick.includes('over 1.5')) return total > 1.5
  if (pick.includes('-1.5') || pick.includes('under 1.5')) return total < 1.5
  if (pick.includes('+2.5') || pick.includes('over 2.5') || pick === 'over25') return total > 2.5
  if (pick.includes('-2.5') || pick.includes('under 2.5') || pick === 'under25') return total < 2.5
  if (pick.includes('+3.5') || pick.includes('over 3.5')) return total > 3.5
  if (pick.includes('-3.5') || pick.includes('under 3.5')) return total < 3.5
  if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui')) return h > 0 && a > 0
  return false
}

const extractPick = (m) => {
  let pick = ''
  const q = m.quant || m._quant
  if (q && q.main_pick) pick = String(q.main_pick).toLowerCase()
  else if (m.predictions && m.predictions[0] && m.predictions[0].val) pick = String(m.predictions[0].val).toLowerCase()
  else pick = String(m.prediction || '').toLowerCase()
  return pick
}

const isNonStandard = (p) => p.includes('risky bet') || p.includes('skip') || p.includes('no bet') || p.includes('البطاقات') || p.includes('cards') || p.includes('corner') || p === 'null' || p === 'undefined' || p === ''

const MARKET_ICONS = { '1X2': '⚽', 'BTTS': '⚡', 'O/U': '📊', 'HT': '⏱', 'HCP': '🛡️', 'DC': '🔄', 'AUTRE': '📌' }

const formatDate = (ts) => {
  if (!ts) return ''
  const d = new Date(ts > 1e11 ? ts : ts * 1000)
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
}

const TrackRecord = ({ matches, onClose }) => {
  const [marketFilter, setMarketFilter] = useState('ALL')
  const [resultFilter, setResultFilter] = useState('ALL')
  const [sortField, setSortField] = useState('date')
  const [sortDir, setSortDir] = useState('desc')

  const records = useMemo(() => {
    const items = []
    matches.forEach(m => {
      if (!isFinished(m)) return
      const score = getScore(m)
      if (!score) return
      let pick = extractPick(m)
      if (isNonStandard(pick)) return
      const market = classifyMarket(pick)
      const isWin = evaluatePick(pick, score)
      const conf = m.v22_success_rate || m.enriched?.v22_success_rate || m.confidence || 0
      const finalConf = conf > 1 ? Math.round(conf) : Math.round(conf * 100)
      items.push({
        id: m.id || Math.random().toString(36).slice(2),
        date: m.startTimestamp || m.timestamp || 0,
        match: `${m.homeTeam || ''} vs ${m.awayTeam || ''}`,
        league: m.league || m.tournament_name || 'Unknown',
        market,
        pick,
        score: `${score.h}-${score.a}`,
        isWin,
        conf: finalConf,
        profit: isWin ? 0.85 : -1,
      })
    })
    return items
  }, [matches])

  const sortedRecords = useMemo(() => {
    let filtered = [...records]
    if (marketFilter !== 'ALL') filtered = filtered.filter(r => r.market === marketFilter)
    if (resultFilter !== 'ALL') filtered = filtered.filter(r => resultFilter === 'WON' ? r.isWin : !r.isWin)

    filtered.sort((a, b) => {
      let cmp = 0
      if (sortField === 'date') cmp = (a.date || 0) - (b.date || 0)
      else if (sortField === 'conf') cmp = a.conf - b.conf
      else if (sortField === 'profit') cmp = a.profit - b.profit
      else if (sortField === 'match') cmp = a.match.localeCompare(b.match)
      return sortDir === 'desc' ? -cmp : cmp
    })
    return filtered
  }, [records, marketFilter, resultFilter, sortField, sortDir])

  const marketOptions = useMemo(() => {
    const set = new Set(records.map(r => r.market))
    return ['ALL', ...Array.from(set)]
  }, [records])

  const handleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortField(field); setSortDir('desc') }
  }

  const stats = useMemo(() => {
    const total = records.length
    const wins = records.filter(r => r.isWin).length
    const profit = records.reduce((acc, r) => acc + r.profit, 0)
    return { total, wins, winRate: total > 0 ? Math.round((wins / total) * 100) : 0, profit: Math.round(profit * 100) / 100 }
  }, [records])

  const sortArrow = (field) => sortField === field ? (sortDir === 'desc' ? '▼' : '▲') : ''

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 9999,
      background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{
        background: 'linear-gradient(145deg, #0a0f18 0%, #0f172a 100%)',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px',
        width: '90%', maxWidth: '960px', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid #1e293b',
        }}>
          <div>
            <span style={{ fontSize: '13px', fontWeight: '900', color: '#f1f5f9', letterSpacing: '1px' }}>
              📋 HISTORIQUE COMPLET DES PRONOSTICS
            </span>
            <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>
              {stats.total} pronos · {stats.winRate}% réusite · {stats.profit > 0 ? '+' : ''}{stats.profit}u net
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: '6px', color: '#ef4444', fontWeight: '900', fontSize: '14px',
            cursor: 'pointer', padding: '6px 14px', fontFamily: 'inherit',
          }}>
            ✕ FERMER
          </button>
        </div>

        {/* Filters */}
        <div style={{
          display: 'flex', gap: '8px', padding: '10px 20px',
          background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span style={{ fontSize: '9px', fontWeight: '700', color: '#64748b' }}>FILTRES:</span>
          <select value={marketFilter} onChange={e => setMarketFilter(e.target.value)} style={{
            padding: '4px 8px', background: 'rgba(15,23,42,0.8)', border: '1px solid #334155',
            borderRadius: '6px', color: '#f1f5f9', fontSize: '10px', outline: 'none', cursor: 'pointer',
          }}>
            <option value="ALL">📊 Tous marchés</option>
            {marketOptions.filter(m => m !== 'ALL').map(m => (
              <option key={m} value={m}>{MARKET_ICONS[m] || '📌'} {m}</option>
            ))}
          </select>
          <select value={resultFilter} onChange={e => setResultFilter(e.target.value)} style={{
            padding: '4px 8px', background: 'rgba(15,23,42,0.8)', border: '1px solid #334155',
            borderRadius: '6px', color: '#f1f5f9', fontSize: '10px', outline: 'none', cursor: 'pointer',
          }}>
            <option value="ALL">📋 Tous résultats</option>
            <option value="WON">✅ Gagnés</option>
            <option value="LOST">❌ Perdus</option>
          </select>
          <span style={{ fontSize: '9px', color: '#64748b', marginLeft: 'auto' }}>
            {sortedRecords.length} résultat{sortedRecords.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflow: 'auto', padding: '0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
            <thead>
              <tr style={{
                background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid #1e293b',
                position: 'sticky', top: 0, zIndex: 2,
              }}>
                {[
                  { field: 'date', label: 'Date', width: '60px' },
                  { field: 'match', label: 'Match', flex: 1 },
                  { field: 'market', label: 'Marché', width: '55px' },
                  { field: 'conf', label: 'Conf.', width: '50px' },
                  { field: null, label: 'Score', width: '60px' },
                  { field: 'profit', label: 'Résultat', width: '80px' },
                ].map(col => (
                  <th key={col.label} onClick={() => col.field && handleSort(col.field)} style={{
                    padding: '8px 10px', textAlign: 'left', fontWeight: '700', color: '#64748b',
                    letterSpacing: '0.5px', cursor: col.field ? 'pointer' : 'default',
                    whiteSpace: 'nowrap', minWidth: col.width, width: col.flex ? undefined : col.width,
                  }}>
                    {col.label} {col.field ? sortArrow(col.field) : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRecords.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: '#475569', fontSize: '11px' }}>
                    Aucun pronostic trouvé avec ces filtres
                  </td>
                </tr>
              ) : (
                sortedRecords.map((r, i) => (
                  <tr key={r.id || i} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    background: i % 2 === 0 ? 'rgba(0,0,0,0.15)' : 'transparent',
                  }}>
                    <td style={{ padding: '6px 10px', color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                      {formatDate(r.date)}
                    </td>
                    <td style={{ padding: '6px 10px', color: '#e2e8f0', fontWeight: '600' }}>
                      <div>{r.match}</div>
                      <div style={{ fontSize: '8px', color: '#475569' }}>{r.league.slice(0, 30)}</div>
                    </td>
                    <td style={{ padding: '6px 10px', color: '#94a3b8' }}>
                      {MARKET_ICONS[r.market] || '📌'} {r.market}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <span style={{
                        fontWeight: '800', fontFamily: "'JetBrains Mono', monospace",
                        color: r.conf >= 70 ? '#00ffaa' : r.conf >= 55 ? '#fbbf24' : '#f87171',
                      }}>
                        {r.conf}%
                      </span>
                    </td>
                    <td style={{ padding: '6px 10px', color: '#cbd5e1', fontFamily: "'JetBrains Mono', monospace", fontWeight: '700' }}>
                      {r.score}
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        fontWeight: '800', fontSize: '11px',
                        color: r.isWin ? '#00ffaa' : '#ef4444',
                      }}>
                        {r.isWin ? '✅' : '❌'} {r.isWin ? 'GAGNÉ' : 'PERDU'}
                        <span style={{ fontSize: '9px', opacity: 0.7 }}>
                          ({r.isWin ? '+' : ''}{r.profit}u)
                        </span>
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default TrackRecord
