/**
 * backfill_ht_footballdata.js — Phase 1 (docs/chantier_ht_under.md)
 * Peuple matches.ht_score_home/away + historical_matches.ht_score_home/away via
 * les CSV gratuits football-data.co.uk (HTHG/HTAG), SANS Sofascore (403 local).
 *
 * GARDE DE SECURITE : une ecriture n'est proposee que si
 *   date(ISO) + home normalise + away normalise correspondent  ET
 *   FTHG/FTAG du CSV == scoreHome/scoreAway en base  (meme match presque sur).
 * N'ecri JAMAIS si le score final diverge (protection contre un faux HT).
 * Idempotent : ne touche que les lignes ou ht_score_home est NULL.
 *
 * Usage :  node scripts/backfill_ht_footballdata.js          (DRY-RUN, default)
 *          node scripts/backfill_ht_footballdata.js --write   (applique)
 */
const REPO = require('path').join(__dirname, '..')
const Database = require('better-sqlite3')
const WRITE = process.argv.includes('--write')

const SEASONS = ['2627', '2526', '2425', '2324', '2223', '2122']
const DIVS = ['E0', 'E1', 'E2', 'SP1', 'SP2', 'I1', 'I2', 'D1', 'D2', 'F1', 'F2', 'N1', 'B1', 'B2', 'G1', 'G2', 'T1', 'T2', 'P1', 'P2', 'SC0', 'SC1', 'I1']
const STOP = new Set(['fc', 'cf', 'sc', 'ac', 'afc', 'cfc', 'sk', 'fk', 'bk', 'if', 'aifc', 'sv', 'tsv', 'fsv', 'us', 'as', 'ss', 'ssc', 'rc', 'cd', 'ca', 'cp', 'ud', 'de', 'bc', 'cska', '1', '07', '1899', '1900', '1907', '1909', 'club', 'deportivo'])

function normTeam(name) {
  let s = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\./g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
  s = s.replace(/\bman utd\b/g, 'manchester united').replace(/\bm united\b/g, 'manchester united')
    .replace(/\buld\b/g, 'oldham').replace(/\bnott s?\b|\bnotts\b/g, 'notts county')
    .replace(/\binternazionale\b/g, 'inter').replace(/\bwolves\b/g, 'wolverhampton')
    .replace(/\bcity\b/g, '').replace(/\btown\b/g, '').replace(/\byouth\b/g, '')
  return s.split(/\s+/).filter((t) => t && !STOP.has(t)).join(' ').trim()
}
function normDate(v) {
  const s = String(v || '').trim()
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) { let [, d, mo, y] = m; y = y.length === 4 ? y : '20' + y
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}
function splitCsv(line) { // gère guillemets simples du CSV FD
  const out = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) { const c = line[i]
    if (c === '"') { q = !q } else if (c === ',' && !q) { out.push(cur); cur = '' } else cur += c }
  out.push(cur); return out
}

async function fetchMap() {
  const map = new Map()
  for (const season of SEASONS) {
    for (const div of DIVS) {
      const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`
      let txt
      try { const r = await fetch(url); if (!r.ok) continue; txt = await r.text() } catch { continue }
      const lines = txt.replace(/^\uFEFF/, '').split(/\r?\n/)
      const hdr = splitCsv(lines[0] || '')
      const ix = (n) => hdr.indexOf(n)
      const iD = ix('Date'), iH = ix('HomeTeam'), iA = ix('AwayTeam'), iFH = ix('FTHG'), iFA = ix('FTAG'), iHTH = ix('HTHG'), iHTA = ix('HTAG')
      if (iD < 0 || iH < 0 || iA < 0 || iHTH < 0) continue
      for (let i = 1; i < lines.length; i++) {
        const c = splitCsv(lines[i]); if (c.length < hdr.length - 2) continue
        const date = normDate(c[iD]); const ht = normTeam(c[iH]); const at = normTeam(c[iA])
        const fh = parseInt(c[iFH], 10); const fa = parseInt(c[iFA], 10)
        const hth = parseInt(c[iHTH], 10); const hta = parseInt(c[iHTA], 10)
        if (!date || !ht || !at || isNaN(fh) || isNaN(fa)) continue
        if (isNaN(hth) || isNaN(hta)) continue
        map.set(`${date}|${ht}|${at}`, { hth, hta, fh, fa })
      }
      await new Promise((r) => setTimeout(r, 90))
    }
  }
  return map
}

;(async () => {
  const db = new Database(REPO + '/data/tactical.db', WRITE ? {} : { readonly: true })
  const map = await fetchMap()
  console.log(`[FD] map: ${map.size} resultats avec HT charges (${SEASONS.length} saisons x ${DIVS.length} divisions)`)

  let cand = 0, matched = 0, safe = 0, conflict = 0, wrote = 0
  const pending = [] // {table,id,hth,hta}
  const updM = db.prepare('UPDATE matches SET ht_score_home=?, ht_score_away=? WHERE id=?')
  const updH = db.prepare('UPDATE historical_matches SET ht_score_home=?, ht_score_away=? WHERE id=?')

  function tryRow(table, id, tsOrDate, home, away, sh, sa, curHt) {
    if (curHt != null) return // deja peuple
    sh = sh == null ? null : parseInt(sh, 10); sa = sa == null ? null : parseInt(sa, 10)
    if (sh == null || sa == null) return
    const date = normDate(tsOrDate); const k = date ? `${date}|${normTeam(home)}|${normTeam(away)}` : null
    cand++
    const hit = k && map.get(k); if (!hit) return
    matched++
    if (hit.fh !== sh || hit.fa !== sa) { conflict++; return } // FT divergent -> SKIP (garde)
    safe++
    if (safe <= 40) console.log(`  ${table} ${id}  ${date}  ${home} ${sh}-${sa} ${away}  -> HT ${hit.hth}-${hit.hta}`.slice(0, 110))
    pending.push({ table, id, hth: hit.hth, hta: hit.hta })
  }

  for (const r of db.prepare(`SELECT id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, ht_score_home FROM matches WHERE status='finished'`).all())
    tryRow('matches', r.id, r.timestamp, r.homeTeam, r.awayTeam, r.scoreHome, r.scoreAway, r.ht_score_home)
  for (const r of db.prepare(`SELECT id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, ht_score_home FROM historical_matches WHERE scoreHome IS NOT NULL AND ht_score_home IS NULL`).all())
    tryRow('historical', r.id, r.timestamp, r.homeTeam, r.awayTeam, r.scoreHome, r.scoreAway, r.ht_score_home)

  if (WRITE) {
    const apply = db.transaction((rows) => {
      for (const p of rows) { (p.table === 'matches' ? updM : updH).run(p.hth, p.hta, p.id); wrote++ }
    })
    apply(pending)
  }

  console.log(`\n[RESULT] ${WRITE ? 'WRITE' : 'DRY-RUN'} : candidats=${cand}  joints=${matched}  FT-coherents=${safe}  conflits(skip)=${conflict}  ${WRITE ? 'ECRITS=' + wrote : '(dry-run, rien ecrit)'}`)
  db.close()
})().catch((e) => { console.error('ERR', e); process.exit(1) })
