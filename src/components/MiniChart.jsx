import React from 'react'

/* ─── Area Chart ─── */
export function AreaChartSVG({ data, xKey, yKey, height = 300, color = '#10b981', gradientId = 'g1' }) {
  if (!data?.length) return null
  const w = 600
  const pad = { top: 20, right: 20, bottom: 40, left: 50 }
  const iw = w - pad.left - pad.right
  const ih = height - pad.top - pad.bottom
  const maxY = Math.max(...data.map(d => d[yKey]), 1) * 1.15
  const minX = 0
  const maxX = data.length - 1

  const scaleX = (i) => pad.left + (i / maxX) * iw
  const scaleY = (v) => pad.top + ih - (v / maxY) * ih

  const pts = data.map((d, i) => `${scaleX(i)},${scaleY(d[yKey])}`).join(' ')
  const polyPts = `${pad.left},${pad.top + ih} ${pts} ${scaleX(maxX)},${pad.top + ih}`

  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: '100%', height }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor={color} stopOpacity={0.3} />
          <stop offset="95%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* Grid */}
      {[0, 0.25, 0.5, 0.75, 1].map(t => (
        <line key={t} x1={pad.left} x2={pad.left + iw} y1={scaleY(t * maxY)} y2={scaleY(t * maxY)}
          stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
      ))}
      {/* Area fill */}
      <polygon points={polyPts} fill={`url(#${gradientId})`} />
      {/* Line */}
      <polyline points={pts} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      {/* X labels (show every nth) */}
      {data.map((d, i) =>
        (maxX <= 15 || i % Math.ceil(maxX / 10) === 0) && (
          <text key={`xl${i}`} x={scaleX(i)} y={pad.top + ih + 16} textAnchor="middle" fill="#64748b" fontSize={10}>
            {d[xKey]?.slice(5) || i}
          </text>
        )
      )}
      {/* Y labels */}
      {[0, 0.25, 0.5, 0.75, 1].map(t => (
        <text key={`yl${t}`} x={pad.left - 8} y={scaleY(t * maxY) + 4} textAnchor="end" fill="#64748b" fontSize={10}>
          {(t * maxY).toFixed(1)}
        </text>
      ))}
    </svg>
  )
}

/* ─── Bar Chart ─── */
export function BarChartSVG({ data, xKey, yKey, height = 300, color = '#3b82f6', barWidth = 20 }) {
  if (!data?.length) return null
  const w = 700
  const pad = { top: 20, right: 20, bottom: 40, left: 50 }
  const iw = w - pad.left - pad.right
  const ih = height - pad.top - pad.bottom
  const maxY = Math.max(...data.map(d => d[yKey]), 1) * 1.15
  const n = data.length
  const gap = iw / n

  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: '100%', height }}>
      {[0, 0.5, 1].map(t => (
        <line key={t} x1={pad.left} x2={pad.left + iw} y1={pad.top + ih - (t * maxY / maxY) * ih}
          y2={pad.top + ih - (t * maxY / maxY) * ih} stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
      ))}
      {data.map((d, i) => {
        const bw = Math.min(gap * 0.6, barWidth)
        const x = pad.left + i * gap + (gap - bw) / 2
        const h = (d[yKey] / maxY) * ih
        return (
          <g key={i}>
            <rect x={x} y={pad.top + ih - h} width={bw} height={Math.max(h, 1)} rx={3} fill={d.fill || color} />
            <text x={x + bw / 2} y={pad.top + ih + 14} textAnchor="middle" fill="#64748b" fontSize={9} transform={`rotate(45,${x + bw / 2},${pad.top + ih + 14})`}>
              {d[xKey]?.slice(0, 6) || ''}
            </text>
          </g>
        )
      })}
      <text x={pad.left - 8} y={pad.top + 4} textAnchor="end" fill="#64748b" fontSize={10}>{(maxY).toFixed(1)}</text>
      <text x={pad.left - 8} y={pad.top + ih + 4} textAnchor="end" fill="#64748b" fontSize={10}>0</text>
    </svg>
  )
}

/* ─── Radar Chart ─── */
export function RadarChartSVG({ data, height = 250, color = '#ef4444' }) {
  if (!data?.length) return null
  const cx = 150, cy = 130, r = 100
  const n = data.length
  const maxVal = Math.max(...data.map(d => Math.max(d.A || 0, d.B || 0, d.fullMark || 150)), 1)

  const angles = data.map((_, i) => (Math.PI * 2 * i) / n - Math.PI / 2)
  const point = (val, i) => {
    const a = angles[i]
    const dist = (val / maxVal) * r
    return `${cx + dist * Math.cos(a)},${cy + dist * Math.sin(a)}`
  }

  const gridLayers = [0.25, 0.5, 0.75, 1]
  const gridPoly = (t) => data.map((_, i) => point(t * maxVal, i)).join(' ')

  return (
    <svg viewBox={`0 0 ${cx * 2} ${cy * 2}`} style={{ width: '100%', height }}>
      {gridLayers.map(t => (
        <polygon key={t} points={gridPoly(t)} fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="2 2" />
      ))}
      {data.map((_, i) => {
        const a = angles[i]
        return (
          <line key={i} x1={cx} y1={cy} x2={cx + r * Math.cos(a)} y2={cy + r * Math.sin(a)}
            stroke="rgba(255,255,255,0.06)" />
        )
      })}
      {/* dataset B */}
      <polygon points={data.map((d, i) => point(d.B || 0, i)).join(' ')} fill={color} fillOpacity={0.5} stroke={color} strokeWidth={2} />
      {/* dataset A */}
      <polygon points={data.map((d, i) => point(d.A || 0, i)).join(' ')} fill="#3b82f6" fillOpacity={0.2} stroke="#3b82f6" strokeWidth={2} strokeDasharray="4 2" />
      {data.map((d, i) => (
        <text key={i} x={cx + (r + 18) * Math.cos(angles[i])} y={cy + (r + 6) * Math.sin(angles[i])}
          textAnchor="middle" fill="#94a3b8" fontSize={10}>{d.subject}</text>
      ))}
      {/* Legend */}
      <text x={cx - 20} y={cy * 2 - 10} fill={color} fontSize={10} fontWeight={700}>● الواقع</text>
      <text x={cx + 30} y={cy * 2 - 10} fill="#3b82f6" fontSize={10} fontWeight={700}>● الخطة</text>
    </svg>
  )
}

/* ─── Pie Chart ─── */
export function PieChartSVG({ data, height = 250, innerRadius = 0 }) {
  if (!data?.length) return null
  const cx = 150, cy = 130, r = 100
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total === 0) return null

  let startAngle = -Math.PI / 2
  const slices = data.map(d => {
    const angle = (d.value / total) * Math.PI * 2
    const sa = startAngle
    const ea = startAngle + angle
    startAngle = ea
    return { ...d, sa, ea }
  })

  const arc = (sa, ea, outerR = r, innerR2 = innerRadius) => {
    if (ea - sa >= Math.PI * 2 - 0.001) {
      const m1 = [cx + outerR * Math.cos(sa), cy + outerR * Math.sin(sa)]
      const m2 = [cx + outerR * Math.cos(ea), cy + outerR * Math.sin(ea)]
      return `M${m1[0]},${m1[1]} A${outerR},${outerR} 0 1 1 ${m2[0]},${m2[1]} A${outerR},${outerR} 0 1 0 ${m1[0]},${m1[1]}`
    }
    if (innerR2 > 0) {
      const x1 = cx + outerR * Math.cos(sa), y1 = cy + outerR * Math.sin(sa)
      const x2 = cx + outerR * Math.cos(ea), y2 = cy + outerR * Math.sin(ea)
      const ix1 = cx + innerR2 * Math.cos(sa), iy1 = cy + innerR2 * Math.sin(sa)
      const ix2 = cx + innerR2 * Math.cos(ea), iy2 = cy + innerR2 * Math.sin(ea)
      const large = ea - sa > Math.PI ? 1 : 0
      return `M${x1},${y1} A${outerR},${outerR} 0 ${large} 1 ${x2},${y2} L${ix2},${iy2} A${innerR2},${innerR2} 0 ${large} 0 ${ix1},${iy1} Z`
    }
    const x1 = cx + outerR * Math.cos(sa), y1 = cy + outerR * Math.sin(sa)
    const x2 = cx + outerR * Math.cos(ea), y2 = cy + outerR * Math.sin(ea)
    const large = ea - sa > Math.PI ? 1 : 0
    return `M${cx},${cy} L${x1},${y1} A${outerR},${outerR} 0 ${large} 1 ${x2},${y2} Z`
  }

  return (
    <svg viewBox={`0 0 ${cx * 2} ${cy * 2}`} style={{ width: '100%', height }}>
      {slices.map((d, i) => (
        <path key={i} d={arc(d.sa, d.ea)} fill={d.color || '#3b82f6'} stroke="#0f172a" strokeWidth={2} />
      ))}
      {/* Legend */}
      {data.map((d, i) => (
        <g key={i} transform={`translate(10, ${cy * 2 - 20 - (data.length - 1 - i) * 18})`}>
          <rect width={10} height={10} fill={d.color || '#3b82f6'} rx={2} />
          <text x={16} y={10} fill="#94a3b8" fontSize={10}>{d.name}: {d.value}</text>
        </g>
      ))}
    </svg>
  )
}
