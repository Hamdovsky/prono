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
const { normDate, joinKey, ftCoherent, pickClosingOdds, pickClosingOU } = require(REPO + '/core/fdJoin')

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
        const ou = pickClosingOU(o)
        if (!odds && !ou) continue // ligne sans aucune cote exploitable
        map.set(joinKey(date, c[iH], c[iA]), {
          fh: c[iFH], fa: c[iFA],
          o1: odds, // {home,draw,away,source} | null
          ou, //     {over,under,source}      | null
        })
      }
      await new Promise((r) => setTimeout(r, 80))
    }
  }
  return map
}

;(async () => {
  const db = new Database(REPO + '/data/tactical.db', WRITE ? {} : { readonly: true })
  const map = await buildOddsMap()
  console.log(`[FD] carte cotes cloture (1X2 + O/U) : ${map.size} resultats charges (${SEASONS.length} saisons x ${DIVS.length} divisions)`)

  let cand = 0, matched = 0, conflict = 0, wrote1x2 = 0, wroteOU = 0
  const updM1 = db.prepare(`UPDATE matches SET odds_home=?, odds_draw=?, odds_away=?, odds_source=? WHERE id=?`)
  const updM2 = db.prepare(`UPDATE matches SET odds_over25=?, odds_under25=? WHERE id=?`)
  const selH = db.prepare(`SELECT fullData FROM historical_matches WHERE id=?`)
  const updH = db.prepare(`UPDATE historical_matches SET fullData=? WHERE id=?`)
  const pending = [] // {table,id,o1,ou}

  function consider(table, id, dateISO, home, away, sh, sa, cur1x2, curOU) {
    if (cur1x2 != null && curOU != null) return // deja complet
    sh = Number(sh); sa = Number(sa)
    if (!Number.isFinite(sh) || !Number.isFinite(sa)) return
    cand++
    const k = dateISO ? joinKey(dateISO, home, away) : null
    const hit = k && map.get(k); if (!hit) return
    if (!ftCoherent(hit.fh, hit.fa, sh, sa)) { conflict++; return } // FT divergent -> SKIP (garde)
    matched++
    const want1 = cur1x2 == null && hit.o1
    const wantOU = curOU == null && hit.ou
    if (want1 || wantOU) pending.push({ table, id, o1: want1 ? hit.o1 : null, ou: wantOU ? hit.ou : null })
  }

  for (const r of db.prepare(`SELECT id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, odds_home, odds_over25 FROM matches WHERE status IN ('FT','finished','Finished','Ended')`).all())
    consider('matches', r.id, normDate(r.timestamp), r.homeTeam, r.awayTeam, r.scoreHome, r.scoreAway, r.odds_home, r.odds_over25)

  for (const r of db.prepare(`SELECT id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, fullData FROM historical_matches WHERE scoreHome IS NOT NULL`).all()) {
    let fd = {}; try { fd = JSON.parse(r.fullData || '{}') } catch {}
    consider('historical', r.id, normDate(r.timestamp), r.homeTeam, r.awayTeam, r.scoreHome, r.scoreAway, fd.odds_home, fd.odds_over25)
  }

  if (WRITE && pending.length) {
    const apply = db.transaction((rs) => {
      for (const p of rs) {
        if (p.table === 'matches') {
          if (p.o1) { updM1.run(p.o1.home, p.o1.draw, p.o1.away, p.o1.source, p.id); wrote1x2++ }
          if (p.ou) { updM2.run(p.ou.over, p.ou.under, p.id); wroteOU++ }
          continue
        }
        const row = selH.get(p.id); let fd = {}; try { fd = JSON.parse(row.fullData || '{}') } catch {}
        if (p.o1 && fd.odds_home == null) { fd.odds_home = p.o1.home; fd.odds_draw = p.o1.draw; fd.odds_away = p.o1.away; fd.odds_source = p.o1.source; wrote1x2++ }
        if (p.ou && fd.odds_over25 == null) { fd.odds_over25 = p.ou.over; fd.odds_under25 = p.ou.under; fd.odds_ou_source = p.ou.source; wroteOU++ }
        updH.run(JSON.stringify(fd), p.id)
      }
    })
    apply(pending)
  }
  console.log(`\n[RESULT] ${WRITE ? 'WRITE' : 'DRY-RUN'} : candidats=${cand}  joints=${matched}  FT-incoherents(skip)=${conflict}  a ecrire=${pending.length}  ${WRITE ? '1X2=' + wrote1x2 + ' OU=' + wroteOU : '(dry-run, rien ecrit)'}`)
  db.close()
})().catch((e) => { console.error('ERR', e); process.exit(1) })
