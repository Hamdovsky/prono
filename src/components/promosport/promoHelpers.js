// Helpers purs du module Promosport (extraits de Promosport.jsx, split 2026-09-07).

// Verdict GAGNANT cohérent avec matchAnalysis.js (1/X/2 si >= 65%, sinon double-chance).
export const computeGagnant = (m) => {
  const h = m?.mlProbs?.h ?? m?.probs?.h ?? 0
  const x = m?.mlProbs?.x ?? m?.mlProbs?.n ?? m?.probs?.n ?? 0
  const a = m?.mlProbs?.a ?? m?.probs?.a ?? 0
  if (!(h + x + a > 0)) return { pick: '--', prob: 0 }
  const maxP = Math.max(h, x, a)
  if (maxP >= 65) {
    const pick = maxP === h ? '1' : maxP === a ? '2' : 'X'
    return { pick, prob: maxP }
  }
  const combos = [
    { k: '1X', p: h + x },
    { k: '12', p: h + a },
    { k: 'X2', p: x + a },
  ].sort((a, b) => b.p - a.p)
  return { pick: combos[0].k, prob: Math.round(combos[0].p) }
}

export const SOURCE_LABELS = {
  ml: 'ML',
  archive: 'ARCH',
  xg: 'xG',
  stat: 'STAT',
}

export const coverageSummary = (matches) => {
  const s = { db: 0, odds: 0, arch: 0, alias: 0, total: matches.length }
  for (const m of matches) {
    const c = m?.coverage || {}
    if (c.dbMatch) s.db++
    if (c.realOdds) s.odds++
    if (c.archStats) s.arch++
    if (c.aliasHome && c.aliasAway) s.alias++
  }
  return s
}
