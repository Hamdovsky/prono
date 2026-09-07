// Header du module Promosport (extraits de Promosport.jsx, split 2026-09-07) :
// badges, sélecteur de doubles par grille, barre de stats, overlay d'export, panneau précision.
import React from 'react'

const PromoHeader = ({
  meta,
  doubleCounts,
  setDoubleCounts,
  matches,
  accuracyStats,
  avgConfidence,
  totalColonnes,
  coutEstime,
  exportAsImage,
  isExporting,
}) => {
  return (
    <>
      <div className="promosport-header">
        <div className="promo-badges">
          <span className="promo-badge-green">✅ PROMO 13 AI GENERATED</span>
          <span className="promo-badge-gold">🔥 VERSION JACKPOT OPTIMISÉE</span>
          <span className="promo-badge-gold">⚡ 50,000 SIMULATIONS MONTE CARLO</span>
        </div>
        <h2>⚽ TITANIUM PROMOSPORT AI MODULE - CONCOURS {meta.concours}</h2>
        <p>
          Grille optimisée par Quantum Monte Carlo. 94.1% de précision modèle. Date: {meta.date}
        </p>

        <div
          className="promo-double-selector"
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '10px',
            marginTop: '12px',
            flexWrap: 'wrap',
          }}
        >
          {meta.grid_names.map((name, gi) => {
            const gridCols = Math.pow(2, doubleCounts[gi])
            return (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: 'rgba(255,255,255,0.05)',
                  padding: '4px 10px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                <label
                  style={{
                    color: '#94a3b8',
                    fontSize: '0.6rem',
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {name}
                </label>
                {doubleCounts[gi] > 0 && (
                  <span style={{ color: '#6b7280', fontSize: '0.55rem' }}>{gridCols}col</span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                  <button
                    onClick={() => {
                      const next = Math.max(0, doubleCounts[gi] - 1)
                      const newD = [...doubleCounts]
                      newD[gi] = next
                      setDoubleCounts(newD)
                    }}
                    style={{
                      background: 'rgba(251,191,36,0.2)',
                      border: 'none',
                      color: '#fbbf24',
                      width: '32px',
                      height: '32px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '1rem',
                      lineHeight: '32px',
                      padding: '0',
                      minWidth: '32px',
                      minHeight: '32px',
                    }}
                  >
                    −
                  </button>
                  <span
                    style={{
                      color: '#fbbf24',
                      fontWeight: '900',
                      fontSize: '0.85rem',
                      minWidth: '16px',
                      textAlign: 'center',
                    }}
                  >
                    {doubleCounts[gi]}
                  </span>
                  <button
                    onClick={() => {
                      const next = Math.min(13, doubleCounts[gi] + 1)
                      const newD = [...doubleCounts]
                      newD[gi] = next
                      setDoubleCounts(newD)
                    }}
                    style={{
                      background: 'rgba(251,191,36,0.2)',
                      border: 'none',
                      color: '#fbbf24',
                      width: '32px',
                      height: '32px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '1rem',
                      lineHeight: '32px',
                      padding: '0',
                      minWidth: '32px',
                      minHeight: '32px',
                    }}
                  >
                    +
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="promo-stats-bar">
          <div className="promo-stats-row">
            <div className="stat-item">
              <span className="stat-value">{matches.length}</span>
              <span className="stat-label">MATCHES</span>
            </div>
            <div className="stat-item">
              <span className="stat-value highlight">
                {doubleCounts.reduce((a, b) => a + b, 0)}
              </span>
              <span className="stat-label">DOUBLES TOTAL</span>
            </div>
            {accuracyStats && (
              <div className="stat-item">
                <span className="stat-value">{accuracyStats.overallAccuracy}</span>
                <span className="stat-label">
                  PRÉCISION HIST. ({accuracyStats.concoursCount} conc.)
                </span>
              </div>
            )}
            <div className="stat-item">
              <span className="stat-value">{avgConfidence}%</span>
              <span className="stat-label">CONFIDENCE MOY.</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{totalColonnes}</span>
              <span className="stat-label">COLONNES ({coutEstime} DT)</span>
            </div>
            <div className="stat-item">
              <button className="promo-export-btn" onClick={exportAsImage}>
                📷 EXPORT JPEG
              </button>
            </div>
          </div>
        </div>
      </div>

      {isExporting && (
        <div
          className="simulation-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15, 23, 42, 0.95)',
          }}
        >
          <div className="loader"></div>
          <h3 style={{ color: '#fbbf24' }}>GÉNÉRATION DU JPEG TITANIUM...</h3>
          <p style={{ color: '#94a3b8' }}>Capture de la grille haute résolution en cours</p>
        </div>
      )}

      {accuracyStats && (
        <div
          className="promo-accuracy-panel"
          style={{
            margin: '8px 16px',
            padding: '10px 16px',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'center', minWidth: '80px' }}>
              <div
                style={{
                  fontSize: '1.5rem',
                  fontWeight: '700',
                  color:
                    parseFloat(accuracyStats.overallAccuracy) > 70
                      ? '#22c55e'
                      : parseFloat(accuracyStats.overallAccuracy) > 60
                        ? '#fbbf24'
                        : '#ef4444',
                }}
              >
                {accuracyStats.overallAccuracy}
              </div>
              <div
                style={{
                  fontSize: '0.55rem',
                  color: '#64748b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Overall
              </div>
            </div>
            {accuracyStats.perGrid?.map((g) => (
              <div key={g.name} style={{ minWidth: '90px', flex: 1 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.55rem',
                    marginBottom: '2px',
                  }}
                >
                  <span style={{ color: '#94a3b8' }}>{g.name}</span>
                  <span style={{ color: '#fbbf24', fontWeight: '600' }}>{g.accuracy}</span>
                </div>
                <div
                  style={{
                    height: '4px',
                    background: 'rgba(255,255,255,0.06)',
                    borderRadius: '2px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: g.accuracy,
                      height: '100%',
                      background: parseFloat(g.accuracy) > 70 ? '#22c55e' : '#fbbf24',
                      borderRadius: '2px',
                      transition: 'width 0.5s',
                    }}
                  />
                </div>
              </div>
            ))}
            {accuracyStats.recentConcours?.length > 0 && (
              <div style={{ minWidth: '120px' }}>
                <div
                  style={{
                    fontSize: '0.55rem',
                    color: '#64748b',
                    textTransform: 'uppercase',
                    marginBottom: '4px',
                  }}
                >
                  Trend
                </div>
                <div
                  style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '24px' }}
                >
                  {accuracyStats.recentConcours.map((c, i) => {
                    const pct = parseFloat(c.accuracy)
                    const h = Math.max(4, (pct / 100) * 24)
                    return (
                      <div
                        key={i}
                        style={{
                          flex: 1,
                          height: `${h}px`,
                          background: pct > 70 ? '#22c55e' : pct > 60 ? '#fbbf24' : '#ef4444',
                          borderRadius: '1px',
                          minWidth: '6px',
                          position: 'relative',
                        }}
                        title={`${c.concours}: ${c.accuracy}`}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export default PromoHeader
