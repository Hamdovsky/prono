/**
 * backfill_ht_livescore.js — Phase 2 (safe): peuple matches.ht_score_home/away
 * depuis le flux livescore PUBLIC (sans cle, non-bloque) via le champ Trh1/Trh2
 * (score 1re mi-temps). Nos ids sont `livescore_<Eid>` -> on joint sur Eid.
 *
 * GARDE : n'ecrit que si le score FINAL en base == Tr1/Tr2 du feed (meme match
 * presque sur) ET ht_score_home est NULL (idempotent). Dry-run par defaut.
 *
 * Usage : node scripts/backfill_ht_livescore.js [--write] [--days=20]
 */
const REPO = require('path').join(__dirname, '..')
const Database = require('better-sqlite3')
const axios = require('better-sqlite3') && require(REPO + '/node_modules/axios')
const WRITE = process.argv.includes('--write')
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=25').split('=')[1])

const BASE = 'https://prod-public-api.livescore.com/v1/api/app'
const H = { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Origin: 'https://www.livescore.com', Referer: 'https://www.livescore.com/' }, timeout: 12000 }

;(async () => {
  const db = new Database(REPO + '/data/tactical.db', WRITE ? {} : { readonly: true })
  // finished sans HT, dans matches ET historical (ids livescore_<Eid>)
  const rows = []
  for (const r of db.prepare(`SELECT id, timestamp, scoreHome, scoreAway FROM matches WHERE status='finished' AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL AND ht_score_home IS NULL AND id LIKE 'livescore_%'`).all()) rows.push({ ...r, table: 'matches' })
  for (const r of db.prepare(`SELECT id, timestamp, scoreHome, scoreAway FROM historical_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL AND ht_score_home IS NULL AND id LIKE 'livescore_%'`).all()) rows.push({ ...r, table: 'historical' })
  const byDate = new Map()
  for (const r of rows) { const d = String(r.timestamp || '').slice(0, 10); if (!d) continue; if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(r) }
  console.log(`[LS] ${rows.length} finished sans HT (matches+historical), sur ${byDate.size} dates`)

  let cand = 0, matched = 0, wrote = 0, noHt = 0
  const updM = db.prepare('UPDATE matches SET ht_score_home=?, ht_score_away=? WHERE id=?')
  const updH = db.prepare('UPDATE historical_matches SET ht_score_home=?, ht_score_away=? WHERE id=?')
  const pending = []
  const dates = [...byDate.keys()].sort().slice(-DAYS)
  for (const date of dates) {
    let feed
    try { feed = (await axios.get(`${BASE}/date/soccer/${date.replace(/-/g, '')}/0?MD=1&countryCode=US&locale=en`, H)).data } catch (e) { console.log(`  ${date}: feed fail ${e.response?.status || e.message}`); continue }
    const eidMap = new Map()
    for (const s of feed?.Stages || []) for (const e of s.Events || []) if (e.Eid != null) eidMap.set(String(e.Eid), e)
    for (const r of byDate.get(date)) {
      const eid = r.id.replace('livescore_', '')
      const e = eidMap.get(eid); if (!e) continue
      cand++
      if (Number(e.Tr1) !== Number(r.scoreHome) || Number(e.Tr2) !== Number(r.scoreAway)) continue // FT divergent -> SKIP
      matched++
      const h1 = e.Trh1, h2 = e.Trh2
      if (h1 == null || h2 == null || h1 === '' || h2 === '') { noHt++; continue }
      if (Number(h1) > Number(e.Tr1) || Number(h2) > Number(e.Tr2)) continue // incoherent
      pending.push({ table: r.table, id: r.id, h1: Number(h1), h2: Number(h2) })
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  if (WRITE && pending.length) {
    const apply = db.transaction((rs) => { for (const p of rs) { (p.table === 'matches' ? updM : updH).run(p.h1, p.h2, p.id); wrote++ } })
    apply(pending)
  }
  console.log(`\n[RESULT] ${WRITE ? 'WRITE' : 'DRY-RUN'} : candidats=${cand}  FT-coherents=${matched}  sans-Trh=${noHt}  ecrivables=${pending.length}  ${WRITE ? 'ECRITS=' + wrote : '(dry-run)'}`)
  db.close()
})().catch((e) => { console.error('ERR', e); process.exit(1) })
