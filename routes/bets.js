const express = require('express')
const router = express.Router()
const database = require('../core/database')
const logger = require('../core/logger')

// Journal de bankroll = données financières personnelles (audit 2026-09-10,
// É9) : localhost de confiance, sinon token admin OU JWT utilisateur valide.
const localOnlyOrAuth = require('../core/authGuards').localOrJwtOrAdmin
router.use(localOnlyOrAuth)

function pickWon(pick, sh, sa) {
  const p = (pick || '').toString().trim().toUpperCase()
  if (p === '1' || p === 'HOME') return sh > sa
  if (p === '2' || p === 'AWAY') return sa > sh
  if (p === 'X' || p === 'DRAW') return sh === sa
  if (p === '1X') return sh >= sa
  if (p === 'X2') return sa >= sh
  if (p === '12') return sh !== sa
  return false
}

// Résout la cote d'un pick à partir des données d'un match, ou 0 si elle est
// inconnue. Ne FABRIQUE pas de prix : les doubles chances 1X/X2/12 exigeaient
// les deux cotes simples réellement stockées, sinon on renvoie 0 et l'appelant
// (`/import`, ligne ~260) saute la ligne. Constantes h=2/a=2/d=3 retirées : elles
// donnaient 1.20 / 1.20 / 1.00, dont 1.00 est impossible sur un marché à marge
// (1/somme des probs implicites < 1). Même règle que _getPickOdds côté
// settlementService.js, pour que les deux chemins ne divergent plus.
function getOddsForPick(match, pick) {
  const p = (pick || '').toString().trim().toUpperCase()
  if (p === '1' || p === 'HOME')
    return parseFloat(match.odds_home || match.best_odds_home || match.display_odds_home || 0)
  if (p === '2' || p === 'AWAY')
    return parseFloat(match.odds_away || match.best_odds_away || match.display_odds_away || 0)
  if (p === 'X' || p === 'DRAW') return parseFloat(match.odds_draw || 0)
  if (p === '1X' || p === 'X2' || p === '12') {
    const h = parseFloat(match.odds_home || match.best_odds_home || match.display_odds_home || 0)
    const a = parseFloat(match.odds_away || match.best_odds_away || match.display_odds_away || 0)
    const d = parseFloat(match.odds_draw || 0)
    let need
    if (p === '1X') need = [h, d]
    else if (p === 'X2') need = [a, d]
    else need = [h, a]
    if (!need.every((x) => Number.isFinite(x) && x > 1)) return 0
    const prob = p === '1X' ? 1 / h + 1 / d : p === 'X2' ? 1 / a + 1 / d : 1 / h + 1 / a
    return prob > 0 ? 1 / prob : 0
  }
  return 0
}

// Détecte une cote FABRIQUÉE par les fallbacks de _getPickOdds (lignes 22-49)
// et de settlementService.js:562-564 / :598.
//
// Ce n'est pas une optimisation : ces fallbacks sont le défaut, et tant qu'ils
// existent, la table `bets` est majoritairement remplie de cotes imaginaires.
// Mesuré sur data/tactical.db : 11 994 lignes sur 13 156 (91,2%) portent une
// cote de repli, et le ROI affiché (+11,10%) vient presque entièrement de
// celles-là. Sur les seules lignes à cote réelle, le ROI est de -3,65%.
//
// Les valeurs de repli sont dérivées des constantes h=2, a=2, d=3 :
//   pick 12 -> 1/(1/2+1/2) = 1.00   (une vraie cote 1.00 est impossible)
//   pick 1X -> 1/(1/2+1/3) = 1.20
//   pick X2 -> 1/(1/2+1/3) = 1.20
//   sinon   -> || 2        = 2.00
// Si de vraies cotes avaient été stockées, le résultat serait un nombre non
// rond : la signature 1.00/1.20 est donc une détection fiable pour 1X/X2/12.
// Pour 2.00 la signature est ambiguë avec un vrai prix rond, mais le repli est
// la cause dominante et un prix exactement 2.00 resterait inexploitable pour un
// ROI fin. On le classe donc comme synthétique et c'est documenté ici.
function isSyntheticOdds(row) {
  const o = parseFloat(row.odds)
  if (!Number.isFinite(o)) return true
  return o === 1.0 || o === 1.2 || o === 2.0
}

// E76 : `odds_source` devient la source de vérité, la détection par valeur ne
// sert plus que de repli pour les lignes d'avant le backfill.
//   'reelle' / 'manuel' -> prix réellement payé, exploitable pour un ROI
//   'repli'             -> prix inventé par le code
//   'absente' / NULL    -> aucun prix
// Distinguer « pas de prix » de « prix inventé » compte : une ligne sans cote
// n'est pas une ligne qui a rapporté de l'argent, et l'agréger aux cotes
// fabriquées ferait croire à des pertes réelles.
function betOddsClass(row) {
  const src = (row.odds_source || '').toString().trim().toLowerCase()
  if (src) {
    if (src === 'reelle' || src === 'manuel') return 'exploitable'
    if (src === 'repli') return 'repli'
    return 'absente'
  }
  const o = parseFloat(row.odds)
  if (!Number.isFinite(o)) return 'absente'
  return isSyntheticOdds(row) ? 'repli' : 'exploitable'
}

function computeStats(rows) {
  const total = rows.length
  const won = rows.filter((r) => r.result === 'won').length
  const lost = rows.filter((r) => r.result === 'lost').length
  const pending = rows.filter((r) => r.result === 'pending').length
  const voided = rows.filter((r) => r.result === 'void').length
  const totalStaked = rows.reduce((s, r) => s + (r.stake || 0), 0)
  const totalReturned = rows.reduce(
    (s, r) => (r.result === 'won' ? s + (r.stake || 0) * (r.odds || 1) : s),
    0
  )
  const netProfit = totalReturned - totalStaked
  const roi = totalStaked > 0 ? Math.round((netProfit / totalStaked) * 10000) / 100 : 0
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 10000) / 100 : 0

  // Sous-ensemble à cote RÉELLE : le seul sur lequel un ROI financier a un sens.
  const real = rows.filter((r) => betOddsClass(r) === 'exploitable')
  const realStaked = real.reduce((s, r) => s + (r.stake || 0), 0)
  const realReturned = real.reduce(
    (s, r) => (r.result === 'won' ? s + (r.stake || 0) * (r.odds || 1) : s),
    0
  )
  const realNet = realReturned - realStaked
  const realWon = real.filter((r) => r.result === 'won').length
  const realLost = real.filter((r) => r.result === 'lost').length

  return {
    total,
    won,
    lost,
    pending,
    voided,
    totalStaked: Math.round(totalStaked * 100) / 100,
    totalReturned: Math.round(totalReturned * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    roi,
    winRate,
    // --- honnêteté du calcul financier (E75) ---
    // `roi`/`netProfit` ci-dessus restent inchangés pour compatibilité, mais
    // ils mélangent des cotes réelles et des cotes inventées : ils ne doivent
    // pas être présentés comme une performance financière sans le contexte ci-
    // dessous. `realRoi` est le chiffre à afficher en premier.
    syntheticOddsCount: rows.filter((r) => betOddsClass(r) === 'repli').length,
    missingOddsCount: rows.filter((r) => betOddsClass(r) === 'absente').length,
    // Prix saisis à la main : exploitables, mais non vérifiés sur un marché.
    manualOddsCount: rows.filter(
      (r) => (r.odds_source || '').toString().trim().toLowerCase() === 'manuel'
    ).length,
    realOddsCount: real.length,
    realTotalStaked: Math.round(realStaked * 100) / 100,
    realNetProfit: Math.round(realNet * 100) / 100,
    realRoi:
      realStaked > 0 ? Math.round((realNet / realStaked) * 10000) / 100 : null,
    realWinRate:
      realWon + realLost > 0
        ? Math.round((realWon / (realWon + realLost)) * 10000) / 100
        : null,
    oddsPartlySynthetic: real.length < rows.length,
  }
}

router.get('/', (req, res) => {
  try {
    const db = database.db
    const rows = db.prepare('SELECT * FROM bets ORDER BY date DESC, id DESC').all()
    res.json({ success: true, bets: rows, stats: computeStats(rows) })
  } catch (e) {
    logger.error(`[BETS] GET error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.post('/', (req, res) => {
  try {
    const { match_label, league, pick, odds, stake, result = 'pending', note, date } = req.body
    if (!match_label || !pick || !odds || stake === undefined) {
      return res
        .status(400)
        .json({ success: false, error: 'match_label, pick, odds, stake requis' })
    }
    const db = database.db
    const profit =
      result === 'won'
        ? Math.round(((stake || 0) * (odds || 1) - (stake || 0)) * 100) / 100
        : result === 'lost'
          ? -(stake || 0)
          : 0
    const info = db
      .prepare(
        'INSERT INTO bets (match_label, league, pick, odds, stake, result, profit, odds_source, note, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        match_label,
        league || '',
        pick,
        odds,
        stake,
        result,
        profit,
        // E76 : prix saisi à la main. Ce n'est pas une cote de marché
        // vérifiée, mais ce n'est pas un prix inventé non plus : le parieur a
        // payé ce prix-là. Compté dans le ROI, tracé à part.
        'manuel',
        note || '',
        date || new Date().toISOString().split('T')[0]
      )
    const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(info.lastInsertRowid)
    res.json({ success: true, bet })
  } catch (e) {
    logger.error(`[BETS] POST error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params
    const { match_label, league, pick, odds, stake, result, note, date } = req.body
    const db = database.db
    const existing = db.prepare('SELECT * FROM bets WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ success: false, error: 'Bet non trouvé' })
    const finalResult = result !== undefined ? result : existing.result
    const finalStake = stake !== undefined ? stake : existing.stake
    const finalOdds = odds !== undefined ? odds : existing.odds
    // E76 : si la cote a été modifiée, elle vient maintenant de l'utilisateur.
    // Sinon on conserve l'origine déjà connue, et on ne devine que si elle est
    // absente (lignes d'avant le backfill).
    const finalOddsSource =
      odds !== undefined
        ? 'manuel'
        : existing.odds_source || betOddsClass({ odds: finalOdds })
    const profit =
      finalResult === 'won'
        ? Math.round((finalStake * finalOdds - finalStake) * 100) / 100
        : finalResult === 'lost'
          ? -finalStake
          : 0
    db.prepare(
      'UPDATE bets SET match_label=?, league=?, pick=?, odds=?, stake=?, result=?, profit=?, odds_source=?, note=?, date=? WHERE id=?'
    ).run(
      match_label || existing.match_label,
      league !== undefined ? league : existing.league,
      pick || existing.pick,
      finalOdds,
      finalStake,
      finalResult,
      profit,
      finalOddsSource,
      note !== undefined ? note : existing.note,
      date || existing.date,
      id
    )
    const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(id)
    res.json({ success: true, bet })
  } catch (e) {
    logger.error(`[BETS] PUT error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = database.db
    const existing = db.prepare('SELECT * FROM bets WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ success: false, error: 'Bet non trouvé' })
    db.prepare('DELETE FROM bets WHERE id = ?').run(id)
    res.json({ success: true })
  } catch (e) {
    logger.error(`[BETS] DELETE error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.post('/import', (req, res) => {
  try {
    const db = database.db
    const rows = db
      .prepare(
        'SELECT * FROM historical_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL ORDER BY archived_at DESC LIMIT 200'
      )
      .all()
    let imported = 0
    for (const row of rows) {
      let fullData = null
      try {
        fullData = JSON.parse(row.fullData || '{}')
      } catch (_) {
        continue
      }
      const quant = fullData.quant || fullData.enriched?.quant || {}
      const pick = quant.main_pick || fullData.main_pick || fullData.pick
      if (!pick) continue
      const existing = db
        .prepare('SELECT id FROM bets WHERE match_label = ? AND pick = ?')
        .get(`${row.homeTeam} vs ${row.awayTeam}`, pick)
      if (existing) continue
      const sh = row.scoreHome,
        sa = row.scoreAway
      const won = pickWon(pick, sh, sa)
      const odds = getOddsForPick(fullData, pick)
      if (odds <= 0) continue
      const stake = 1
      const profit = won ? Math.round((odds - 1) * 100) / 100 : -1
      db.prepare(
        'INSERT INTO bets (match_label, league, pick, odds, stake, result, profit, odds_source, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `${row.homeTeam} vs ${row.awayTeam}`,
        row.league || '',
        pick,
        Math.round(odds * 100) / 100,
        stake,
        won ? 'won' : 'lost',
        profit,
        // E76 : `getOddsForPick` ne fabrique plus de prix depuis E75 (il
        // renvoie 0 et la ligne est ignorée si aucun prix réel n'existe), donc
        // une ligne acceptée porte bien une cote relevée, pas une inventions.
        'reelle',
        row.timestamp ? row.timestamp.split('T')[0] : new Date().toISOString().split('T')[0]
      )
      imported++
    }
    res.json({ success: true, imported })
  } catch (e) {
    logger.error(`[BETS] IMPORT error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router

// Exports pour __tests__/betsOddsSource.test.js : le classement par origine et
// le calcul des stats sont internes au module, or c'est exactement ce qui
// décide si une ligne entre dans un ROI affiché ou en reste dehors.
module.exports.__test_betOddsClass = betOddsClass
module.exports.__test_computeStats = computeStats
