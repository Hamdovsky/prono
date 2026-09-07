// Vue « Colonnes Gagnantes » (extraite de Promosport.jsx, split 2026-09-07).
import React from 'react'

const ColonnesView = ({ reducedSystem, tunisieData, matches }) => {
  return (
    <div className="promosport-weapons" style={{ padding: '20px' }}>
      <div
        style={{
          background: 'rgba(16, 185, 129, 0.08)',
          padding: '25px',
          borderRadius: '15px',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          marginBottom: '25px',
        }}
      >
        <h3
          style={{
            color: '#34d399',
            fontSize: '1.6rem',
            marginBottom: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontWeight: '900',
          }}
        >
          📊 COLONNES GAGNANTES — {reducedSystem.source}
        </h3>
        <p style={{ color: '#94a3b8', marginBottom: '20px' }}>
          Système {reducedSystem.systemType} — {reducedSystem.description}
        </p>

        <div style={{ display: 'flex', gap: '15px', marginBottom: '25px', flexWrap: 'wrap' }}>
          <div
            style={{
              background: 'rgba(16, 185, 129, 0.15)',
              padding: '12px 20px',
              borderRadius: '10px',
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            <span style={{ color: '#34d399', fontWeight: 'bold', fontSize: '1.3rem' }}>
              {reducedSystem.numCols}
            </span>
            <span style={{ color: '#94a3b8', marginLeft: '8px' }}>COLONNES</span>
          </div>
          <div
            style={{
              background: 'rgba(251, 191, 36, 0.15)',
              padding: '12px 20px',
              borderRadius: '10px',
              border: '1px solid rgba(251, 191, 36, 0.3)',
            }}
          >
            <span style={{ color: '#fbbf24', fontWeight: 'bold', fontSize: '1.3rem' }}>
              {reducedSystem.cost.toFixed(2)} DT
            </span>
            <span style={{ color: '#94a3b8', marginLeft: '8px' }}>COÛT TOTAL</span>
          </div>
          <div
            style={{
              background: 'rgba(139, 92, 246, 0.15)',
              padding: '12px 20px',
              borderRadius: '10px',
              border: '1px solid rgba(139, 92, 246, 0.3)',
            }}
          >
            <span style={{ color: '#a78bfa', fontWeight: 'bold', fontSize: '1.3rem' }}>
              {reducedSystem.sortedColumns?.[0]?.score.toFixed(1) || reducedSystem.expectedCorrect}
              /13
            </span>
            <span style={{ color: '#94a3b8', marginLeft: '8px' }}>MEILLEUR SCORE</span>
          </div>
          <div
            style={{
              background: 'rgba(59, 130, 246, 0.15)',
              padding: '12px 20px',
              borderRadius: '10px',
              border: '1px solid rgba(59, 130, 246, 0.3)',
            }}
          >
            <span style={{ color: '#60a5fa', fontWeight: 'bold', fontSize: '1.3rem' }}>
              {reducedSystem.doubleCount}
            </span>
            <span style={{ color: '#94a3b8', marginLeft: '8px' }}>DOUBLES</span>
          </div>
        </div>

        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table
            className="promosport-table"
            style={{
              width: '100%',
              fontSize: '0.8rem',
              borderCollapse: 'collapse',
              minWidth: `${reducedSystem.numCols * 70 + 250}px`,
            }}
          >
            <thead>
              <tr style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '0.7rem' }}>
                <th
                  style={{
                    padding: '8px',
                    position: 'sticky',
                    left: 0,
                    background: '#0f172a',
                    zIndex: 2,
                  }}
                >
                  N°
                </th>
                <th
                  style={{
                    padding: '8px',
                    textAlign: 'left',
                    position: 'sticky',
                    left: '40px',
                    background: '#0f172a',
                    zIndex: 2,
                  }}
                >
                  Match
                </th>
                {reducedSystem.sortedColumns.map((col, ci) => (
                  <th
                    key={ci}
                    style={{
                      padding: '8px',
                      minWidth: '50px',
                      textAlign: 'center',
                      background: ci % 2 === 0 ? 'rgba(16, 185, 129, 0.05)' : 'transparent',
                    }}
                  >
                    <div>Col {ci + 1}</div>
                    <div
                      style={{
                        fontSize: '0.6rem',
                        color: col.score >= 11 ? '#34d399' : col.score >= 9 ? '#fbbf24' : '#f87171',
                        fontWeight: '900',
                        marginTop: '2px',
                      }}
                    >
                      🎯 {col.score.toFixed(1)}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reducedSystem.basePicks.map((bp, mi) => {
                const matchData = (tunisieData?.matches || matches)?.[mi] || {}
                const matchId = matchData.idx || matchData.id || mi + 1
                return (
                  <tr key={mi} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td
                      style={{
                        padding: '6px 8px',
                        color: '#64748b',
                        fontWeight: 'bold',
                        position: 'sticky',
                        left: 0,
                        background: '#0f172a',
                        zIndex: 1,
                      }}
                    >
                      {matchId}
                    </td>
                    <td
                      style={{
                        padding: '6px 8px',
                        fontWeight: '500',
                        whiteSpace: 'nowrap',
                        position: 'sticky',
                        left: '40px',
                        background: '#0f172a',
                        zIndex: 1,
                      }}
                    >
                      <span>{matchData.home || '—'}</span>
                      <span style={{ color: '#475569', margin: '0 3px', fontSize: '0.65rem' }}>
                        vs
                      </span>
                      <span>{matchData.away || '—'}</span>
                    </td>
                    {reducedSystem.sortedColumns.map((col, ci) => {
                      const pick = col.picks[mi]
                      const pickClass =
                        pick === '1'
                          ? 'pick-1'
                          : pick === 'X'
                            ? 'pick-X'
                            : pick === '2'
                              ? 'pick-2'
                              : ''
                      return (
                        <td
                          key={ci}
                          style={{
                            padding: '6px 4px',
                            textAlign: 'center',
                            background: ci % 2 === 0 ? 'rgba(16, 185, 129, 0.03)' : 'transparent',
                          }}
                        >
                          <span
                            className={pickClass}
                            style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: '4px',
                              fontWeight: 'bold',
                              fontSize: '0.85rem',
                              minWidth: '28px',
                            }}
                          >
                            {pick}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="promo-legend">
          <div className="promo-legend-item">
            <span className="promo-legend-dot one">1</span>
            <span style={{ color: '#34d399' }}>Domicile</span>
          </div>
          <div className="promo-legend-item">
            <span className="promo-legend-dot double">X</span>
            <span style={{ color: '#fbbf24' }}>Double (Nul)</span>
          </div>
          <div className="promo-legend-item">
            <span className="promo-legend-dot two">2</span>
            <span style={{ color: '#f87171' }}>Extérieur</span>
          </div>
        </div>
        <p
          style={{
            color: '#64748b',
            fontSize: '0.75rem',
            marginTop: '15px',
            fontStyle: 'italic',
          }}
        >
          💡 Basé sur {reducedSystem.source}. {reducedSystem.doubleCount} doubles →{' '}
          {reducedSystem.fullCols} combinaisons possibles, réduites à {reducedSystem.numCols}{' '}
          colonnes (système {reducedSystem.systemType}). Budget ≤ 100 DT ✓
        </p>
      </div>
    </div>
  )
}

export default ColonnesView
