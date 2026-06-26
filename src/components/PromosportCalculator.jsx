import React, { useState, useEffect, useMemo } from 'react'

const COLUMN_PRICE = 0.850
const TAX_RATE = 0.06

const PICK_LABELS = { 1: '1', 2: 'X', 3: '2' }

export default function PromosportCalculator({ matches, fetcher }) {
  const [cols, setCols] = useState(4)
  const [doubles, setDoubles] = useState(5)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [generatedCols, setGeneratedCols] = useState(null)
  const [showAllCols, setShowAllCols] = useState(false)

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
    setGeneratedCols(null)
  }, [cols, doubles, matches])

  const presets = [
    { label: 'Minimal', cols: 2, doubles: 3 },
    { label: 'Économique', cols: 4, doubles: 5 },
    { label: 'Standard', cols: 8, doubles: 6 },
    { label: 'Confort', cols: 16, doubles: 7 },
    { label: 'Intégral', cols: 128, doubles: 7 },
  ]

  const COL_QUICK = [1, 2, 4, 8, 16, 32, 64, 128, 256]
  const DOUBLE_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]

  const generateColumns = () => {
    if (!matches || matches.length === 0) return
    const fullSystem = Math.pow(2, doubles)
    const numToGen = Math.min(cols, fullSystem, 256)
    const columns = []

    const bestPick = (m) => {
      if (!m) return 1
      const h = m.mlProbs?.h ?? m.probs?.h ?? 33
      const x = m.mlProbs?.x ?? m.probs?.x ?? 33
      const a = m.mlProbs?.a ?? m.probs?.a ?? 34
      if (h >= x && h >= a) return 1
      if (a >= h && a >= x) return 3
      return 2
    }

    const doubleAlt = (pick) => {
      if (pick === 1) return 2
      if (pick === 3) return 2
      return 1
    }

    const indices = []
    for (let i = 0; i < numToGen; i++) indices.push(i)

    // Use the last `doubles` matches for covering
    const doubleMatchIndices = []
    for (let i = Math.max(0, matches.length - doubles); i < matches.length; i++) {
      doubleMatchIndices.push(i)
    }

    indices.forEach(idx => {
      const col = matches.map((m, mi) => {
        const di = doubleMatchIndices.indexOf(mi)
        if (di === -1) {
          return bestPick(m)
        }
        // This match is a double: vary based on idx bits
        const bit = (idx >> di) & 1
        const base = bestPick(m)
        return bit === 0 ? base : doubleAlt(base)
      })
      columns.push(col)
    })

    setGeneratedCols({ columns, count: numToGen, total: fullSystem })
  }

  const displayCols = useMemo(() => {
    if (!generatedCols) return null
    const limit = showAllCols ? generatedCols.count : Math.min(32, generatedCols.count)
    return {
      cols: generatedCols.columns.slice(0, limit),
      showing: limit,
      total: generatedCols.count
    }
  }, [generatedCols, showAllCols])

  return (
    <div className="promosport-calculator" style={{ padding: '20px' }}>
      <div style={{ background: 'rgba(99, 102, 241, 0.08)', padding: '25px', borderRadius: '15px', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
        <h3 style={{ color: '#818cf8', fontSize: '1.6rem', marginBottom: '5px', fontWeight: '900' }}>
          🧮 CALCULATEUR DE COMBINAISONS
        </h3>
        <p style={{ color: '#64748b', marginBottom: '20px', fontSize: '0.85rem' }}>
          Simulez votre système Promosport : choisissez le nombre de colonnes et de doubles
        </p>

        {/* ---- Digit Dashboard ---- */}
        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '24px' }}>
          {/* Colonnes à jouer */}
          <div style={{ flex: '1', minWidth: '240px' }}>
            <label style={{ color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', display: 'block', marginBottom: '8px', fontWeight: '700', letterSpacing: '1px' }}>
              Colonnes à jouer
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', background: 'rgba(0,0,0,0.25)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
              {COL_QUICK.map(v => (
                <button key={v} onClick={() => setCols(v)}
                  style={{
                    minWidth: '40px', padding: '8px 4px', borderRadius: '8px', border: cols === v ? '2px solid #818cf8' : '1px solid rgba(99, 102, 241, 0.25)',
                    background: cols === v ? 'rgba(99, 102, 241, 0.3)' : 'rgba(99, 102, 241, 0.06)',
                    color: cols === v ? '#c7d2fe' : '#94a3b8',
                    cursor: 'pointer', fontSize: '0.85rem', fontWeight: '900', fontFamily: "'JetBrains Mono', monospace",
                    transition: 'all 0.15s', flex: '0 0 auto',
                    textAlign: 'center', boxShadow: cols === v ? '0 0 12px rgba(99, 102, 241, 0.3)' : 'none'
                  }}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          {/* Doubles (0-13) */}
          <div style={{ flex: '1', minWidth: '240px' }}>
            <label style={{ color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', display: 'block', marginBottom: '8px', fontWeight: '700', letterSpacing: '1px' }}>
              Doubles (0-13)
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '5px', background: 'rgba(0,0,0,0.25)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
              {DOUBLE_VALS.map(v => (
                <button key={v} onClick={() => setDoubles(v)}
                  style={{
                    padding: '8px 0', borderRadius: '8px', border: doubles === v ? '2px solid #fbbf24' : '1px solid rgba(251, 191, 36, 0.2)',
                    background: doubles === v ? 'rgba(251, 191, 36, 0.25)' : 'rgba(251, 191, 36, 0.04)',
                    color: doubles === v ? '#fde68a' : '#94a3b8',
                    cursor: 'pointer', fontSize: '0.85rem', fontWeight: '900', fontFamily: "'JetBrains Mono', monospace",
                    transition: 'all 0.15s', textAlign: 'center',
                    boxShadow: doubles === v ? '0 0 12px rgba(251, 191, 36, 0.25)' : 'none'
                  }}>
                  {v}
                </button>
              ))}
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

        {/* ---- GÉNÉRATEUR DE COLONNES ---- */}
        {matches && matches.length > 0 && (
          <div style={{ marginTop: '28px' }}>
            <button onClick={generateColumns}
              style={{
                width: '100%', padding: '14px', borderRadius: '12px',
                background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                border: 'none', color: '#fff', fontWeight: '900', fontSize: '1rem',
                cursor: 'pointer', letterSpacing: '1px', textTransform: 'uppercase',
                transition: 'all 0.2s', boxShadow: '0 4px 20px rgba(99, 102, 241, 0.3)'
              }}
              onMouseEnter={e => e.target.style.transform = 'translateY(-2px)'}
              onMouseLeave={e => e.target.style.transform = 'none'}
            >
              🎲 GÉNÉRER LES COLONNES
            </button>

            {displayCols && (
              <div style={{ marginTop: '16px', background: 'rgba(0,0,0,0.25)', borderRadius: '12px', padding: '16px', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: '700' }}>
                    {displayCols.cols.length} colonnes générées sur {generatedCols.total} possibles
                  </span>
                  {generatedCols.count > 32 && (
                    <button onClick={() => setShowAllCols(s => !s)}
                      style={{
                        background: 'transparent', border: '1px solid #818cf8', color: '#818cf8',
                        padding: '4px 10px', borderRadius: '6px', fontSize: '0.7rem', fontWeight: '700',
                        cursor: 'pointer'
                      }}>
                      {showAllCols ? 'Montrer moins' : 'Tout montrer'}
                    </button>
                  )}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem' }}>
                    <thead>
                      <tr>
                        <th style={{ padding: '4px 6px', color: '#64748b', textAlign: 'center', position: 'sticky', left: 0, background: '#0f172a', zIndex: 1 }}>N°</th>
                        {matches.map((m, i) => (
                          <th key={i} style={{ padding: '4px 4px', color: '#64748b', textAlign: 'center', fontSize: '0.6rem', fontWeight: '700', minWidth: '22px' }}>
                            {i + 1}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayCols.cols.map((col, ci) => (
                        <tr key={ci}>
                          <td style={{ padding: '4px 6px', color: '#818cf8', fontWeight: '700', textAlign: 'center', position: 'sticky', left: 0, background: '#0f172a', zIndex: 1 }}>
                            {ci + 1}
                          </td>
                          {col.map((pick, pi) => (
                            <td key={pi} style={{
                              padding: '4px 2px', textAlign: 'center', fontWeight: '700',
                              fontFamily: "'JetBrains Mono', monospace",
                              color: pick === 1 ? '#34d399' : pick === 3 ? '#f87171' : '#fbbf24',
                              background: 'rgba(99, 102, 241, 0.04)',
                              fontSize: '0.8rem'
                            }}>
                              {PICK_LABELS[pick] || pick}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}