/**
 * ou_line_movement.js — E31+ Chantier rentabilite, test d'EDGE par mouvement de ligne
 * Over/Under 2.5. Football-data fournit pour CHAQUE match : cote O/U a l'OUVERTURE
 * ('Avg>2.5' / 'B365>2.5') et a la CLOTURE ('AvgC>2.5' / 'B365C>2.5'), plus le score
 * reel (FTHG/FTAG). Question : le mouvement ouverture->cloture porte-t-il une info
 * EXPLOITABLE (alpha au-dela de la cloture, qui est deja la proba la plus juste) ?
 *
 * Lecture seule (aucune ecriture base). Sortie : Brier/logloss implicite-ouverture vs
 * implicite-cloture vs constante, et taux de reussite du signal "parier le sens du
 * mouvement" a differents seuils.
 *
 * Usage : node scripts/ou_line_movement.js [--book=avg|b365]
 */
const axios = require('axios')
const BOOK = (process.argv.find((a) => a.startsWith('--book=')) || '--book=avg').split('=')[1]
const OPEN = BOOK === 'b365' ? ['B365>2.5', 'B365<2.5'] : ['Avg>2.5', 'Avg<2.5']
const CLOSE = BOOK === 'b365' ? ['B365C>2.5', 'B365C<2.5'] : ['AvgC>2.5', 'AvgC<2.5']
const SEASONS = ['2425', '2324', '2223', '2122']
const DIVS = ['E0', 'E1', 'SP1', 'SP2', 'I1', 'I2', 'D1', 'D2', 'F1', 'F2', 'N1', 'B1', 'G1', 'T1', 'P1', 'SC0']

function splitCsv(line) { const o = []; let c = ''; let q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = '' } else c += ch } o.push(c); return o }
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 1 ? n : null }
const impliedOver = (o, u) => { const io = 1 / o, iu = 1 / u; return io / (io + iu) } // de-vig 2-issues
const brier = (pairs) => pairs.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / pairs.length
const logloss = (pairs) => { const e = 1e-6; return -pairs.reduce((s, [p, y]) => s + (y * Math.log(Math.max(e, p)) + (1 - y) * Math.log(Math.max(e, 1 - p))), 0) / pairs.length }

async function run() {
  const rows = []
  for (const season of SEASONS) {
    for (const div of DIVS) {
      let txt
      try { const r = await axios.get(`https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`, { timeout: 20000 }); txt = r.data } catch { continue }
      const lines = String(txt).replace(/^\uFEFF/, '').split(/\r?\n/)
      const hdr = splitCsv(lines[0] || '')
      const ix = (n) => hdr.indexOf(n)
      const iFH = ix('FTHG'), iFA = ix('FTAG'), ioO = ix(OPEN[0]), ioU = ix(OPEN[1]), icO = ix(CLOSE[0]), icU = ix(CLOSE[1])
      if (iFH < 0 || ioO < 0 || icO < 0) continue
      for (let i = 1; i < lines.length; i++) {
        const c = splitCsv(lines[i])
        const fh = Number(c[iFH]), fa = Number(c[iFA])
        const oo = num(c[ioO]), ou = num(c[ioU]), co = num(c[icO]), cu = num(c[icU])
        if (!Number.isFinite(fh) || !Number.isFinite(fa) || !oo || !ou || !co || !cu) continue
        rows.push({ y: (fh + fa) > 2.5 ? 1 : 0, pOpen: impliedOver(oo, ou), pClose: impliedOver(co, cu), co, cu })
      }
      await new Promise((r) => setTimeout(r, 70))
    }
  }
  if (rows.length < 50) { console.log('pas assez de lignes avec ouverture ET cloture O/U:', rows.length); return }
  const base = rows.reduce((s, r) => s + r.y, 0) / rows.length
  const pairsOpen = rows.map((r) => [r.pOpen, r.y])
  const pairsClose = rows.map((r) => [r.pClose, r.y])
  console.log(`[${BOOK}] n=${rows.length}  taux reel Over2.5=${(base * 100).toFixed(1)}%`)
  console.log(`  constante      Brier=${(base * (1 - base) + (1 - base) * base).toFixed(4)} (2p(1-p))  ~Brier-base=${(base * (1 - base)).toFixed(4)}`)
  console.log(`  implicite OUVERTURE  Brier=${brier(pairsOpen).toFixed(4)}  logloss=${logloss(pairsOpen).toFixed(4)}`)
  console.log(`  implicite CLOTURE    Brier=${brier(pairsClose).toFixed(4)}  logloss=${logloss(pairsClose).toFixed(4)}  <- la plus juste`)
  // taux de reussite du signal "parier le sens du mouvement" (drift de proba over)
  console.log('\n  Signal "bet dans le sens du mouvement ouverture->cloture":')
  for (const thr of [0.01, 0.02, 0.03, 0.05]) {
    const sub = rows.filter((r) => Math.abs(r.pClose - r.pOpen) >= thr)
    if (sub.length < 30) { console.log(`    |drift|>=${(thr * 100).toFixed(0)}pp : n<30`); continue }
    const hit = sub.filter((r) => { const side = r.pClose > r.pOpen ? 1 : 0; return side === r.y }).length
    console.log(`    |drift|>=${(thr * 100).toFixed(0)}pp  n=${sub.length}  reussite=${((hit / sub.length) * 100).toFixed(1)}%`)
  }
  // test d'ALPHA residuel : apres la cloture, le mouvement predit-il encore ? (moy y | mouvement vers over)
  const toward = rows.filter((r) => r.pClose - r.pOpen >= 0.02)
  const away = rows.filter((r) => r.pOpen - r.pClose >= 0.02)
  const rate = (a) => (a.length ? (a.reduce((s, r) => s + r.y, 0) / a.length * 100).toFixed(1) : '-') + '%'
  console.log(`\n  P(actual=Over | marche a bouge VERS over>=2pp) = ${rate(toward)} (n=${toward.length})`)
  console.log(`  P(actual=Over | marche a bouge VERS under>=2pp) = ${rate(away)} (n=${away.length})`)
  console.log(`  (attendu ~58% si le mouvement n'ajoute RIEN a la cloture deja juste)`)
  // TEST DECISIF : parier le mouvement en obtenant la cote de CLOTURE (realiste).
  console.log('\n  EV si "bet le mouvement" a la COTE DE CLOTURE (le prix deja deplace) :')
  for (const thr of [0.02, 0.03, 0.05]) {
    const sub = rows.filter((r) => Math.abs(r.pClose - r.pOpen) >= thr)
    if (sub.length < 30) continue
    let profit = 0
    for (const r of sub) { const betOver = r.pClose > r.pOpen; const odds = betOver ? r.co : r.cu; const won = betOver ? r.y === 1 : r.y === 0; profit += won ? odds - 1 : -1 }
    console.log(`    |drift|>=${(thr * 100).toFixed(0)}pp  n=${sub.length}  ROI=${(profit / sub.length * 100).toFixed(1)}%`)
  }
}
run().catch((e) => { console.error('ERR', e); process.exit(1) })
