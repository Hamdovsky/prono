/**
 * motivationEnrich.test.js — E71.
 * Prouve que le DMF/motivation produit enfin des target_weight variables
 * (donc des zones mortes atteignables), ce qui rend les signatures de
 * motivation de xg_engine.py et le veto "dead zone" finally opérationnels.
 * Aucun appel réseau : l'API SofaScore est mockée.
 */
jest.mock('../SofascoreScraping/src/apiClient', () => ({
  SofaAPI: { getStandings: jest.fn() },
}))

const { SofaAPI } = require('../SofascoreScraping/src/apiClient')
const { computeDMFProfile, enrichWithMotivation } = require('../services/MotivationEnrichService')

// Classement synthétique 20 équipes, 30 journées jouées.
// relLine = 18, euroLine = 6.
const standings = (overrides = {}) => {
  const rows = []
  for (let i = 1; i <= 20; i++) {
    const id = 1000 + i
    const base = { id, points: 75 - (i - 1) * 2, matches: 30, wins: 0 }
    const o = overrides[i] || {}
    rows.push({ team: { id, name: `Team ${i}` }, position: i, ...base, ...o })
  }
  return rows
}

beforeEach(() => {
  SofaAPI.getStandings.mockReset()
})

describe('computeDMFProfile', () => {
  test('1er/2e : course au titre => weight 1.5', () => {
    const rows = standings()
    const p1 = computeDMFProfile(rows, 1001)
    const p2 = computeDMFProfile(rows, 1002)
    expect(p1.target_weight).toBe(1.5)
    expect(p2.target_weight).toBe(1.5)
    expect(p1.zone).toBe('Battle Zone (Title)')
  })

  test('zone européenne (3e-6e) => weight 1.0', () => {
    const rows = standings()
    const p = computeDMFProfile(rows, 1004)
    expect(p.target_weight).toBe(1.0)
    expect(p.zone).toBe('Battle Zone (Europe)')
  })

  test('zone de relégation (18e-20e) => weight 2.0 (la plus critique)', () => {
    const rows = standings()
    const p = computeDMFProfile(rows, 1019)
    expect(p.target_weight).toBe(2.0)
    expect(p.zone).toBe('Battle Zone (Relegation)')
  })

  test('milieu de table sans victoire => DEAD ZONE, weight 0.0', () => {
    const rows = standings()
    const p = computeDMFProfile(rows, 1010)
    expect(p.target_weight).toBe(0.0)
    expect(p.zone).toBe('Dead Zone')
  })

  test('milieu de table AVEC victoires => Momentum Zone, weight 0.3', () => {
    const rows = standings({ 10: { wins: 4 } })
    const p = computeDMFProfile(rows, 1010)
    expect(p.target_weight).toBe(0.3)
    expect(p.zone).toBe('Momentum Zone')
  })

  test('les 4 zones sont distinguables => weight non constant', () => {
    const rows = standings()
    const weights = [1, 4, 10, 19].map((i) => computeDMFProfile(rows, 1000 + i).target_weight)
    expect(new Set(weights).size).toBe(4)
  })

  test('équipe absente du classement => profil par défaut', () => {
    expect(computeDMFProfile(standings(), 9999).target_weight).toBe(0)
  })

  test('classement vide => profil par défaut', () => {
    expect(computeDMFProfile([], 1001).target_weight).toBe(0)
    expect(computeDMFProfile(null, 1001).target_weight).toBe(0)
  })
})

describe('enrichWithMotivation', () => {
  test('inecte les 8 champs DMF sur le match', async () => {
    SofaAPI.getStandings.mockResolvedValue({ standings: [{ rows: standings() }] })
    const match = { _uniqueTournament: 17, _seasonId: 96668, _homeTeamId: 1001, _awayTeamId: 1019 }

    await enrichWithMotivation(match)

    expect(match.home_target_weight).toBe(1.5) // champion
    expect(match.away_target_weight).toBe(2.0) // relégation
    expect(match.home_zone).toBe('Battle Zone (Title)')
    expect(match.away_zone).toBe('Battle Zone (Relegation)')
    expect(typeof match.home_matches_remaining).toBe('number')
    expect(typeof match.home_distance_target).toBe('number')
  })

  test('match sans tournament/season => early return, AUCUN champ posé', async () => {
    const match = { _homeTeamId: 1001, _awayTeamId: 1019 }
    await enrichWithMotivation(match)
    // C'est ce early-return qui rendait le DMF inerte en production.
    expect(match.home_target_weight).toBeUndefined()
    expect(match.away_target_weight).toBeUndefined()
    expect(SofaAPI.getStandings).not.toHaveBeenCalled()
  })

  test('échec réseau => match inchangé, aucune exception', async () => {
    SofaAPI.getStandings.mockRejectedValue(new Error('403 cooldown'))
    // seasonId distinct : le cache mémoire de standings est.global (1h) et
    // masquerait l'échec réseau si on réutilisait la clé d'un test précédent.
    const match = { _uniqueTournament: 17, _seasonId: 99999, _homeTeamId: 1001, _awayTeamId: 1019 }
    await expect(enrichWithMotivation(match)).resolves.not.toThrow()
    expect(match.home_target_weight).toBeUndefined()
  })

  test('classement vide renvoyé => aucune exception', async () => {
    SofaAPI.getStandings.mockResolvedValue({ standings: [] })
    const match = { _uniqueTournament: 17, _seasonId: 88888, _homeTeamId: 1001, _awayTeamId: 1019 }
    await expect(enrichWithMotivation(match)).resolves.not.toThrow()
  })

  test('deux équipes en zone morte => dead zone double exploitable', async () => {
    SofaAPI.getStandings.mockResolvedValue({ standings: [{ rows: standings() }] })
    const match = { _uniqueTournament: 17, _seasonId: 96668, _homeTeamId: 1010, _awayTeamId: 1012 }
    await enrichWithMotivation(match)
    expect(match.home_target_weight).toBe(0.0)
    expect(match.away_target_weight).toBe(0.0)
  })
})
