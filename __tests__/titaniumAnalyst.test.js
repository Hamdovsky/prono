const request = require('supertest')
const express = require('express')
const titaniumRouter = require('../routes/titanium')
const database = require('../core/database')
const { analyze, analyzeMatchFromDb } = require('../core/titaniumAnalyst')

let app
beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/titanium', titaniumRouter)
})

const FRENCH_INPUT = {
  equipes: {
    nom: 'Equipe A',
    nom_b: 'Equipe B',
    championnat: 'Test League',
    classement: 3,
    points: 45,
    classement_b: 8,
    points_b: 28,
  },
  forme: [
    { resultat: 'V', score: '2-0', domicile: true },
    { resultat: 'V', score: '1-0', domicile: false },
    { resultat: 'N', score: '1-1', domicile: true },
    { resultat: 'V', score: '3-1', domicile: false },
    { resultat: 'D', score: '0-1', domicile: true },
  ],
  forme_b: [
    { resultat: 'D', score: '0-2', domicile: false },
    { resultat: 'D', score: '1-3', domicile: true },
    { resultat: 'N', score: '2-2', domicile: false },
    { resultat: 'D', score: '0-1', domicile: true },
    { resultat: 'V', score: '2-1', domicile: false },
  ],
  stats: {
    buts_marques_dom: 1.9,
    buts_encaisses_dom: 0.8,
    buts_marques_ext: 1.4,
    buts_encaisses_ext: 1.1,
    xg: 1.7,
    xg_b: 1.2,
    tirs_cadres: 5.2,
    possession: 55,
  },
  h2h: [
    { date: '2025-01-10', score: '2-1', domicile: 'Equipe A' },
    { date: '2024-08-22', score: '1-1', domicile: 'Equipe A' },
    { date: '2024-03-15', score: '0-2', domicile: 'Equipe B' },
  ],
  compositions: {
    absents_equipe_a: [{ joueur: 'Milieu clé', motif: 'Suspendu', importance: 'titulaire' }],
    absents_equipe_b: [],
  },
  cotes: {
    1: 1.7,
    N: 3.8,
    2: 4.6,
    over25: 1.85,
    under25: 1.95,
    btts_oui: 1.9,
    btts_non: 1.9,
  },
  contexte: { enjeu: '', calendrier_charge: false, meteo: 'Rain (12°C)', arbitre: 'R. Doe' },
}

describe('titaniumAnalyst.analyze', () => {
  it('returns the strict Titanium JSON schema', () => {
    const out = analyze(FRENCH_INPUT)

    expect(out).toEqual(
      expect.objectContaining({
        match: expect.any(String),
        competition: 'Test League',
        date: expect.any(String),
        resume_forme: expect.objectContaining({
          equipe_a: expect.any(String),
          equipe_b: expect.any(String),
        }),
        facteurs_cles: expect.any(Array),
        pronostic_principal: expect.objectContaining({
          type: expect.any(String),
          confiance: expect.stringMatching(/faible|moyenne|elevee/),
          probabilite_estimee: expect.any(Number),
          justification: expect.any(String),
        }),
        pronostics_secondaires: expect.any(Array),
        value_bet: expect.objectContaining({
          detecte: expect.any(Boolean),
          marche: expect.any(String),
          cote_marche: expect.any(Number),
          probabilite_estimee: expect.any(Number),
          edge_pourcentage: expect.any(Number),
        }),
        piege_public: expect.objectContaining({
          detecte: expect.any(Boolean),
          description: expect.any(String),
          equipe_surcotee: expect.any(String),
        }),
        facteurs_risque: expect.any(Array),
        score_probable: expect.any(String),
      })
    )
  })

  it('flags low H2H sample size (<3) in facteurs_risque', () => {
    const out = analyze({ ...FRENCH_INPUT, h2h: [FRENCH_INPUT.h2h[0]] })
    expect(out.facteurs_risque.some((r) => r.includes('H2H'))).toBe(true)
  })

  it('flags missing form data instead of inventing it', () => {
    const out = analyze({ ...FRENCH_INPUT, forme: [], forme_b: [] })
    expect(out.facteurs_risque.some((r) => r.includes('Forme equipe A'))).toBe(true)
    expect(out.facteurs_risque.some((r) => r.includes('Forme equipe B'))).toBe(true)
  })

  it('detects a value bet only when edge >= 5 points', () => {
    const StatisticalEngine = require('../core/services/StatisticalEngine')
    jest.spyOn(StatisticalEngine, 'calculateMarketProbs').mockReturnValue({
      win: { home: 0.4, draw: 0.3, away: 0.3 },
      btts: { yes: 0.5, no: 0.5 },
      ou: { 2.5: 0.45 },
      u: { 2.5: 0.55 },
    })
    jest.spyOn(StatisticalEngine, 'findMostProbableScore').mockReturnValue('1 - 1')

    const strong = analyze({
      ...FRENCH_INPUT,
      cotes: { 1: 3.5, N: 3.4, 2: 3.4, over25: 2.2, under25: 1.8, btts_oui: 2.0, btts_non: 2.0 },
    })
    const noValue = analyze({
      ...FRENCH_INPUT,
      cotes: {
        1: 2.5,
        N: 3.34,
        2: 3.34,
        over25: 2.22,
        under25: 1.82,
        btts_oui: 2.0,
        btts_non: 2.0,
      },
    })

    expect(noValue.value_bet.detecte).toBe(false)
    expect(strong.value_bet.detecte).toBe(true)
    expect(strong.value_bet.edge_pourcentage).toBeGreaterThanOrEqual(5)
    jest.restoreAllMocks()
  })

  it('keeps probabilities realistic (0..1)', () => {
    const out = analyze(FRENCH_INPUT)
    const all = [
      out.pronostic_principal.probabilite_estimee,
      ...out.pronostics_secondaires.map((p) => p.probabilite_estimee),
    ]
    all.forEach((p) => {
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    })
  })
})

describe('titaniumAnalyst.analyzeMatchFromDb', () => {
  const DB_MATCH = {
    id: 'm1',
    homeTeam: 'Paris FC',
    awayTeam: 'Lyon',
    league: 'Ligue 1',
    country_iso: 'FR',
    startTimestamp: Math.floor(Date.now() / 1000) + 86400,
    odds_home: 1.95,
    odds_draw: 3.4,
    odds_away: 3.9,
    home_form_pts: 11,
    away_form_pts: 5,
    home_xg: 1.6,
    away_xg: 1.2,
    is_high_pressure: 0,
    weather_desc: 'Light rain',
    weather_temp: 12,
    referee: 'M. Dupont',
    fullData: JSON.stringify({
      form_context: {
        home: { standing: { rank: 2, points: 40 } },
        away: { standing: { rank: 7, points: 25 } },
      },
      teamStats: {
        home: {
          avgGoalsScored: 1.8,
          avgGoalsConceded: 0.9,
          avgShotsOnTarget: 5,
          avgPossession: 54,
        },
        away: {
          avgGoalsScored: 1.3,
          avgGoalsConceded: 1.2,
          avgShotsOnTarget: 4,
          avgPossession: 48,
        },
      },
      h2h_data: {
        teamDuel: {
          lastMeetings: [
            {
              homeTeam: 'Paris FC',
              awayTeam: 'Lyon',
              homeScore: 2,
              awayScore: 1,
              startTimestamp: Date.now() / 1000,
            },
          ],
        },
      },
    }),
  }

  it('adapts a DB match into the French schema and analyzes it', () => {
    const out = analyzeMatchFromDb(DB_MATCH)
    expect(out).not.toBeNull()
    expect(out.match).toBe('Paris FC - Lyon')
    expect(out.competition).toBe('Ligue 1')
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(out.resume_forme.equipe_a).toContain('V')
  })

  it('returns null for a missing match', () => {
    expect(analyzeMatchFromDb(null)).toBeNull()
  })
})

describe('GET /api/titanium/analysis', () => {
  it('returns 404 for unknown match', async () => {
    jest.spyOn(database, 'getMatchById').mockResolvedValue(null)
    const response = await request(app).get('/api/titanium/analysis/nonexistent')
    expect(response.status).toBe(404)
    expect(response.body.success).toBe(false)
    jest.restoreAllMocks()
  })

  it('returns analysis JSON for an existing match', async () => {
    jest.spyOn(database, 'getMatchById').mockResolvedValue({
      id: 'm1',
      homeTeam: 'Paris FC',
      awayTeam: 'Lyon',
      league: 'Ligue 1',
      startTimestamp: Math.floor(Date.now() / 1000) + 86400,
      odds_home: 1.95,
      odds_draw: 3.4,
      odds_away: 3.9,
    })
    const response = await request(app).get('/api/titanium/analysis/m1')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.analysis).toHaveProperty('pronostic_principal')
    expect(response.body.analysis).toHaveProperty('value_bet')
    expect(response.body.analysis).toHaveProperty('piege_public')
    jest.restoreAllMocks()
  })
})
