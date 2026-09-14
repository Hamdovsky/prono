/**
 * backfill_odds_footballdata.js — E29 Rentabilite, Etape 1.3
 * Peuple les COTES 1X2 de cloture (B365 -> Avg -> Pinnacle) sur les matchs ou elles
 * manquent, via les CSV gratuits football-data.co.uk (sans cle, non-bloques).
 * Sans ces cotes, le ROI par marche est immeasurable (~251 paris seulement ont
 * proba+cote+resultat). Objectif : ramener l'echantillon ROI-a-des milliers.
 *
 * GARDE ANTI-FAUX : une cote n'est proposee que si
 *   joinKey(date, equipes normalisees) existe  ET  FTHG/FTAG(CSV) == scoreHome/scoreAway(base).
 * N'ecrase jamais une cote deja presente. Dry-run par defaut. Idempotent.
 *
 * Usage : node scripts/backfill_odds_footballdata.js [--write] [--seasons=2627,2526,2425,2324,2223,2122]
 */
const path = require('path')
const REPO = path.join(__dirname, '..')
const Database = require('better-sqlite3')
const axios = require('axios')
const { normDate, joinKey, ftCoherent, pickClosingOdds } = require(REPO + '/core/fdJoin')

const WRITE = process.argv.includes('--write')
const seasonsArg = (process.argv.find((a) => a.startsWith('--seasons=')) || '').split('=')[1]
const SEASONS = (seasonsArg || '2627,2526,2425,2324,2223,2122').split(',')
const DIVS = ['E0', 'E1', 'E2', 'SP1', 'SP2', 'I1', 'I2', 'D1', 'D2', 'F1', 'F2', 'N1', 'B1', 'B2', 'G1', 'G2', 'T1', 'T2', 'P1', 'P2', 'SC0', 'SC1']

function splitCsv(line) {
  const out = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) { const c = line[i]
    if (c === '"') q = !q
    else if (c === ',' && !q) { out.push(cur); cur = '' }
    else cur += c }
  out.push(cur); return out
}

async function buildOddsMap() {
  const map = new Map()
  for (const season of SEASONS) {
    for (const div of DIVS) {
      const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`
      let txt
      try { const r = await axios.get(url, { timeout: 20000 }); if (r.status !== 200) continue; txt = r.data } catch { continue }
      const lines = String(txt).replace(/^\uFEFF/, '').split(/\r?\n/)
      const hdr = splitCsv(lines[0] || '')
      const ix = (n) => hdr.indexOf(n)
      const iD = ix('Date'), iH = ix('HomeTeam'), iA = ix('AwayTeam'), iFH = ix('FTHG'), iFA = ix('FTAG')
      if (iD < 0 || iH < 0 || iA < 0 || iFH < 0) continue
      for (let i = 1; i < lines.length; i++) {
        const c = splitCsv(lines[i]); if (c.length < 6) continue
        const date = normDate(c[iD]); if (!date) continue
        const o = {}
        hdr.forEach((h, j) => { o[h] = c[j] })
        const odds = pickClosingOdds(o)
        if (!odds) continue
        map.set(joinKey(date, c[iH], c[iA]), { fh: c[iFH], fa: c[iFA], ...odds })
      }
      await new Promise((r) => setTimeout(r, 80))
    }
  }
  return map
}

;(async () => {
  const db = new Database(REPO + '/data/tactical.db', WRITE ? {} : { readonly: true })
  const map = await buildOddsMap()
  console.log(`[FD] carte cotes 1X2 cloture : ${map.size} resultats charges (${SEASONS.length} saisons x ${DIVS.length} divisions)`)

  let cand = 0, matched = 0, noOdds = 0, wrote = 0
  const updM = db.prepare(`UPDATE matches SET odds_home=?, odds_draw=?, odds_away=?, odds_source=? WHERE id=?`)
  const selH = db.prepare(`SELECT id, fullData FROM historical_matches WHERE id=?`)
  const updH = db.prepare(`UPDATE historical_matches SET fullData=? WHERE id=?`)
  const pending = []

  function consider(table, id, dateISO, home, away, sh, sa, curOddsHome) {
    if (curOddsHome != null) return // deja une cote
    sh = Number(sh); sa = Number(sa)
    if (!Number.isFinite(sh) || !Number.isFinite(sa)) return
    const k = dateISO ? joinKey(dateISO, home, away) : null
    cand++
    const hit = k && map.get(k); if (!hit) return
    matched++
    if (!ftCoherent(hit.fh, hit.fa, sh, sa)) { noOdds++; return } // FT divergent -> SKIP (garde)
    pending.push({ table, id, home: hit.home, draw: hit.draw, away: hit.away, source: hit.source })
  }

  for (const r of db.prepare(`SELECT id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, odds_home FROM matches WHERE status IN ('FT','finished','Finished','Ended')`).all())
    consider('matches', r.id, normDate(r.timestamp), r.homeTeam, r.awayTeam, r.scoreHome, r.scoreAway, r.odds_home)

  for (const r of db.prepare(`SELECT id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, fullData FROM historical_matches WHERE scoreHome IS NOT NULL`).all()) {
    let fd = {}; try { fd = JSON.parse(r.fullData || '{}') } catch {}
    consider('historical', r.id, normDate(r.timestamp), r.homeTeam, r.awayTeam, r.scoreHome, r.scoreAway, fd.odds_home)
  }

  if (WRITE && pending.length) {
    const apply = db.transaction((rs) => {
      for (const p of rs) {
        if (p.table === 'matches') { updM.run(p.home, p.draw, p.away, p.source, p.id); wrote++; continue }
        const row = selH.get(p.id); let fd = {}; try { fd = JSON.parse(row.fullData || '{}') } catch {}
        if (fd.odds_home != null) continue
        fd.odds_home = p.home; fd.odds_draw = p.draw; fd.odds_away = p.away; fd.odds_source = p.source
        updH.run(JSON.stringify(fd), p.id); wrote++
      }
    })
    apply(pending)
  }
  console.log(`\n[RESULT] ${WRITE ? 'WRITE' : 'DRY-RUN'} : candidats=${cand}  joins=${matched}  FT-incoherents(skip)=${noOdds}  ecrivables=${pending.length}  ${WRITE ? 'ECRITS=' + wrote : '(dry-run, rien ecrit)'}`)
  db.close()
})().catch((e) => { console.error('ERR', e); process.exit(1) })
