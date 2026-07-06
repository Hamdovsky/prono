import React, { useState, useEffect } from 'react'

const NUM_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6']

export default function PromosportAccuracy({ onClose }) {
  const [stats, setStats] = useState(null)
  const [crowd, setCrowd] = useState(null)
  const [matrix, setMatrix] = useState(null)
  const [roi, setRoi] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('overview')
  const [retraining, setRetraining] = useState(false)
  const [retrainResult, setRetrainResult] = useState(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/promosport/accuracy').then(r => r.json()).catch(() => null),
      fetch('/api/promosport/feedback/stats').then(r => r.json()).catch(() => null),
      fetch('/api/promosport/accuracy/matrix').then(r => r.json()).catch(() => null),
      fetch('/api/promosport/accuracy/roi?stake=10').then(r => r.json()).catch(() => null)
    ]).then(([s, c, m, r]) => {
      if (s?.success) setStats(s.stats)
      if (c?.success) setCrowd(c)
      if (m?.success) setMatrix(m.matrix)
      if (r?.success) setRoi(r.roi)
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
          PRÉCISION PROMOSPORT — {overallPct}%
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
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          { key: 'overview', label: '📊 Vue d\'ensemble' },
          { key: 'matrix', label: '🔀 Matrice' },
          { key: 'roi', label: '💰 ROI' },
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
            {roi && <KPI label="ROI" value={roi.roi} color={parseFloat(roi.roi) > 0 ? '#22c55e' : '#ef4444'} />}
          </div>
          <div style={{ marginTop: 8, background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Répartition par confidence (crowd)</div>
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

      {tab === 'matrix' && matrix && (
        <div>
          <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
            <KPI label="Pronos simples" value={matrix.totalSimple} color="#60a5fa" />
            <KPI label="Corrects" value={matrix.correct} color="#22c55e" />
            <KPI label="Précision brute" value={matrix.accuracy} color={parseFloat(matrix.accuracy) > 50 ? '#22c55e' : '#f59e0b'} />
            <KPI label="Total lignes" value={matrix.totalPredictions} color="#94a3b8" />
          </div>
          <div style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)', overflowX: 'auto' }}>
            <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', marginBottom: 8 }}>Matrice de confusion — Prédit → Réel ↓</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.65rem' }}>
              <thead>
                <tr>
                  <th style={{ padding: '6px 8px', textAlign: 'left', color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>Réel \ Prédit</th>
                  <th style={{ padding: '6px 8px', textAlign: 'center', color: '#60a5fa', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>1</th>
                  <th style={{ padding: '6px 8px', textAlign: 'center', color: '#fbbf24', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>X</th>
                  <th style={{ padding: '6px 8px', textAlign: 'center', color: '#f87171', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>2</th>
                  <th style={{ padding: '6px 8px', textAlign: 'center', color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>Précision</th>
                </tr>
              </thead>
              <tbody>
                {matrix.byResult.map(row => {
                  const d = row.distribution
                  const total = Object.values(d).reduce((s, v) => s + v, 0)
                  return (
                    <tr key={row.actual}>
                      <td style={{ padding: '6px 8px', fontWeight: 700, color: row.actual === '1' ? '#60a5fa' : row.actual === 'X' ? '#fbbf24' : '#f87171' }}>{row.actual}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', background: row.actual === '1' ? 'rgba(59,130,246,0.1)' : 'transparent', color: '#e2e8f0' }}>{(d[1] || 0).toFixed(1)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', background: row.actual === 'X' ? 'rgba(251,191,36,0.1)' : 'transparent', color: '#e2e8f0' }}>{(d['X'] || 0).toFixed(1)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', background: row.actual === '2' ? 'rgba(239,68,68,0.1)' : 'transparent', color: '#e2e8f0' }}>{(d[2] || 0).toFixed(1)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: total > 0 && (d[row.actual] / total) > 0.4 ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>
                        {total > 0 ? (d[row.actual] / total * 100).toFixed(0) + '%' : 'N/A'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center', gap: 12, fontSize: '0.55rem', color: '#64748b' }}>
              <span>🏠 Home (1): {matrix.predictedDistribution[1]?.toFixed(0) || 0} prédits</span>
              <span>⚖️ Draw (X): {matrix.predictedDistribution['X']?.toFixed(0) || 0} prédits</span>
              <span>✈️ Away (2): {matrix.predictedDistribution[2]?.toFixed(0) || 0} prédits</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'roi' && roi && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 12 }}>
            <KPI label="Mise totale" value={`${roi.totalStaked} DT`} color="#60a5fa" />
            <KPI label="Retour total" value={`${roi.totalReturned.toFixed(0)} DT`} color={roi.profit > 0 ? '#22c55e' : '#ef4444'} />
            <KPI label="Profit" value={`${roi.profit > 0 ? '+' : ''}${roi.profit.toFixed(0)} DT`} color={roi.profit > 0 ? '#22c55e' : '#ef4444'} />
            <KPI label="ROI" value={roi.roi} color={parseFloat(roi.roi) > 0 ? '#22c55e' : '#ef4444'} />
            <KPI label="Win Rate" value={roi.winRate} color={parseFloat(roi.winRate) > 50 ? '#22c55e' : '#f59e0b'} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 6, marginBottom: 12 }}>
            {roi.byGrid?.map((g, i) => {
              const p = parseFloat(g.roi)
              return (
                <div key={i} style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 6, padding: '8px 10px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize: '0.55rem', color: '#fbbf24', fontWeight: 600, marginBottom: 2 }}>{g.name}</div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color: p > 0 ? '#22c55e' : '#ef4444' }}>{g.roi}</div>
                  <div style={{ fontSize: '0.5rem', color: '#64748b' }}>{g.wins}W/{g.losses}L · {g.profit > 0 ? '+' : ''}{g.profit.toFixed(0)} DT</div>
                </div>
              )
            })}
          </div>
          <div style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Profit par concours (cumulé)</div>
            {roi.byConcours?.slice(-20).map((c, i) => {
              const cumul = roi.byConcours.slice(0, roi.byConcours.indexOf(c) + 1).reduce((s, x) => s + x.profit, 0)
              const h = Math.max(3, Math.abs(cumul) / 100 * 40)
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <div style={{ fontSize: '0.5rem', color: '#64748b', minWidth: 28 }}>#{c.concours}</div>
                  <div style={{ flex: 1, height: 12, position: 'relative' }}>
                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.1)' }} />
                    {cumul > 0 ? (
                      <div style={{ position: 'absolute', right: '50%', top: 0, height: `${Math.min(h, 12)}px`, background: '#22c55e', borderRadius: '0 2px 2px 0', minWidth: 2, opacity: 0.8 }} />
                    ) : (
                      <div style={{ position: 'absolute', left: '50%', bottom: 0, height: `${Math.min(h, 12)}px`, background: '#ef4444', borderRadius: '2px 2px 0 0', minWidth: 2, opacity: 0.8 }} />
                    )}
                  </div>
                  <div style={{ fontSize: '0.55rem', color: cumul > 0 ? '#22c55e' : '#ef4444', minWidth: 50, textAlign: 'right' }}>{cumul > 0 ? '+' : ''}{cumul.toFixed(0)} DT</div>
                </div>
              )
            })}
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
            <KPI label="Crowd" value={`${crowd.crowdAccuracy ?? 0}%`} color="#f59e0b" />
            <KPI label="Total" value={crowd.crowdTotal ?? 0} color="#94a3b8" />
            <KPI label="Corrects" value={crowd.crowdCorrect ?? 0} color="#22c55e" />
          </div>
          <div style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ fontSize: '0.6rem', color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Confiance de la foule par palier</div>
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
                  <div style={{ width: '100%', height: `${h}px`, background: pct > 65 ? '#22c55e' : pct > 50 ? '#f59e0b' : '#ef4444', borderRadius: '2px 2px 0 0', transition: 'height 0.3s' }}
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
