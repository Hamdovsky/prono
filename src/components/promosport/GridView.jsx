// Vue « Grille » par défaut du module Promosport (extraite de Promosport.jsx,
// split 2026-09-07) : ticket unique 8 premium, grilles 13 matchs T1-T4,
// couverture données, grilles anti-corrélées, rationale IA.
import React from 'react'
import { computeGagnant, SOURCE_LABELS, coverageSummary } from './promoHelpers'

const GridView = ({
  loading,
  loadingStep,
  loadingMessages,
  matches,
  meta,
  showCoverage,
  setShowCoverage,
  viewMode,
  setViewMode,
  handleGenerateColonnes,
  handleGenerateGoldCoupon,
  antiCorr,
  avgConfidence,
}) => {
  return (
    <>
      {loading && (
        <div className="promo-loading">
          <div className="loader-ring"></div>
          <div className="loading-progress-bar">
            <div className="loading-progress-fill"></div>
          </div>
          <p style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 4 }}>
            ANALYSE TITANIUM EN COURS
          </p>
          <div className="loading-step">{loadingMessages[loadingStep]}...</div>
        </div>
      )}

      {/* 🎫 TICKET UNIQUE (8 PREMIUM) — FORMAT COLONNES */}
      <div
        className="ticket-unique-section"
        style={{
          background: 'rgba(30, 41, 59, 0.7)',
          padding: '25px',
          borderRadius: '15px',
          marginBottom: '30px',
          border: '1px solid #fbbf2433',
          boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
        }}
      >
        <h3
          style={{
            color: '#fbbf24',
            fontSize: '1.6rem',
            marginBottom: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontWeight: '900',
          }}
        >
          <span style={{ fontSize: '2rem' }}>🎫</span> TICKET UNIQUE (8 MATCHS PREMIUM) — ANALYSE
          TITANIUM
        </h3>
        <div
          style={{
            color: '#94a3b8',
            fontSize: '0.9rem',
            marginBottom: '20px',
            paddingLeft: '40px',
          }}
        >
          ⚠️ Sélection automatique des 8 meilleurs matchs basée sur l'indice de confiance Titanium
          (P differential {'>'} 45%).
        </div>

        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table
            className="promosport-table"
            style={{
              width: '100%',
              fontSize: '0.9rem',
              borderCollapse: 'collapse',
              minWidth: '400px',
            }}
          >
            <thead>
              <tr
                style={{
                  color: '#64748b',
                  fontSize: '0.7rem',
                  textTransform: 'uppercase',
                  borderBottom: '2px solid rgba(251, 191, 36, 0.2)',
                }}
              >
                <th style={{ padding: '8px 6px', textAlign: 'center', minWidth: '40px' }}>N°</th>
                <th style={{ padding: '8px 6px', textAlign: 'left', minWidth: '120px' }}>
                  Domicile
                </th>
                <th
                  style={{
                    padding: '8px 6px',
                    textAlign: 'center',
                    minWidth: '60px',
                    color: '#fbbf24',
                  }}
                >
                  G1
                </th>
                <th
                  style={{
                    padding: '8px 6px',
                    textAlign: 'center',
                    minWidth: '60px',
                    color: '#fbbf24',
                  }}
                >
                  G2
                </th>
                <th
                  style={{
                    padding: '8px 6px',
                    textAlign: 'center',
                    minWidth: '60px',
                    color: '#fbbf24',
                  }}
                >
                  G3
                </th>
                <th
                  style={{
                    padding: '8px 6px',
                    textAlign: 'center',
                    minWidth: '60px',
                    color: '#fbbf24',
                  }}
                >
                  G4
                </th>
                <th style={{ padding: '8px 6px', textAlign: 'right', minWidth: '120px' }}>
                  Extérieur
                </th>
              </tr>
            </thead>
            <tbody>
              {matches.slice(0, 13).map((m) => {
                const pickBox = (pred, val) => {
                  const isActive = pred.includes(val)
                  return (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '22px',
                        height: '22px',
                        borderRadius: '3px',
                        fontWeight: 'bold',
                        fontSize: '0.75rem',
                        background: isActive
                          ? val === '1'
                            ? 'rgba(59, 130, 246, 0.35)'
                            : val === 'X'
                              ? 'rgba(251, 191, 36, 0.35)'
                              : 'rgba(239, 68, 68, 0.35)'
                          : 'rgba(100, 116, 139, 0.08)',
                        color: isActive
                          ? val === '1'
                            ? '#60a5fa'
                            : val === 'X'
                              ? '#fbbf24'
                              : '#f87171'
                          : '#334155',
                        border: isActive
                          ? '1px solid ' +
                            (val === '1'
                              ? 'rgba(59, 130, 246, 0.4)'
                              : val === 'X'
                                ? 'rgba(251, 191, 36, 0.4)'
                                : 'rgba(239, 68, 68, 0.4)')
                          : '1px solid rgba(255,255,255,0.03)',
                      }}
                    >
                      {val}
                    </span>
                  )
                }
                return (
                  <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td
                      style={{
                        padding: '10px 6px',
                        textAlign: 'center',
                        color: '#64748b',
                        fontWeight: 'bold',
                      }}
                    >
                      <span style={{ fontSize: '0.7rem', color: '#fbbf24' }}>{m.time}</span>
                      <br />
                      <span>{m.id}</span>
                    </td>
                    <td
                      style={{
                        padding: '10px 6px',
                        textAlign: 'left',
                        fontWeight: '600',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {m.home}
                    </td>
                    {[0, 1, 2, 3].map((ci) => (
                      <td
                        key={ci}
                        style={{
                          padding: '8px 6px',
                          textAlign: 'center',
                          borderLeft: '1px solid rgba(255,255,255,0.03)',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '2px' }}>
                          {pickBox(m.cols[ci]?.pred || '?', '1')}
                          {pickBox(m.cols[ci]?.pred || '?', 'X')}
                          {pickBox(m.cols[ci]?.pred || '?', '2')}
                        </div>
                      </td>
                    ))}
                    <td
                      style={{
                        padding: '10px 6px',
                        textAlign: 'right',
                        fontWeight: '600',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {m.away}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div
          className="ia-rationale-section"
          style={{
            marginTop: '25px',
            padding: '20px',
            background: 'rgba(0,0,0,0.2)',
            borderRadius: '10px',
            border: '1px dashed rgba(251, 191, 36, 0.3)',
          }}
        >
          <h4
            style={{
              color: '#fbbf24',
              marginBottom: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span>🧠</span> IA Rationale (Tactique & Stratégique)
          </h4>
          <ul
            style={{
              margin: 0,
              paddingLeft: '20px',
              color: '#94a3b8',
              fontSize: '0.9rem',
              lineHeight: '1.6',
            }}
          >
            <li>
              <b>Focus Premium:</b> Sélection des matchs avec un différentiel de probabilité {'>'}{' '}
              45%.
            </li>
            <li>
              <b>Indice Titanium:</b> Score de confiance global de <b>{avgConfidence}%</b> pour
              cette série.
            </li>
            <li>
              <b>Analyse:</b> Les grilles 2 et 3 intègrent des couvertures de sécurité sur les
              matchs à variance élevée (Derbies & CL SF).
            </li>
          </ul>
        </div>
      </div>

      {/* 📊 FULL 13 MATCH GRIDS — FORMAT COLONNES PROMOSPORT */}
      <div
        className="promosport-columns-container"
        style={{
          background: 'rgba(30, 41, 59, 0.4)',
          borderRadius: '15px',
          padding: '15px',
          border: '1px solid rgba(255,255,255,0.05)',
          marginTop: '30px',
        }}
      >
        <h3
          style={{
            textAlign: 'center',
            color: '#fbbf24',
            margin: '15px 0 5px 0',
            fontSize: '1.3rem',
            fontWeight: 'bold',
            letterSpacing: '2px',
          }}
        >
          📊 PROMOSPORT — {meta.grid_names.join(' | ').toUpperCase()}
        </h3>
        <p
          style={{
            textAlign: 'center',
            color: '#64748b',
            fontSize: '0.75rem',
            marginBottom: '20px',
          }}
        >
          Double ⬤ / Triple ⬤ — © TITANIUM NEURAL-X v3.0
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
          <button
            onClick={() => setShowCoverage(!showCoverage)}
            title="Couverture des données : match en base, cotes réelles 1X2, stats archive, alias registre"
            style={{
              background: showCoverage ? 'rgba(52, 211, 153, 0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${showCoverage ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.1)'}`,
              color: showCoverage ? '#34d399' : '#94a3b8',
              padding: '6px 14px',
              borderRadius: '8px',
              fontSize: '0.7rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              letterSpacing: '1px',
            }}
          >
            {showCoverage ? '▾ CACHER' : '▸'} 🗄️ COUVERTURE & COTES
          </button>
        </div>
        {showCoverage && (
          <div
            style={{
              overflowX: 'auto',
              marginBottom: '16px',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '10px',
              padding: '10px',
            }}
          >
            {(() => {
              const s = coverageSummary(matches)
              return (
                <div
                  style={{
                    fontSize: '0.7rem',
                    color: '#94a3b8',
                    marginBottom: '8px',
                    display: 'flex',
                    gap: '16px',
                    flexWrap: 'wrap',
                  }}
                >
                  <span>
                    🗄️ Base DB:{' '}
                    <b style={{ color: s.db === s.total ? '#34d399' : '#fbbf24' }}>
                      {s.db}/{s.total}
                    </b>
                  </span>
                  <span>
                    🎯 Cotes réelles:{' '}
                    <b style={{ color: s.odds === s.total ? '#34d399' : '#fbbf24' }}>
                      {s.odds}/{s.total}
                    </b>
                  </span>
                  <span>
                    📚 Stats archive:{' '}
                    <b style={{ color: s.arch === s.total ? '#34d399' : '#fbbf24' }}>
                      {s.arch}/{s.total}
                    </b>
                  </span>
                  <span>
                    🏷️ Alias:{' '}
                    <b style={{ color: s.alias === s.total ? '#34d399' : '#fbbf24' }}>
                      {s.alias}/{s.total}
                    </b>
                  </span>
                </div>
              )
            })()}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.68rem' }}>
              <thead>
                <tr
                  style={{
                    color: '#64748b',
                    textTransform: 'uppercase',
                    fontSize: '0.62rem',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <th style={{ padding: '6px 4px', textAlign: 'left' }}>Match</th>
                  <th style={{ padding: '6px 4px', textAlign: 'center' }}>Base DB</th>
                  <th style={{ padding: '6px 4px', textAlign: 'center' }}>Cotes H/D/A</th>
                  <th style={{ padding: '6px 4px', textAlign: 'center' }}>Stats arch.</th>
                  <th style={{ padding: '6px 4px', textAlign: 'center' }}>Alias</th>
                  <th style={{ padding: '6px 4px', textAlign: 'center' }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => {
                  const c = m?.coverage || {}
                  const dot = (good) => (
                    <span style={{ color: good ? '#34d399' : '#dc2626', fontWeight: 'bold' }}>
                      {good ? '✓' : '✗'}
                    </span>
                  )
                  return (
                    <tr
                      key={m.id}
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        color: '#cbd5e1',
                      }}
                    >
                      <td style={{ padding: '5px 4px', whiteSpace: 'nowrap' }}>
                        {m.id}. {m.home} vs {m.away}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }}>{dot(c.dbMatch)}</td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }}>
                        {m.odds?.h > 0 ? (
                          <span style={{ color: '#94a3b8' }}>
                            {m.odds.h}/{m.odds.d}/{m.odds.a}
                          </span>
                        ) : (
                          <span style={{ color: '#dc2626' }}>sans</span>
                        )}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }}>
                        {dot(c.archStats)}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }}>
                        {dot(c.aliasHome && c.aliasAway)}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }}>
                        <span style={{ color: '#fbbf24' }}>
                          {SOURCE_LABELS[m.source] || 'ML'}
                          {m.xgbBlended ? '+XGB' : ''}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table
            className="promosport-table"
            style={{
              width: '100%',
              fontSize: '0.85rem',
              borderCollapse: 'collapse',
              minWidth: '450px',
            }}
          >
            <thead>
              <tr
                style={{
                  color: '#64748b',
                  fontSize: '0.7rem',
                  textTransform: 'uppercase',
                  borderBottom: '2px solid rgba(251, 191, 36, 0.2)',
                }}
              >
                <th
                  style={{
                    padding: '8px 6px',
                    position: 'sticky',
                    left: 0,
                    background: '#1e293b',
                    zIndex: 2,
                    minWidth: '40px',
                    textAlign: 'center',
                  }}
                >
                  N°
                </th>
                <th style={{ padding: '8px 6px', textAlign: 'center', minWidth: '150px' }}>
                  Équipe 1
                </th>
                <th
                  style={{
                    padding: '8px 4px',
                    textAlign: 'center',
                    minWidth: '30px',
                    color: '#fbbf24',
                    fontSize: '0.65rem',
                  }}
                >
                  %1
                </th>
                <th
                  style={{
                    padding: '8px 4px',
                    textAlign: 'center',
                    minWidth: '30px',
                    color: '#fbbf24',
                    fontSize: '0.65rem',
                  }}
                >
                  %X
                </th>
                <th
                  style={{
                    padding: '8px 4px',
                    textAlign: 'center',
                    minWidth: '30px',
                    color: '#fbbf24',
                    fontSize: '0.65rem',
                  }}
                >
                  %2
                </th>
                <th
                  style={{
                    padding: '8px 6px',
                    textAlign: 'center',
                    minWidth: '62px',
                    color: '#34d399',
                    fontSize: '0.65rem',
                    letterSpacing: '1px',
                  }}
                >
                  GAGNANT
                </th>
                <th style={{ padding: '8px 6px', textAlign: 'center', minWidth: '150px' }}>
                  Équipe 2
                </th>
                {meta.grid_names.map((name, ci) => {
                  const gs = meta.gridStats?.[ci]
                  return (
                    <th
                      key={ci}
                      style={{
                        padding: '8px 6px',
                        textAlign: 'center',
                        minWidth: '55px',
                        borderLeft: '1px solid rgba(251, 191, 36, 0.15)',
                        color: '#fbbf24',
                      }}
                    >
                      {name}
                      {gs && (
                        <div style={{ fontSize: '0.6rem', color: '#10b981', marginTop: '2px' }}>
                          {gs.doubles} doubles
                        </div>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => {
                const p1 = match.mlProbs?.h ?? match.probs?.h ?? 0
                const px = match.mlProbs?.x ?? match.mlProbs?.n ?? match.probs?.n ?? 0
                const p2 = match.mlProbs?.a ?? match.probs?.a ?? 0
                const gagnant = computeGagnant(match)
                const isGagSimple = ['1', '2'].includes(String(gagnant.pick)) && gagnant.prob >= 65
                const srcText = `${SOURCE_LABELS[match.source] || 'ML'}${match.xgbBlended ? '+XGB' : ''}`
                return (
                  <tr
                    key={match.id}
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                    }}
                  >
                    <td
                      style={{
                        padding: '10px 6px',
                        textAlign: 'center',
                        color: '#475569',
                        fontWeight: 'bold',
                        position: 'sticky',
                        left: 0,
                        background: '#1e293b',
                        zIndex: 1,
                      }}
                    >
                      <span style={{ fontSize: '0.75rem' }}>{match.time}</span>
                      <br />
                      <span>{match.id}</span>
                    </td>
                    <td
                      style={{
                        padding: '10px 6px',
                        textAlign: 'right',
                        fontWeight: '600',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {match.home}
                      <div
                        style={{
                          fontSize: '0.6rem',
                          color: match.odds?.h > 0 ? '#94a3b8' : '#475569',
                          marginTop: '3px',
                          whiteSpace: 'nowrap',
                          fontWeight: 'normal',
                        }}
                      >
                        {match.odds?.h > 0
                          ? `@ ${match.odds.h}/${match.odds.d}/${match.odds.a}`
                          : 'sans cotes'}
                      </div>
                    </td>
                    <td style={{ padding: '10px 4px', textAlign: 'center' }}>
                      <span
                        style={{
                          color: p1 >= 55 ? '#34d399' : '#64748b',
                          fontWeight: p1 >= 55 ? 'bold' : 'normal',
                        }}
                      >
                        {p1}%
                      </span>
                    </td>
                    <td style={{ padding: '10px 4px', textAlign: 'center' }}>
                      <span style={{ color: '#fbbf24' }}>{px}%</span>
                    </td>
                    <td style={{ padding: '10px 4px', textAlign: 'center' }}>
                      <span
                        style={{
                          color: p2 >= 60 ? '#34d399' : '#64748b',
                          fontWeight: p2 >= 60 ? 'bold' : 'normal',
                        }}
                      >
                        {p2}%
                      </span>
                    </td>
                    <td style={{ padding: '10px 4px', textAlign: 'center', minWidth: '62px' }}>
                      <span
                        style={{
                          color: isGagSimple ? '#34d399' : '#fbbf24',
                          fontWeight: 'bold',
                          fontSize: '0.95rem',
                          display: 'inline-block',
                          background: isGagSimple
                            ? 'rgba(16, 185, 129, 0.15)'
                            : 'rgba(251, 191, 36, 0.15)',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {gagnant.pick} {gagnant.prob > 0 ? `${gagnant.prob}%` : ''}
                      </span>
                      <div
                        style={{
                          fontSize: '0.55rem',
                          color: '#475569',
                          marginTop: '3px',
                          fontWeight: '700',
                          letterSpacing: '0.5px',
                        }}
                        title={`Source proba: ${match.source || 'ml'}${match.xgbBlended ? ' + XGBoost' : ''}`}
                      >
                        {srcText}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: '10px 6px',
                        textAlign: 'left',
                        fontWeight: '600',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {match.away}
                    </td>
                    {[0, 1, 2, 3].map((ci) => {
                      const colData = match.cols[ci] || { pred: '?' }
                      const isDouble = colData.pred.length > 1
                      const isTriple = colData.pred.length > 2
                      const pickBoxStyle = {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '26px',
                        height: '26px',
                        borderRadius: '3px',
                        fontWeight: 'bold',
                        fontSize: '0.8rem',
                        background: isTriple
                          ? 'rgba(251, 191, 36, 0.2)'
                          : isDouble
                            ? 'rgba(16, 185, 129, 0.2)'
                            : colData.pred === '1'
                              ? 'rgba(59, 130, 246, 0.3)'
                              : colData.pred === 'X'
                                ? 'rgba(251, 191, 36, 0.3)'
                                : colData.pred === '2'
                                  ? 'rgba(239, 68, 68, 0.3)'
                                  : 'rgba(100, 116, 139, 0.15)',
                        color: isTriple
                          ? '#fbbf24'
                          : isDouble
                            ? '#34d399'
                            : colData.pred === '1'
                              ? '#60a5fa'
                              : colData.pred === 'X'
                                ? '#fbbf24'
                                : colData.pred === '2'
                                  ? '#f87171'
                                  : '#64748b',
                        border: `1px solid ${isTriple ? 'rgba(251, 191, 36, 0.4)' : isDouble ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255,255,255,0.1)'}`,
                      }
                      return (
                        <td
                          key={ci}
                          style={{
                            padding: '8px 6px',
                            textAlign: 'center',
                            borderLeft: '1px solid rgba(255,255,255,0.03)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'center', gap: '2px' }}>
                            {colData.pred.includes('1') && (
                              <span style={{ ...pickBoxStyle }}>1</span>
                            )}
                            {colData.pred.includes('X') && (
                              <span
                                style={{
                                  ...pickBoxStyle,
                                  background: 'rgba(251, 191, 36, 0.25)',
                                  color: '#fbbf24',
                                }}
                              >
                                X
                              </span>
                            )}
                            {colData.pred.includes('2') && (
                              <span
                                style={{
                                  ...pickBoxStyle,
                                  background: 'rgba(239, 68, 68, 0.25)',
                                  color: '#f87171',
                                }}
                              >
                                2
                              </span>
                            )}
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'center',
                              gap: '8px',
                              margin: '8px 0',
                            }}
                          >
                            <button
                              onClick={() =>
                                setViewMode(viewMode === 'terminal' ? 'grid' : 'terminal')
                              }
                              style={{
                                padding: '4px 12px',
                                fontSize: '0.6rem',
                                background:
                                  viewMode === 'terminal'
                                    ? 'rgba(251,191,36,0.2)'
                                    : 'rgba(255,255,255,0.05)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px',
                                color: viewMode === 'terminal' ? '#fbbf24' : '#94a3b8',
                                cursor: 'pointer',
                                fontWeight: '600',
                                textTransform: 'uppercase',
                              }}
                            >
                              📟 Terminal
                            </button>
                            <button
                              onClick={() =>
                                setViewMode(viewMode === 'calculator' ? 'grid' : 'calculator')
                              }
                              style={{
                                padding: '4px 12px',
                                fontSize: '0.6rem',
                                background:
                                  viewMode === 'calculator'
                                    ? 'rgba(251,191,36,0.2)'
                                    : 'rgba(255,255,255,0.05)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px',
                                color: viewMode === 'calculator' ? '#fbbf24' : '#94a3b8',
                                cursor: 'pointer',
                                fontWeight: '600',
                                textTransform: 'uppercase',
                              }}
                            >
                              🧮 Calculator
                            </button>
                            <button
                              onClick={handleGenerateColonnes}
                              style={{
                                padding: '4px 12px',
                                fontSize: '0.6rem',
                                background: 'rgba(16,185,129,0.15)',
                                border: '1px solid rgba(16,185,129,0.3)',
                                borderRadius: '6px',
                                color: '#34d399',
                                cursor: 'pointer',
                                fontWeight: '600',
                                textTransform: 'uppercase',
                              }}
                            >
                              📊 Colonnes ML
                            </button>
                            <button
                              onClick={handleGenerateGoldCoupon}
                              style={{
                                padding: '4px 12px',
                                fontSize: '0.6rem',
                                background: 'rgba(34,197,94,0.15)',
                                border: '1px solid rgba(34,197,94,0.3)',
                                borderRadius: '6px',
                                color: '#22c55e',
                                cursor: 'pointer',
                                fontWeight: '600',
                                textTransform: 'uppercase',
                              }}
                            >
                              🥇 Gold 6D (56.9%)
                            </button>
                            <button
                              onClick={() =>
                                setViewMode(viewMode === 'accuracy' ? 'grid' : 'accuracy')
                              }
                              style={{
                                padding: '4px 12px',
                                fontSize: '0.6rem',
                                background:
                                  viewMode === 'accuracy'
                                    ? 'rgba(139,92,246,0.2)'
                                    : 'rgba(255,255,255,0.05)',
                                border: '1px solid rgba(139,92,246,0.3)',
                                borderRadius: '6px',
                                color: viewMode === 'accuracy' ? '#a78bfa' : '#94a3b8',
                                cursor: 'pointer',
                                fontWeight: '600',
                                textTransform: 'uppercase',
                              }}
                            >
                              📊 Précision
                            </button>
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {antiCorr && antiCorr.grids && antiCorr.grids.length > 0 && (
        <div
          style={{
            marginTop: '40px',
            padding: '25px',
            background: 'rgba(15, 23, 42, 0.8)',
            borderRadius: '20px',
            border: '1px solid rgba(251, 191, 36, 0.2)',
          }}
        >
          <h3
            style={{
              color: '#fbbf24',
              fontSize: '1.4rem',
              marginBottom: '4px',
              fontWeight: '900',
            }}
          >
            🎯 {antiCorr.count} GRILLES ANTI-CORRÉLÉES
          </h3>
          <p
            style={{
              color: '#94a3b8',
              fontSize: '0.9rem',
              marginBottom: '16px',
            }}
          >
            13 simples par grille — budget {antiCorr.budgetTnd} TND · diversification gloutonne sur
            les matchs incertains (gap top1-top2 &lt; 0.15)
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.85rem',
                minWidth: '900px',
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      padding: '8px 6px',
                      textAlign: 'left',
                      minWidth: '220px',
                      color: '#fbbf24',
                    }}
                  >
                    Match
                  </th>
                  {antiCorr.grids.map((g, gi) => (
                    <th key={gi} style={{ padding: '8px 6px', textAlign: 'center' }}>
                      {g.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matches.slice(0, antiCorr.grids[0].picks.length).map((m, mi) => (
                  <tr key={m.id || mi}>
                    <td
                      style={{
                        padding: '8px 6px',
                        whiteSpace: 'nowrap',
                        color: '#e2e8f0',
                      }}
                    >
                      {m.id}. {m.home} — {m.away}
                    </td>
                    {antiCorr.grids.map((g, gi) => {
                      const pick = g.picks[mi] || '?'
                      const isUncertain = g.inUncertain && g.inUncertain[mi]
                      const pickStyle = {
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '26px',
                        height: '26px',
                        borderRadius: '3px',
                        fontWeight: 'bold',
                        fontSize: '0.8rem',
                        background:
                          pick === '1'
                            ? 'rgba(59, 130, 246, 0.3)'
                            : pick === 'X'
                              ? 'rgba(251, 191, 36, 0.3)'
                              : pick === '2'
                                ? 'rgba(239, 68, 68, 0.3)'
                                : 'rgba(100, 116, 139, 0.15)',
                        color:
                          pick === '1'
                            ? '#60a5fa'
                            : pick === 'X'
                              ? '#fbbf24'
                              : pick === '2'
                                ? '#f87171'
                                : '#64748b',
                        border: isUncertain
                          ? '1px dashed rgba(251, 191, 36, 0.5)'
                          : '1px solid rgba(255,255,255,0.1)',
                        opacity: isUncertain ? 1 : 0.85,
                      }
                      return (
                        <td
                          key={gi}
                          style={{ padding: '8px 6px', textAlign: 'center' }}
                          title={isUncertain ? 'Match incertain (rotation active)' : ''}
                        >
                          <span style={{ ...pickStyle }}>{pick}</span>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div
        className="promosport-analysis"
        style={{
          marginTop: '40px',
          padding: '25px',
          background: 'rgba(15, 23, 42, 0.8)',
          borderRadius: '20px',
          border: '1px solid rgba(251, 191, 36, 0.2)',
        }}
      >
        <h3
          style={{
            color: '#fbbf24',
            fontSize: '1.4rem',
            marginBottom: '20px',
            fontWeight: '900',
          }}
        >
          🧠 IA Rationale (Tactique & Stratégique)
        </h3>
        <div
          className="rationale-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '20px',
          }}
        >
          <div
            className="rationale-card"
            style={{
              background: 'rgba(30, 41, 59, 0.5)',
              padding: '15px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <h4 style={{ color: '#10b981', fontSize: '1rem', marginBottom: '8px' }}>
              STRATÉGIE EDGE OPTIMIZED
            </h4>
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
              Sélectionne les matchs où le modèle a le plus d'avance sur la foule (edge {'>'} 5pts).
              Maximise la valeur réelle en jouant les picks où l'IA voit mieux que le public.
            </p>
          </div>
          <div
            className="rationale-card"
            style={{
              background: 'rgba(30, 41, 59, 0.5)',
              padding: '15px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <h4 style={{ color: '#fbbf24', fontSize: '1rem', marginBottom: '8px' }}>
              STRATÉGIE HIGH VALUE
            </h4>
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
              Favorise les choix où la probabilité réelle dépasse de 20% la probabilité publique
              estimée. Cible les surprises potentielles de Freiburg et Nottingham Forest.
            </p>
          </div>
          <div
            className="rationale-card"
            style={{
              background: 'rgba(30, 41, 59, 0.5)',
              padding: '15px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <h4 style={{ color: '#3b82f6', fontSize: '1rem', marginBottom: '8px' }}>
              COUVERTURE SÉCURISÉE
            </h4>
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
              Priorise les favoris avec des indices de confiance Titanium {'>'} 85% (Al Nassr, Aston
              Villa). Utilise les doubles pour verrouiller les résultats nuls probables en Ligue 1
              Tunisienne.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

export default GridView
