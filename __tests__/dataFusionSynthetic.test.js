/**
 * dataFusion E36 — garde ODDS_REJECT_SYNTHETIC. Quand ON : une cote synthetique
 * (fair_odds_model) ne court-circuite plus la chaine -> une vraie cote bookmaker
 * en aval est privilegiee ; l'estimateur ne sert que de dernier recours.
 * OFF (defaut) : comportement historique preserve (la premiere reponse gagne).
 *
 * Le singleton est mute par test puis restaure ; _persistOddsOutcome est neutralise
 * (aucune ecriture DB). ids uniques pour eviter le cache module-level.
 */
const svc = require('../services/dataFusionService')

const SYNTH = { home: 1.8, draw: 3.4, away: 4.1, source: 'fair_odds_model' }
const REAL = { home: 1.75, draw: 3.5, away: 4.2, source: 'sofascore' }

function useSources(synthFirst) {
  svc.sources = synthFirst
    ? [
        { name: 'ultimate_orchestrator', priority: 3 },
        { name: 'sofascore', priority: 9 },
      ]
    : [{ name: 'ultimate_orchestrator', priority: 3 }]
  svc.isSourceAvailable = () => true
  svc._persistOddsOutcome = async () => {}
  svc._tryUnifiedScraper = async () => ({ ...SYNTH })
  svc._trySofascore = async () => ({ ...REAL })
}

let prevEnv
beforeEach(() => { prevEnv = process.env.ODDS_REJECT_SYNTHETIC })
afterEach(() => { if (prevEnv === undefined) delete process.env.ODDS_REJECT_SYNTHETIC; else process.env.ODDS_REJECT_SYNTHETIC = prevEnv })

test('ON : la vraie cote aval gagne sur la synthetique amont (pas de court-circuit)', async () => {
  process.env.ODDS_REJECT_SYNTHETIC = 'on'
  useSources(true)
  const res = await svc.fetchOdds({ id: 'oddsE36a', homeTeam: 'A', awayTeam: 'B' })
  expect(res.source).toBe('sofascore')
  expect(res.bookmaker).toBe(true)
})

test('ON : si seule une synthetique existe, elle est rendue en dernier recours (bookmaker false)', async () => {
  process.env.ODDS_REJECT_SYNTHETIC = 'on'
  useSources(false)
  const res = await svc.fetchOdds({ id: 'oddsE36b', homeTeam: 'A', awayTeam: 'B' })
  expect(res).toBeTruthy()
  expect(res.source).toBe('fair_odds_model')
  expect(res.bookmaker).toBe(false)
})

test('OFF (defaut) : comportement historique -> la synthetique amont court-circuite', async () => {
  delete process.env.ODDS_REJECT_SYNTHETIC
  useSources(true)
  const res = await svc.fetchOdds({ id: 'oddsE36c', homeTeam: 'A', awayTeam: 'B' })
  expect(res.source).toBe('fair_odds_model')
})
