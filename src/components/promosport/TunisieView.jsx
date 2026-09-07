// Vue « Analyse Foule Tunisie » (extraite de Promosport.jsx, split 2026-09-07).
import React from 'react'

const TunisieView = ({
  tunisieGrid,
  setTunisieGrid,
  fetchTunisie,
  tunisieData,
  tunisieLoading,
  tunisieError,
}) => {
  return (
    <div className="promosport-weapons" style={{ padding: '20px' }}>
      <div
        style={{
          background: 'rgba(30, 41, 59, 0.7)',
          padding: '25px',
          borderRadius: '15px',
          border: '1px solid #10b98133',
          marginBottom: '25px',
        }}
      >
        <h3
          style={{
            color: '#10b981',
            fontSize: '1.6rem',
            marginBottom: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontWeight: '900',
          }}
        >
          🇹🇳 ANALYSE FOULE TUNISIE — GRILLE {tunisieGrid}
        </h3>
        <p style={{ color: '#94a3b8', marginBottom: '20px' }}>
          Précision de la foule vs résultat réel. 🟢 = foule correcte, 🔴 = foule trompée.
        </p>

        <div
          style={{
            display: 'flex',
            gap: '15px',
            marginBottom: '25px',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Grille n°</span>
            <input
              type="number"
              min={623}
              max={876}
              value={tunisieGrid}
              onChange={(e) => setTunisieGrid(parseInt(e.target.value, 10) || 623)}
              style={{
                width: '80px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(0,0,0,0.3)',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '1rem',
              }}
            />
            <button
              onClick={() => fetchTunisie(tunisieGrid)}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid #10b981',
                background: 'rgba(16, 185, 129, 0.2)',
                color: '#34d399',
                fontWeight: 'bold',
                cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              🔍 CHARGER
            </button>
          </div>
          {tunisieData?.crowdSummary && (
            <>
              <div
                style={{
                  background: 'rgba(16, 185, 129, 0.1)',
                  padding: '10px 18px',
                  borderRadius: '10px',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                }}
              >
                <span style={{ color: '#34d399', fontWeight: 'bold', fontSize: '1.2rem' }}>
                  {tunisieData.crowdSummary.accuracy}%
                </span>
                <span style={{ color: '#94a3b8', marginLeft: '8px' }}>PRÉCISION FOULE</span>
              </div>
              <div
                style={{
                  background:
                    tunisieData.crowdSummary.accuracy >= 50
                      ? 'rgba(16, 185, 129, 0.1)'
                      : 'rgba(239, 68, 68, 0.1)',
                  padding: '10px 18px',
                  borderRadius: '10px',
                  border: `1px solid ${tunisieData.crowdSummary.accuracy >= 50 ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                }}
              >
                <span style={{ color: '#94a3b8' }}>
                  {tunisieData.crowdSummary.right}/{tunisieData.crowdSummary.total} bons
                </span>
              </div>
              {tunisieData.cagnotteFormatted && (
                <div
                  style={{
                    background: 'rgba(251, 191, 36, 0.1)',
                    padding: '10px 18px',
                    borderRadius: '10px',
                    border: '1px solid rgba(251, 191, 36, 0.3)',
                  }}
                >
                  <span style={{ color: '#fbbf24', fontWeight: 'bold' }}>
                    {tunisieData.cagnotteFormatted}
                  </span>
                  <span style={{ color: '#94a3b8', marginLeft: '8px' }}>CAGNOTTE</span>
                </div>
              )}
            </>
          )}
          {tunisieLoading && (
            <div style={{ width: '100%', textAlign: 'center', padding: '30px 0' }}>
              <div className="loader" style={{ margin: '0 auto 15px' }}></div>
              <span style={{ color: '#10b981', fontSize: '0.95rem' }}>
                ⏳ Chargement de la grille Tunisienne...
              </span>
              <p style={{ color: '#64748b', fontSize: '0.75rem', marginTop: '8px' }}>
                Scraping du site Promosport Tunisie en cours
              </p>
            </div>
          )}
          {tunisieError && !tunisieLoading && (
            <div
              style={{
                width: '100%',
                textAlign: 'center',
                padding: '20px',
                background: 'rgba(239, 68, 68, 0.1)',
                borderRadius: '10px',
                border: '1px solid rgba(239, 68, 68, 0.3)',
              }}
            >
              <span style={{ color: '#f87171', fontWeight: 'bold' }}>❌ {tunisieError}</span>
              <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: '6px' }}>
                Essaie un autre numéro de grille (623–726 ou 870–875)
              </p>
            </div>
          )}
        </div>

        {tunisieData?.matches && (
          <table
            className="promosport-table"
            style={{ width: '100%', fontSize: '0.9rem', borderCollapse: 'collapse' }}
          >
            <thead>
              <tr style={{ color: '#64748b', textTransform: 'uppercase' }}>
                <th style={{ padding: '10px' }}>N°</th>
                <th style={{ textAlign: 'left', padding: '10px' }}>Match</th>
                <th style={{ padding: '10px' }}>Score</th>
                <th style={{ padding: '10px' }}>Résultat</th>
                <th style={{ padding: '10px' }}>Foule</th>
                <th style={{ padding: '10px' }}>ℹ️</th>
              </tr>
            </thead>
            <tbody>
              {tunisieData.matches.map((m) => {
                const isCorrect = m.crowdCorrect
                const crowdPct = m.crowdFavoritePct
                return (
                  <tr
                    key={m.idx}
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      background:
                        isCorrect === true
                          ? 'rgba(16, 185, 129, 0.03)'
                          : isCorrect === false
                            ? 'rgba(239, 68, 68, 0.03)'
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
                      <span
                        style={{
                          fontWeight: '900',
                          fontSize: '1.1rem',
                          color: '#f8fafc',
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {m.score.replace('-', ' - ')}
                      </span>
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
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
                        {m.result}
                      </span>
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '8px',
                        }}
                      >
                        <span
                          style={{
                            background:
                              m.crowdFavorite === '1'
                                ? 'rgba(59, 130, 246, 0.2)'
                                : m.crowdFavorite === '2'
                                  ? 'rgba(239, 68, 68, 0.2)'
                                  : 'rgba(251, 191, 36, 0.2)',
                            color:
                              m.crowdFavorite === '1'
                                ? '#60a5fa'
                                : m.crowdFavorite === '2'
                                  ? '#f87171'
                                  : '#fbbf24',
                            padding: '4px 10px',
                            borderRadius: '4px',
                            fontWeight: 'bold',
                          }}
                        >
                          {m.crowdFavorite} {crowdPct ? `${crowdPct}%` : ''}
                        </span>
                        {isCorrect === true && (
                          <span
                            title="Foule correcte 🟢"
                            style={{ fontSize: '20px', lineHeight: 1 }}
                          >
                            🟢
                          </span>
                        )}
                        {isCorrect === false && (
                          <span
                            title="Foule trompée 🔴"
                            style={{ fontSize: '20px', lineHeight: 1 }}
                          >
                            🔴
                          </span>
                        )}
                        {isCorrect === null && (
                          <span
                            title="Pas de résultat"
                            style={{ fontSize: '18px', lineHeight: 1, opacity: 0.3 }}
                          >
                            ⚪
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      {m.contrarianSignal && (
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: '900',
                            letterSpacing: '0.5px',
                            color:
                              m.contrarianSignal.recommendation === 'CONTRARIAN'
                                ? '#f87171'
                                : '#34d399',
                            background:
                              m.contrarianSignal.recommendation === 'CONTRARIAN'
                                ? 'rgba(239, 68, 68, 0.15)'
                                : 'rgba(16, 185, 129, 0.15)',
                            padding: '3px 8px',
                            borderRadius: '4px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {m.contrarianSignal.recommendation === 'CONTRARIAN'
                            ? '👎 CONTRARIAN'
                            : '👍 SUIVRE'}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default TunisieView
