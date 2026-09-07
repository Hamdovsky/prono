// Vue « Gold Coupon » (extraite de Promosport.jsx, split 2026-09-07).
import React from 'react'

const GoldView = ({ goldCoupon }) => {
  return (
    <div style={{ padding: '16px' }}>
      <div
        style={{
          background: 'rgba(34,197,94,0.06)',
          padding: '20px',
          borderRadius: '12px',
          border: '1px solid rgba(34,197,94,0.2)',
        }}
      >
        <h3 style={{ color: '#22c55e', fontSize: '1.4rem', marginBottom: '6px' }}>
          🥇 GOLD COUPON — 6 DOUBLES
        </h3>
        <p style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: '16px' }}>
          {goldCoupon.stats?.totalSingles || 7} simples + {goldCoupon.stats?.totalDoubles || 6}{' '}
          doubles = {Math.pow(2, goldCoupon.stats?.totalDoubles || 6)} colonnes · Backtest: 56.97%
          précision
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: '6px',
          }}
        >
          {goldCoupon.matches?.map((m, i) => {
            const isDouble = m.choices?.length > 1
            return (
              <div
                key={i}
                style={{
                  padding: '8px 12px',
                  background: isDouble ? 'rgba(251,191,36,0.06)' : 'rgba(255,255,255,0.03)',
                  borderRadius: '6px',
                  border: `1px solid ${isDouble ? 'rgba(251,191,36,0.2)' : 'rgba(255,255,255,0.06)'}`,
                }}
              >
                <div
                  style={{
                    fontSize: '0.5rem',
                    color: isDouble ? '#fbbf24' : '#64748b',
                    textTransform: 'uppercase',
                    marginBottom: '2px',
                  }}
                >
                  {isDouble ? 'DOUBLE' : 'SIMPLE'} · N°{i + 1}
                </div>
                <div style={{ color: '#e2e8f0', fontSize: '0.75rem', fontWeight: '500' }}>
                  {m.home ?? '?'} vs {m.away ?? '?'}
                </div>
                <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                  {['1', 'X', '2'].map((v) => (
                    <span
                      key={v}
                      style={{
                        width: '18px',
                        height: '18px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '3px',
                        fontSize: '0.6rem',
                        fontWeight: '700',
                        background: m.choices?.includes(v) ? '#fbbf24' : 'rgba(255,255,255,0.05)',
                        color: m.choices?.includes(v) ? '#0f172a' : '#475569',
                      }}
                    >
                      {v}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default GoldView
