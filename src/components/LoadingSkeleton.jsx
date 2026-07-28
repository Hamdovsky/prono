import React from 'react'

const TYPES = {
  page: { rows: 6, height: 16, padding: '40px 20px' },
  table: { rows: 8, height: 14, padding: '20px' },
  card: { rows: 3, height: 12, padding: '20px' },
  chart: { rows: 4, height: 10, padding: '20px' },
}

const LoadingSkeleton = ({ type = 'page', label = 'CHARGEMENT...' }) => {
  const cfg = TYPES[type] || TYPES.page
  const isChart = type === 'chart'
  const isCard = type === 'card'
  return (
    <div style={{ padding: cfg.padding }}>
      <div className="onyx-skeleton-container">
        {Array.from({ length: cfg.rows }, (_, i) => (
          <div
            key={i}
            className="onyx-skeleton-row"
            style={{
              height: cfg.height + 'px',
              width:
                isChart && i === 3
                  ? '60%'
                  : isChart && i === 2
                    ? '80%'
                    : isCard && i === 2
                      ? '50%'
                      : '100%',
            }}
          />
        ))}
        {label && <div className="onyx-loader-text">{label}</div>}
      </div>
    </div>
  )
}

export default LoadingSkeleton
