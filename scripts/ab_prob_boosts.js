/**
 * scripts/ab_prob_boosts.js
 *
 * Harnais de mesure A/B pour l'audit "sur-confiance bracket 70-80% ≈ 41% (75)".
 *
 * Compare deux exécutions de la pipeline Node (enrichOne / QuantumQuantEngine)
 * sur les MÊMES matchs terminés :
 *   - boosts ON  : process.env.PROB_BOOSTS = 'on'  (comportement actuel)
 *   - boosts OFF : process.env.PROB_BOOSTS = 'off' (PWR/GNN/DEX/league/bsd gatés)
 *
 * Puis lit accuracyEngine.summary.byConfidenceBracket['70-80'] et l'accuracy
 * globale, pour quantifier l'impact des boosts sur le bracket de confiance élevé.
 *
 * Mode DB réelle : AB_DB_PATH=<chemin.sqlite> (table `matches` attendue).
 *   ⚠️ Ne pas pointer sur la DB live (tactical.db) : enrichOne peut écrire.
 *   Lancer sur une COPIE (staging) en lecture seule.
 * Mode démo     : node scripts/ab_prob_boosts.js --selftest (mock déterministe,
 *                 aucune dépendance DB/odds ; chiffres illustratifs, pas réels).
 *
 * Aucun recalcul de modèle : lecture seule côté analyse.
 */
const Database = require('better-sqlite3')
const { computeAccuracy } = require('../services/accuracyEngine')
const { enrichOne } = require('../core/enrichOne')

const SELFTEST = process.argv.includes('--selftest')
const DB_PATH = process.env.AB_DB_PATH

// --- Mock quant engine déterministe (selftest uniquement) -------------------
// Simule l'effet "boosts" : sans boost confiance basse + pas de lift du favori ;
// avec boost le favori (cote la plus basse) est lifté de 18% et la confiance
// poussée à 78 (bracket 70-80). Permet de démontrer le harnais sans DB/odds.
function makeMockQuant(boostsOn) {
  return {
    analyze(m) {
      const oH = Number(m.odds_home) || 2
      const oD = Number(m.odds_draw) || 3
      const oA = Number(m.odds_away) || 2
      const ih = 1 / oH
      const id = 1 / oD
      const ia = 1 / oA
      const s = ih + id + ia
      let p1 = ih / s
      let px = id / s
      let p2 = ia / s
      let confidence = 58 // bracket 50-60 par défaut
      if (boostsOn) {
        if (p1 >= p2) p1 = Math.min(0.9, p1 * 1.18)
        else p2 = Math.min(0.9, p2 * 1.18)
        const s2 = p1 + px + p2
        p1 /= s2
        px /= s2
        p2 /= s2
        confidence = 78 // force bracket 70-80
      }
      const mk = (prob) => ({ prob, odds: null, ev: 0, edge: 0, isValue: false })
      return {
        markets: { match_result: { '1': mk(p1), X: mk(px), '2': mk(p2) } },
        main_pick: p1 >= p2 ? '1' : '2',
        risk_label: 'BALANCED',
        confidence,
        expected_score: [1, 1],
        ev_score: '0.5',
        probs: { h: p1, d: px, a: p2, btts: 0.5, over25: 0.5 },
      }
    },
  }
}

// --- Prédiction unique, avec ou sans boosts ---------------------------------
async function predict(m, boostsOn) {
  if (SELFTEST) {
    // Le mock ignore l'env ; le flag boostsOn pilote le lift/confidence.
    process.env.PROB_BOOSTS = 'on'
    return enrichOne(m, { quantEngine: makeMockQuant(boostsOn) })
  }
  process.env.PROB_BOOSTS = boostsOn ? 'on' : 'off'
  return enrichOne(m)
}

// --- Construction d'une DB in-memory à partir des prédictions ---------------
function buildDb(rows) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE matches (
      id TEXT, homeTeam TEXT, awayTeam TEXT, league TEXT,
      scoreHome INTEGER, scoreAway INTEGER, status TEXT,
      prediction TEXT, confidence REAL,
      home_win_probability REAL, draw_probability REAL, away_win_probability REAL,
      odds_home REAL, odds_draw REAL, odds_away REAL,
      startTimestamp INTEGER, timestamp TEXT, insufficient_data INTEGER
    )`)
  const ins = db.prepare(
    `INSERT INTO matches (id, homeTeam, awayTeam, league, scoreHome, scoreAway,
      status, prediction, confidence, home_win_probability, draw_probability,
      away_win_probability, odds_home, odds_draw, odds_away, startTimestamp,
      timestamp, insufficient_data) VALUES (@id,@homeTeam,@awayTeam,@league,
      @scoreHome,@scoreAway,@status,@prediction,@confidence,@home_win_probability,
      @draw_probability,@away_win_probability,@odds_home,@odds_draw,@odds_away,
      @startTimestamp,@timestamp,@insufficient_data)`
  )
  const tx = db.transaction(() => {
    for (const r of rows) ins.run(r)
  })
  tx()
  return db
}

// --- Récupération des matchs source -----------------------------------------
function loadMatches() {
  if (SELFTEST) {
    // Fixture : 10 matchs. odds => favori = cote la plus basse.
    // Résultats réels : 6 victoires favori, 4 upsets (underdog gagne).
    const base = [
      { oH: 1.8, oD: 3.4, oA: 4.2, sh: 2, sa: 1 }, // fav gagne
      { oH: 2.1, oD: 3.2, oA: 3.0, sh: 0, sa: 1 }, // underdog (oA) gagne
      { oH: 1.6, oD: 3.6, oA: 5.5, sh: 3, sa: 0 }, // fav gagne
      { oH: 2.4, oD: 3.1, oA: 2.7, sh: 1, sa: 2 }, // underdog (oA) gagne
      { oH: 1.9, oD: 3.3, oA: 3.8, sh: 1, sa: 0 }, // fav gagne
      { oH: 2.0, oD: 3.3, oA: 3.4, sh: 0, sa: 2 }, // underdog (oA) gagne
      { oH: 1.7, oD: 3.5, oA: 4.8, sh: 2, sa: 1 }, // fav gagne
      { oH: 2.2, oD: 3.2, oA: 2.9, sh: 0, sa: 1 }, // underdog (oA) gagne
      { oH: 1.75, oD: 3.4, oA: 4.5, sh: 1, sa: 0 }, // fav gagne
      { oH: 1.95, oD: 3.3, oA: 3.7, sh: 2, sa: 1 }, // fav gagne
    ]
    return base.map((b, i) => ({
      id: 'st' + i,
      homeTeam: 'H' + i,
      awayTeam: 'A' + i,
      league: 'E0',
      scoreHome: b.sh,
      scoreAway: b.sa,
      status: 'FT',
      odds_home: b.oH,
      odds_draw: b.oD,
      odds_away: b.oA,
      startTimestamp: 1700000000 + i * 86400,
      timestamp: new Date(1700000000 + i * 86400).toISOString(),
      insufficient_data: 0,
    }))
  }
  if (!DB_PATH) throw new Error('AB_DB_PATH requis en mode DB réelle (sinon --selftest)')
  const src = new Database(DB_PATH, { readonly: true })
  const rows = src
    .prepare(
      `SELECT id, homeTeam, awayTeam, league, scoreHome, scoreAway, status,
              odds_home, odds_draw, odds_away, startTimestamp, timestamp,
              insufficient_data FROM matches WHERE status = 'FT'`
    )
    .all()
  src.close()
  return rows
}

// --- Orchestration ----------------------------------------------------------
async function run() {
  const matches = loadMatches()
  const rowsOn = []
  const rowsOff = []
  for (const m of matches) {
    const outOn = await predict(m, true)
    const outOff = await predict(m, false)
    const common = {
      id: m.id,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      league: m.league,
      scoreHome: m.scoreHome,
      scoreAway: m.scoreAway,
      status: m.status,
      odds_home: m.odds_home,
      odds_draw: m.odds_draw,
      odds_away: m.odds_away,
      startTimestamp: m.startTimestamp,
      timestamp: m.timestamp,
      insufficient_data: m.insufficient_data || 0,
    }
    rowsOn.push({
      ...common,
      prediction: outOn.prediction,
      confidence: outOn.confidence,
      home_win_probability: outOn.home_win_probability,
      draw_probability: outOn.draw_probability,
      away_win_probability: outOn.away_win_probability,
    })
    rowsOff.push({
      ...common,
      prediction: outOff.prediction,
      confidence: outOff.confidence,
      home_win_probability: outOff.home_win_probability,
      draw_probability: outOff.draw_probability,
      away_win_probability: outOff.away_win_probability,
    })
  }

  const sumOn = computeAccuracy({ db: buildDb(rowsOn) }).summary
  const sumOff = computeAccuracy({ db: buildDb(rowsOff) }).summary

  const bk = (s) => s.byConfidenceBracket['70-80'] || { count: 0, correct: 0, accuracy: null }
  const line = (label, s) => {
    const b = bk(s)
    const acc = s.accuracy === null ? 'n/a' : (s.accuracy * 100).toFixed(1) + '%'
    const bacc = b.accuracy === null ? 'n/a' : (b.accuracy * 100).toFixed(1) + '%'
    return `${label.padEnd(8)} | globale ${acc.padStart(7)} (n=${String(s.evaluated).padStart(3)}) | bracket 70-80: ${bacc.padStart(7)} (n=${String(b.count).padStart(3)})`
  }

  console.log('=== A/B PROB_BOOSTS : on vs off (même matchs, Node enrichOne) ===')
  console.log(line('ON', sumOn))
  console.log(line('OFF', sumOff))
  console.log('--- bracket 70-80 détail ---')
  console.log('ON :', JSON.stringify(sumOn.byConfidenceBracket['70-80'] || null))
  console.log('OFF:', JSON.stringify(sumOff.byConfidenceBracket['70-80'] || null))
  if (SELFTEST) {
    console.log('(selftest : chiffres illustratifs via mock ; lancer avec AB_DB_PATH sur une COPIE pour les réels)')
  }
}

run().catch((e) => {
  console.error('AB_PROB_BOOSTS error:', e && e.message ? e.message : e)
  process.exit(1)
})
