import React, { useState, useEffect } from 'react'

const COLUMN_PRICE = 0.850
const TAX_RATE = 0.06

export default function PromosportCalculator({ matches, fetcher }) {
  const [cols, setCols] = useState(4)
  const [doubles, setDoubles] = useState(5)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const calcLocal = (c, d) => {
    const full = Math.pow(2, d)
    const coverage = full > 0 ? Math.min(100, +(c / full * 100).toFixed(2)) : 0
    const costBefore = +(c * COLUMN_PRICE).toFixed(3)
    const costAfter = +(costBefore * (1 + TAX_RATE)).toFixed(3)

    let systemType = 'INTÉGRAL'
    if (full > 0 && c < full) {
      const ratio = full / c
      if (ratio >= 16) systemType = `N-${Math.round(Math.log2(ratio))}`
      else if (ratio >= 8) systemType = 'N-1'
      else if (ratio >= 4) systemType = 'N-2'
      else systemType = 'RÉDUIT'
    }

    // Expected correct based on match probabilities
    let expectedCorrect = null
    if (matches && matches.length > 0) {
      expectedCorrect = matches.reduce((sum, m) => {
        const best = Math.max(m.mlProbs?.h || m.probs?.h || 33, m.mlProbs?.x || m.probs?.x || 33, m.mlProbs?.a || m.probs?.a || 34)
        return sum + best / 100
      }, 0)
      expectedCorrect = Math.round(expectedCorrect * 100) / 100
    }

    return { full, coverage, costBefore, costAfter, systemType, expectedCorrect }
  }

  const fetchApi = async (c, d) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetcher.fetchPromosportCalculator(c, d)
      if (data && data.success) setResult(data)
      else { setError('API indisponible'); setResult(calcLocal(c, d)) }
    } catch {
      setError('Erreur API')
      setResult(calcLocal(c, d))
    }
    setLoading(false)
  }

  useEffect(() => {
    setResult(calcLocal(cols, doubles))
  }, [cols, doubles, matches])

  const presets = [
    { label: 'Minimal', cols: 2, doubles: 3 },
    { label: 'Économique', cols: 4, doubles: 5 },
    { label: 'Standard', cols: 8, doubles: 6 },
    { label: 'Confort', cols: 16, doubles: 7 },
    { label: 'Intégral', cols: 128, doubles: 7 },
  ]

  return (
    <div className="promosport-calculator" style={{ padding: '20px' }}>
      <div style={{ background: 'rgba(99, 102, 241, 0.08)', padding: '25px', borderRadius: '15px', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
        <h3 style={{ color: '#818cf8', fontSize: '1.6rem', marginBottom: '5px', fontWeight: '900' }}>
          🧮 CALCULATEUR DE COMBINAISONS
        </h3>
        <p style={{ color: '#64748b', marginBottom: '20px', fontSize: '0.85rem' }}>
          Simulez votre système Promosport : choisissez le nombre de colonnes et de doubles
        </p>

        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
          <div style={{ flex: '1', minWidth: '200px' }}>
            <label style={{ color: '#94a3b8', fontSize: '0.75rem', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
              Colonnes à jouer
            </label>
            <input
              type="range"
              min="1"
              max="256"
              value={cols}
              onChange={e => setCols(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: '#6366f1' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', fontSize: '0.75rem' }}>
              <span>1</span>
              <span style={{ color: '#818cf8', fontWeight: 'bold', fontSize: '1.2rem' }}>{cols}</span>
              <span>256</span>
            </div>
          </div>

          <div style={{ flex: '1', minWidth: '200px' }}>
            <label style={{ color: '#94a3b8', fontSize: '0.75rem', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
              Doubles (0-13)
            </label>
            <input
              type="range"
              min="0"
              max="13"
              value={doubles}
              onChange={e => setDoubles(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: '#6366f1' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', fontSize: '0.75rem' }}>
              <span>0</span>
              <span style={{ color: '#818cf8', fontWeight: 'bold', fontSize: '1.2rem' }}>{doubles}</span>
              <span>13</span>
            </div>
          </div>
        </div>

        {/* Presets */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '20px' }}>
          {presets.map(p => (
            <button key={p.label} onClick={() => { setCols(p.cols); setDoubles(p.doubles) }}
              style={{
                padding: '6px 14px', borderRadius: '8px', border: '1px solid rgba(99, 102, 241, 0.4)',
                background: cols === p.cols && doubles === p.doubles ? 'rgba(99, 102, 241, 0.25)' : 'rgba(99, 102, 241, 0.08)',
                color: cols === p.cols && doubles === p.doubles ? '#818cf8' : '#94a3b8',
                cursor: 'pointer', fontSize: '0.75rem', fontWeight: 'bold',
                transition: 'all 0.2s'
              }}>
              {p.label} ({p.cols} cols, {p.doubles} D)
            </button>
          ))}
        </div>

        {/* Results */}
        {result && (
          <div style={{
            background: 'rgba(15, 23, 42, 0.6)', borderRadius: '12px', padding: '20px',
            border: '1px solid rgba(99, 102, 241, 0.2)'
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '15px', marginBottom: '20px' }}>
              <div style={{ background: 'rgba(99, 102, 241, 0.12)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                <div style={{ color: '#818cf8', fontSize: '1.8rem', fontWeight: '900' }}>{result.coverage?.systemCoverage?.toFixed(1) || result.coverage}%</div>
                <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>COUVERTURE SYSTÈME</div>
                <div style={{ color: '#64748b', fontSize: '0.65rem', marginTop: '4px' }}>
                  {result.input?.cols || cols} / {result.combinations?.fullSystem || result.full} colonnes
                </div>
              </div>

              <div style={{ background: 'rgba(16, 185, 129, 0.12)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                <div style={{ color: '#34d399', fontSize: '1.8rem', fontWeight: '900' }}>{result.combinations?.fullSystem || result.full}</div>
                <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>COMBINAISONS TOTALES</div>
                <div style={{ color: '#64748b', fontSize: '0.65rem', marginTop: '4px' }}>
                  2<sup>{result.input?.doubles || doubles}</sup> = {(result.combinations?.fullSystem || result.full).toLocaleString()}
                </div>
              </div>

              <div style={{ background: 'rgba(251, 191, 36, 0.12)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                <div style={{ color: '#fbbf24', fontSize: '1.8rem', fontWeight: '900' }}>
                  {result.pricing?.total || `${result.costAfter.toFixed(3)} DT`}
                </div>
                <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>COÛT TOTAL</div>
                <div style={{ color: '#64748b', fontSize: '0.65rem', marginTop: '4px' }}>
                  {result.pricing?.costBeforeTax || `${result.costBefore.toFixed(3)} DT`} HT
                </div>
              </div>

              {result.expectedCorrect && (
                <div style={{ background: 'rgba(139, 92, 246, 0.12)', padding: '15px', borderRadius: '10px', textAlign: 'center' }}>
                  <div style={{ color: '#a78bfa', fontSize: '1.8rem', fontWeight: '900' }}>{result.expectedCorrect}/13</div>
                  <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>BONNES RÉPONSES ESTIMÉES</div>
                  <div style={{ color: '#64748b', fontSize: '0.65rem', marginTop: '4px' }}>Moyenne des meilleures probas</div>
                </div>
              )}
            </div>

            {/* Coverage bar */}
            <div style={{ marginBottom: '15px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', fontSize: '0.7rem', marginBottom: '5px' }}>
                <span>Couverture du système</span>
                <span style={{ color: '#818cf8', fontWeight: 'bold' }}>{(result.coverage?.systemCoverage ?? result.coverage).toFixed(1)}%</span>
              </div>
              <div style={{ background: 'rgba(30, 41, 59, 0.8)', borderRadius: '10px', height: '20px', overflow: 'hidden', position: 'relative' }}>
                <div style={{
                  width: `${Math.min(100, result.coverage?.systemCoverage ?? result.coverage)}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #6366f1, #818cf8)',
                  borderRadius: '10px',
                  transition: 'width 0.5s ease',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.65rem', fontWeight: 'bold', color: '#fff',
                  minWidth: result.coverage >= 5 ? 'auto' : '0'
                }}>
                  {(result.coverage?.systemCoverage ?? result.coverage) >= 5 && `${(result.coverage?.systemCoverage ?? result.coverage).toFixed(0)}%`}
                </div>
              </div>
            </div>

            {/* System details */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.8rem' }}>
              <div><span style={{ color: '#64748b' }}>Système :</span> <span style={{ color: '#94a3b8' }}>{result.systemType || result.calculations?.systemType}</span></div>
              <div><span style={{ color: '#64748b' }}>Prix/colonne :</span> <span style={{ color: '#94a3b8' }}>{COLUMN_PRICE} DT</span></div>
              <div><span style={{ color: '#64748b' }}>Taxe (6%) :</span> <span style={{ color: '#94a3b8' }}>
                {result.pricing?.tax || `${(result.costBefore * TAX_RATE).toFixed(3)} DT`}
              </span></div>
              <div><span style={{ color: '#64748b' }}>Budget max :</span> <span style={{ color: '#94a3b8' }}>
                {result.pricing?.total || `${result.costAfter.toFixed(3)} DT`}
              </span></div>
            </div>

            {/* Advice */}
            {(result.coverage?.systemCoverage ?? result.coverage) < 10 && (
              <div style={{ marginTop: '15px', padding: '10px 15px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#f87171', fontSize: '0.8rem' }}>
                ⚠️ Réduction sévère ({(result.coverage?.systemCoverage ?? result.coverage).toFixed(1)}%). Envisagez plus de colonnes ou moins de doubles.
              </div>
            )}
            {(result.coverage?.systemCoverage ?? result.coverage) >= 50 && (
              <div style={{ marginTop: '15px', padding: '10px 15px', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.3)', color: '#34d399', fontSize: '0.8rem' }}>
                ✅ Bonne couverture ({(result.coverage?.systemCoverage ?? result.coverage).toFixed(1)}%). Risque modéré.
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ marginTop: '15px', color: '#f87171', fontSize: '0.85rem' }}>
            {error} — calcul local utilisé
          </div>
        )}
      </div>
    </div>
  )
}