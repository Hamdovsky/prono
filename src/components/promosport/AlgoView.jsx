// Vue « Algorithme Gagnant » (extraite de Promosport.jsx, split 2026-09-07).
import React from 'react'

const AlgoView = ({ algoPicks, tunisieGrid }) => {
  return (
    <div className="promosport-weapons" style={{ padding: '20px' }}>
      <div
        style={{
          background: 'rgba(30, 41, 59, 0.7)',
          padding: '25px',
          borderRadius: '15px',
          border: '1px solid #8b5cf633',
          marginBottom: '25px',
        }}
      >
        <h3
          style={{
            color: '#a78bfa',
            fontSize: '1.6rem',
            marginBottom: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontWeight: '900',
          }}
        >
          🤖 ALGORITHME GAGNANT — GRILLE {tunisieGrid}
        </h3>
        <p style={{ color: '#94a3b8', marginBottom: '20px' }}>
          Picks calculés par TITANIUM ML HYBRID (XGBoost + foule Tunisienne). 🟢 = simple, 🟡 =
          double (entropy élevée).
        </p>

        <div style={{ display: 'flex', gap: '15px', marginBottom: '25px', flexWrap: 'wrap' }}>
          <div
            style={{
              background: 'rgba(139, 92, 246, 0.15)',
              padding: '12px 20px',
              borderRadius: '10px',
              border: '1px solid rgba(139, 92, 246, 0.3)',
            }}
          >
            <span style={{ color: '#a78bfa', fontWeight: 'bold', fontSize: '1.3rem' }}>
              {algoPicks.expectedCorrect}
            </span>
            <span style={{ color: '#94a3b8', marginLeft: '8px' }}>RÉPONSES ATTENDUES</span>
          </div>
          <div
            style={{
              background: 'rgba(16, 185, 129, 0.1)',
              padding: '12px 20px',
              borderRadius: '10px',
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            <span style={{ color: '#34d399', fontWeight: 'bold', fontSize: '1.3rem' }}>
              {algoPicks.simples}
            </span>
            <span style={{ color: '#94a3b8', marginLeft: '8px' }}>SIMPLES</span>
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
              {algoPicks.doubles}
            </span>
            <span style={{ color: '#fbbf24', marginLeft: '8px' }}>DOUBLES</span>
          </div>
          <div
            style={{
              background: 'rgba(59, 130, 246, 0.1)',
              padding: '12px 20px',
              borderRadius: '10px',
              border: '1px solid rgba(59, 130, 246, 0.3)',
            }}
          >
            <span style={{ color: '#60a5fa', fontWeight: 'bold', fontSize: '1.3rem' }}>
              {algoPicks.avgConf}%
            </span>
            <span style={{ color: '#94a3b8', marginLeft: '8px' }}>CONF. MOYENNE</span>
          </div>
        </div>

        <table
          className="promosport-table"
          style={{ width: '100%', fontSize: '0.9rem', borderCollapse: 'collapse' }}
        >
          <thead>
            <tr style={{ color: '#64748b', textTransform: 'uppercase' }}>
              <th style={{ padding: '10px' }}>N°</th>
              <th style={{ textAlign: 'left', padding: '10px' }}>Match</th>
              <th style={{ padding: '10px' }}>Vote foule</th>
              <th style={{ padding: '10px' }}>Algo</th>
              <th style={{ padding: '10px' }}>Résultat</th>
              <th style={{ padding: '10px' }}>ℹ️</th>
            </tr>
          </thead>
          <tbody>
            {algoPicks.picks.map((m) => {
              const a = m.algo
              const isDouble = a.type === 'double'
              const isSimple = a.type === 'simple'
              const correct = m.result ? a.pick.includes(m.result) : null
              return (
                <tr
                  key={m.idx}
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    background:
                      correct === true
                        ? 'rgba(16, 185, 129, 0.05)'
                        : correct === false
                          ? 'rgba(239, 68, 68, 0.05)'
                          : 'transparent',
                  }}
                >
                  <td style={{ color: '#64748b', fontWeight: 'bold', padding: '12px 10px' }}>
                    {m.idx}
                  </td>
                  <td style={{ fontWeight: '600', padding: '12px 10px' }}>
                    <span>{m.home}</span>
                    <span style={{ color: '#475569', margin: '0 5px' }}>vs</span>
                    <span>{m.away}</span>
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    {m.mlProbs && (
                      <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                        1:{Math.round(m.mlProbs.h)}% X:{Math.round(m.mlProbs.x)}% 2:
                        {Math.round(m.mlProbs.a)}%
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                      }}
                    >
                      <span
                        style={{
                          background: isDouble
                            ? 'rgba(251, 191, 36, 0.25)'
                            : 'rgba(16, 185, 129, 0.2)',
                          color: isDouble ? '#fbbf24' : '#34d399',
                          padding: '4px 12px',
                          borderRadius: '4px',
                          fontWeight: 'bold',
                          fontSize: '1rem',
                        }}
                      >
                        {a.pick}
                      </span>
                      <span style={{ fontSize: '10px', color: '#64748b', fontWeight: '900' }}>
                        {a.conf}%
                      </span>
                      <span title={isDouble ? 'Double' : 'Simple'} style={{ fontSize: '14px' }}>
                        {isDouble ? '🟡' : '🟢'}
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    {m.result ? (
                      <span
                        style={{
                          background:
                            m.result === '1'
                              ? 'rgba(59, 130, 246, 0.2)'
                              : m.result === '2'
                                ? 'rgba(239, 68, 68, 0.2)'
                                : 'rgba(251, 191, 36, 0.2)',
                          color:
                            m.result === '1' ? '#60a5fa' : m.result === '2' ? '#f87171' : '#fbbf24',
                          padding: '4px 12px',
                          borderRadius: '4px',
                          fontWeight: 'bold',
                        }}
                      >
                        {m.result}{' '}
                        <span
                          style={{
                            fontWeight: '900',
                            color: '#f8fafc',
                            fontFamily: "'JetBrains Mono', monospace",
                          }}
                        >
                          {m.score}
                        </span>
                      </span>
                    ) : (
                      <span style={{ color: '#475569' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                    {correct === true && (
                      <span title="Algo correct ✓" style={{ fontSize: '20px' }}>
                        ✅
                      </span>
                    )}
                    {correct === false && (
                      <span title="Algo faux ✗" style={{ fontSize: '20px' }}>
                        ❌
                      </span>
                    )}
                    {a.entropy && (
                      <span
                        title={`Entropy: ${a.entropy.toFixed(2)}`}
                        style={{ fontSize: '12px', color: '#64748b', marginLeft: '4px' }}
                      >
                        🎲
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p
          style={{
            color: '#64748b',
            fontSize: '0.75rem',
            marginTop: '15px',
            fontStyle: 'italic',
          }}
        >
          Algorithme basé sur l'analyse de 2452 matchs Tunisiens. Règle: 1 ≥ 55% → pick 1 (69.2%). 2
          ≥ 60% → pick 2 (67.9%). Les matchs sans favori clair sont ignorés (bruit).
        </p>
      </div>
    </div>
  )
}

export default AlgoView
