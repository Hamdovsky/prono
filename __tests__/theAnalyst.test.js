/**
 * theAnalyst.test.js — unit tests du client theAnalyst (Opta 1X2, E69).
 * Aucun appel réseau : transport injecté via setTransport().
 */
jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

const { client, LEAGUES, parseJsonp, extractOneXTwo, toDateWindow, toKickoffMs, setTransport } = require('../services/theAnalystClient')
const { enrichMatchesOpta } = require('../services/optaPredictions')
const database = require('../core/database')

// Helpers pour simuler le transport JSONP.
const okJsonp = (obj) => ({ text: () => Promise.resolve(`cbsoccer-match(${JSON.stringify(obj)});`) })
const failJsonp = (http) => ({
  text: () =>
    Promise.resolve(`cb({"httpStatus":"${http}","errorCode":"1000","token":"abc"});`),
})

afterEach(() => {
  setTransport(null)
})

describe('parseJsonp', () => {
  test('extrait et parse le payload JSONP', () => {
    const out = parseJsonp('cb({"a":1});')
    expect(out).toEqual({ a: 1 })
    expect(parseJsonp('cbsoccer-match({"m":2});').m).toBe(2)
  })
  test('retourne null sur contenu invalide', () => {
    expect(parseJsonp('<html></html>')).toBeNull()
    expect(parseJsonp('')).toBeNull()
    expect(parseJsonp('cb(notjson);')).toBeNull()
  })
})

describe('toDateWindow / toKickoffMs', () => {
  test('fenêtre au format [Y-m-dT00:00:00Z TO ...]', () => {
    const w = toDateWindow(2)
    expect(w).toMatch(/^\[\d{4}-\d{2}-\d{2}T00:00:00Z TO \d{4}-\d{2}-\d{2}T00:00:00Z\]$/)
  })
  test('kickoff combine date + time Opta', () => {
    const ms = toKickoffMs('2026-09-27Z', '19:30:00Z')
    expect(ms).toBe(Date.parse('2026-09-27T19:30:00Z'))
  })
})

describe('extractOneXTwo', () => {
  test('mappe Home/Draw/Away -> home/draw/away (pourcentages)', () => {
    const out = extractOneXTwo({
      preMatchPredictions: [
        { prediction: [
          { type: 'Home', probability: '34.614' },
          { type: 'Draw', probability: '22.961' },
          { type: 'Away', probability: '42.425' },
        ] },
      ],
    })
    expect(out).toEqual({ home: 34.614, draw: 22.961, away: 42.425 })
  })
  test('null si un des trois manque', () => {
    expect(extractOneXTwo({ preMatchPredictions: [] })).toBeNull()
    expect(extractOneXTwo({})).toBeNull()
  })
})

describe('fetchLeagueMatches', () => {
  test('garde les matchs periodId 16 et duplicate les équipes', async () => {
    setTransport(({ url }) => {
      expect(url).toContain('tmcl=')
      return okJsonp({
        match: [
          { matchInfo: { id: 'm1', date: '2026-09-27Z', time: '19:30:00Z', competition: { name: 'MLS' }, contestant: [{ name: 'A' }, { name: 'B' }] }, liveData: { matchDetails: { periodId: 16 } } },
          { matchInfo: { id: 'm2', date: '2026-09-27Z', time: '19:30:00Z', competition: { name: 'MLS' }, contestant: [{ name: 'C' }, { name: 'D' }] }, liveData: { matchDetails: { periodId: 14 } } },
          { matchInfo: { id: 'm3', date: '2026-09-27Z', time: '19:30:00Z', competition: { name: 'MLS' }, contestant: [{ name: 'E' }] }, liveData: { matchDetails: { periodId: 16 } } },
        ],
      })
    })
    const out = await client.fetchLeagueMatches({ tmcl: 'x', code: 'X', label: 'L' })
    expect(out).toHaveLength(1)
    expect(out[0].matchId).toBe('m1')
    expect(out[0].home).toBe('A')
    expect(out[0].away).toBe('B')
  })

  test('retourne [] sur 404 (pas de data) pour la ligue', async () => {
    setTransport(() => failJsonp('404'))
    const out = await client.fetchLeagueMatches({ tmcl: 'x', code: 'X', label: 'L' })
    expect(out).toEqual([])
  })

  test('retourne [] sur erreur auth (401)', async () => {
    setTransport(() => failJsonp('401'))
    const out = await client.fetchLeagueMatches({ tmcl: 'x', code: 'X', label: 'L' })
    expect(out).toEqual([])
  })
})

describe('fetchMatchPredictions', () => {
  test('extrait les probas 1X2 par matchId', async () => {
    setTransport(({ url }) => {
      expect(url).toMatch(/\/matchlivewinprobability\//)
      return okJsonp({
        liveData: {
          matchDetails: { periodId: 16 },
          preMatchPredictions: [
            { prediction: [
              { type: 'Home', probability: '25%' },
              { type: 'Draw', probability: '30' },
              { type: 'Away', probability: '45' },
            ] },
          ],
        },
      })
    })
    const out = await client.fetchMatchPredictions('abcd1234')
    expect(out).toEqual({ home: 25, draw: 30, away: 45 })
  })

  test('null si pas de predictions publiées', async () => {
    setTransport(() => okJsonp({ liveData: { matchDetails: { periodId: 16 } } }))
    const out = await client.fetchMatchPredictions('abcd1234')
    expect(out).toBeNull()
  })
})

describe('fetchAll', () => {
  test('agrège matchs + probas sur plusieurs ligues', async () => {
    let calls = 0
    setTransport(({ url }) => {
      calls++
      if (url.includes('/matchlivewinprobability/')) {
        return okJsonp({ liveData: { matchDetails: { periodId: 16 }, preMatchPredictions: [{ prediction: [
          { type: 'Home', probability: '50' }, { type: 'Draw', probability: '30' }, { type: 'Away', probability: '20' }] }] } })
      }
      return okJsonp({
        match: [{ matchInfo: { id: `m${calls}`, date: '2026-09-27Z', time: '19:30:00Z', contestant: [{ name: 'Home' }, { name: 'Away' }] }, liveData: { matchDetails: { periodId: 16 } } }],
      })
    })
    const { results } = await client.fetchAll({ maxLeagues: 2 })
    expect(results.length).toBe(2)
    expect(results[0]).toMatchObject({ prob_home: 50, prob_draw: 30, prob_away: 20 })
    expect(results[0].matchId).toBe('m1')
    expect(results[0].home).toBe('Home')
    expect(results[0].away).toBe('Away')
  })
})

test('LEAGUES embarque les 18 ligues du widget', () => {
  expect(LEAGUES).toHaveLength(18)
  expect(LEAGUES.find((l) => l.code === 'EPL').tmcl).toBe('6pdwluctev9iebv00r4qqukno')
})

describe('enrichMatchesOpta', () => {
  const sample = require('../services/optaPredictions').runUpsert
  // Timestamp relatif (E89) : la valeur en dur (1790213400000 ≈ 23/09/2026)
  // sortait de la fenêtre de listPredictions (kickoff >= now-8j) => test périmé
  // selon la date système.
  const KICKOFF_MS = Date.now() + 2 * 3600 * 1000
  // Insère un match connu dans la DB (idempotent) pour tester l'enrichissement.
  beforeAll(() => {
    sample(database, {
      matchId: 'test_enrich_e2e',
      kickoffMs: KICKOFF_MS,
      league: 'MLS',
      home: 'Seattle Sounders',
      away: 'Real Salt Lake',
      prob_home: 53.67,
      prob_draw: 22.205,
      prob_away: 24.125,
    })
  })
  test('attache .opta quand le match est trouvé par jointure (normTeam + date)', () => {
    const matches = [
      {
        id: 'm1',
        homeTeam: 'Seattle Sounders',
        awayTeam: 'Real Salt Lake',
        startTimestamp: KICKOFF_MS,
      },
    ]
    enrichMatchesOpta(database, matches)
    expect(matches[0].opta).toBeDefined()
    expect(matches[0].opta.home).toBeCloseTo(53.67, 1)
    expect(matches[0].opta.draw).toBeCloseTo(22.205, 2)
  })
  test('ne modifie pas les matchs non trouvés', () => {
    const matches = [
      { id: 'm2', homeTeam: 'Totally Unknown FC', awayTeam: 'Xyz AB', startTimestamp: KICKOFF_MS },
    ]
    enrichMatchesOpta(database, matches)
    expect(matches[0].opta).toBeUndefined()
  })
})
