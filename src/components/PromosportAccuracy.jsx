import React, { useState, useEffect } from 'react'

const NUM_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6']

export default function PromosportAccuracy({ onClose }) {
  const [stats, setStats] = useState(null)
  const [crowd, setCrowd] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('overview')
  const [retraining, setRetraining] = useState(false)
  const [retrainResult, setRetrainResult] = useState(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/promosport/accuracy').then(r => r.json()).catch(() => null),
      fetch('/api/promosport/feedback/stats').then(r => r.json()).catch(() => null)
    ]).then(([s, c]) => {
      if (s?.success) setStats(s.stats)
      if (c?.success) setCrowd(c)
      setLoading(false)
    })
  }, [])

  const handleRetrain = async () => {
    setRetraining(true)
    try {
      const res = await fetch('/api/promosport/retrain', { method: 'POST' })
      const data = await res.json()
      setRetrainResult(data)
    } catch (e) {
      setRetrainResult({ success: false, error: e.message })
    }
    setRetraining(false)
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>Chargement...</div>

  const overallPct = stats ? (stats.totalCorrect / stats.totalMatches * 100).toFixed(1) : 'N/A'
  const color = parseFloat(overallPct) > 65 ? '#22c55e' : parseFloat(overallPct) > 50 ? '#f59e0b' : '#ef4444'

  return (
    <div style={{ margin: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ color: '#fbbf24', fontWeight: 900, fontSize: '1.2rem' }}>
          PRÉCISION PROMOSPORT — XGBoost {overallPct}%
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleRetrain} disabled={retraining}
            style={{ padding: '4px 12px', fontSize: '0.65rem', background: retraining ? '#1e293b' : 'rgba(59,130,246,0.2)', border: `1px solid ${retraining ? '#334155' : 'rgba(59,130,246,0.4)'}`, borderRadius: 6, color: retraining ? '#64748b' : '#60a5fa', cursor: retraining ? 'wait' : 'pointer' }}>
            {retraining ? '⏳ Retrain...' : '🔄 Retrain'}
          </button>
          {onClose && <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '1rem' }}>✕</button>}
        </div>
      </div>

      {retrainResult && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: retrainResult.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${retrainResult.success ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
          <div style={{ color: retrainResult.success ? '#22c55e' : '#ef4444', fontWeight: 600, fontSize: '0.75rem' }}>
            {retrainResult.success ? '✅ Retrain terminé !' : `❌ Échec: ${retrainResult.error}`}
          </div>
          {retrainResult.steps?.map((s, i) => (
            <div key={i} style={{ color: '#94a3b8', fontSize: '0.65rem', marginTop: 2 }}>
              {s.step}: {s.accuracy ? `accuracy ${s.accuracy}%` : s.output || s.success ? 'OK' : 'FAIL'}
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {[
          { key: 'overview', label: '📊 Vue d\'ensemble' },
          { key: 'grids', label: '📋 Par grille' },
          { key: 'crowd', label: '👥 Foule' },
          { key: 'trend', label: '📈 Trend' }
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '3px 10px', fontSize: '0.6rem', background: tab === t.key ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.03)', border: `1px solid ${tab === t.key ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.06)'}`, borderRadius: 4, color: tab === t.key ? '#fbbf24' : '#64748b', cursor: 'pointer' }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 12 }}>
            <KPI label="Matches" value={stats?.totalMatches ?? 0} color="#60a5fa" />
            <KPI label="Corrects" value={stats?.totalCorrect ?? 0} color="#22c55e" />
            <KPI label="Accuracy" value={`${overallPct}%`} color={color} />
            <KPI label="Concours" value={stats?.concoursCount ?? 0} color="#a78bfa" />
            <KPI label="Crowd" value={crowd?.crowdAccuracy ? `${crowd.crowdAccuracy}%` : 'N/A'} color="#f59e0b" />
          </div>

          {/* Confusion-style matrix */}
          <div style={{ marginTop: 8, background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Répartition des pronostics par confidence</div>
            {crowd?.byConfidence?.map((b, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#94a3b8' }}>
                  <span>{b.range}</span>
                  <span>{b.correct}/{b.total} ({b.accuracy}%)</span>
                </div>
                <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${b.accuracy}%`, height: '100%', background: NUM_COLORS[i % NUM_COLORS.length], borderRadius: 2 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'grids' && stats?.perGrid && (
        <div style={{ display: 'grid', gap: 8 }}>
          {stats.perGrid.map((g, i) => {
            const pct = parseFloat(g.accuracy)
            return (
              <div key={i} style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: '10px 14px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ color: '#fbbf24', fontWeight: 600, fontSize: '0.7rem' }}>{g.name}</span>
                  <span style={{ fontSize: '0.7rem', color: pct > 65 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444', fontWeight: 700 }}>{g.accuracy}%</span>
                </div>
                <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: pct > 65 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444', borderRadius: 3, transition: 'width 0.5s' }} />
                </div>
                <div style={{ fontSize: '0.55rem', color: '#64748b', marginTop: 2 }}>{g.correct}/{g.total} corrects</div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'crowd' && crowd && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8, marginBottom: 12 }}>
            <KPI label="Crowd Accuracy" value={`${crowd.crowdAccuracy ?? 0}%`} color="#f59e0b" />
            <KPI label="Total pronos" value={crowd.crowdTotal ?? 0} color="#94a3b8" />
            <KPI label="Corrects" value={crowd.crowdCorrect ?? 0} color="#22c55e" />
            <KPI label="Concours dispo" value={stats?.concoursCount ?? 0} color="#60a5fa" />
          </div>
          <div style={{ marginTop: 8, background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Confiance de la foule par palier (crowd accuracy)</div>
            {crowd.byConfidence?.map((b, i) => {
              const hue = Math.min(b.accuracy / 100 * 120, 120)
              return (
                <div key={i} style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#94a3b8', marginBottom: 2 }}>
                    <span>{b.range}</span>
                    <span>{b.correct}/{b.total} — {b.accuracy}%</span>
                  </div>
                  <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${b.accuracy}%`, height: '100%', background: `hsl(${hue}, 70%, 50%)`, borderRadius: 2 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'trend' && stats?.recentConcours && (
        <div style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', marginBottom: 8 }}>Derniers {stats.recentConcours.length} concours</div>
          <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 60 }}>
            {stats.recentConcours.map((c, i) => {
              const pct = parseFloat(c.accuracy)
              const h = Math.max(6, (pct / 100) * 60)
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', height: `${h}px`, background: pct > 65 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444', borderRadius: '2px 2px 0 0', transition: 'height 0.3s', position: 'relative' }}
                    title={`Concours ${c.concours}: ${c.accuracy}%`} />
                  <div style={{ fontSize: '0.45rem', color: '#475569', marginTop: 2, writingMode: 'vertical-lr', textOrientation: 'mixed' }}>{c.concours}</div>
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: 4 }}>
            {stats.recentConcours.slice(-5).reverse().map((c, i) => (
              <div key={i} style={{ textAlign: 'center', padding: '4px 6px', background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
                <div style={{ fontSize: '0.55rem', color: '#94a3b8' }}>#{c.concours}</div>
                <div style={{ fontSize: '0.65rem', fontWeight: 700, color: parseFloat(c.accuracy) > 65 ? '#22c55e' : '#f59e0b' }}>{c.accuracy}%</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function KPI({ label, value, color }) {
  return (
    <div style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: '10px 12px', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
      <div style={{ fontSize: '1.2rem', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '0.55rem', color: '#64748b', textTransform: 'uppercase', marginTop: 2 }}>{label}</div>
    </div>
  )
}
