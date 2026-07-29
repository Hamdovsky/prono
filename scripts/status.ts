// @ts-nocheck
import fs from 'fs'
import path from 'path'

const profile = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'crowd_profile.json'), 'utf-8')
)
const voteHistory = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'tunisian_vote_history.json'), 'utf-8')
)

const grids = [...new Set(voteHistory.map((m) => m.grid))].sort()
const byResult = {}
voteHistory.forEach((m) => {
  const picks = [
    { label: '1', pct: m.vote1 },
    { label: 'X', pct: m.voteX },
    { label: '2', pct: m.vote2 },
  ]
  picks.sort((a, b) => b.pct - a.pct)
  const fav = picks[0].label
  const correct = fav === m.result
  const bin = Math.floor(picks[0].pct / 10) * 10
  const key = `${bin}-${bin + 9}%`
  if (!byResult[key]) byResult[key] = { right: 0, total: 0 }
  byResult[key].total++
  if (correct) byResult[key].right++
})

console.log(`
╔══════════════════════════════════════════════╗
║    FOLE PROMOSPORT TUNISIENNE — ANALYSE     ║
║    ${String(voteHistory.length).padStart(4)} MATCHS — ${grids.length} GRILLES         ║
╚══════════════════════════════════════════════╝
`)
console.log(
  `Global:  ${profile.tunisianCrowd.crowdRight}/${profile.tunisianCrowd.totalMatches} = ${profile.tunisianCrowd.crowdAccuracy}%`
)
console.log(`
  Confiance    Correct/Total   Précision   Action
  ─────────────────────────────────────────────────`)
const bins = Object.entries(byResult).sort((a, b) => a[0].localeCompare(b[0]))
bins.forEach(([key, d]) => {
  const acc = ((d.right / d.total) * 100).toFixed(1)
  const action = acc > 50 ? '✅ SUIVRE' : '⚠️ CONTRARIAN'
  console.log(
    `  ${key.padEnd(12)} ${String(d.right).padStart(2)}/${String(d.total).padStart(3)}${' '.repeat(10 - String(d.total).length)} ${acc}%${' '.repeat(9)}${action}`
  )
})

// Key insight
const weak = bins
  .filter(([k]) => parseInt(k) < 70)
  .reduce((s, [, d]) => ({ r: s.r + d.right, t: s.t + d.total }), { r: 0, t: 0 })
const strong = bins
  .filter(([k]) => parseInt(k) >= 70)
  .reduce((s, [, d]) => ({ r: s.r + d.right, t: s.t + d.total }), { r: 0, t: 0 })

console.log(`
═══════════════════════════════════════════════
INSIGHT CLÉ
═══════════════════════════════════════════════
  Quand la foule a <70% (${weak.t} matchs):
    → ${((weak.r / weak.t) * 100).toFixed(1)}% correct
    → STRATÉGIE : PRENDRE L'OPPOSÉ DU FAVORI

  Quand la foule a ≥70% (${strong.t} matchs):
    → ${((strong.r / strong.t) * 100).toFixed(1)}% correct
    → STRATÉGIE : SUIVRE LA FOULE (prudence)
`)
