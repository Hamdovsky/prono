jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../core/database', () => ({
  getRecentArchivedMatches: jest.fn(async () => global.__ARCHIVED__ || []),
}))

// 12 matchs solides : `wins` gagnants (2-0, pick '1'), `missedDraws` nuls
// manqués (0-0, pick '1', draw_probability < 30), le reste 0-2 (jamais X).
function archived({ missedDraws, solidRate }) {
  const n = 12
  const wins = Math.round(n * solidRate)
  const rows = []
  for (let i = 0; i < n; i++) {
    let scoreHome = 2
    let scoreAway = 0
    if (i >= wins && i < wins + missedDraws) {
      scoreHome = 0
      scoreAway = 0
    } else if (i >= wins + missedDraws) {
      scoreHome = 0
      scoreAway = 2
    }
    rows.push({
      scoreHome,
      scoreAway,
      quant: { base_solid_margin: 30, main_pick: '1', draw_probability: 20 },
    })
  }
  return rows
}

describe('autoOptimizer — draw_bias borné et réversible', () => {
  let opt

  beforeEach(() => {
    jest.resetModules()
    opt = require('../core/autoOptimizer')
  })

  it('borne haute : jamais > 1.6 même après 20 cycles de missed draws', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    global.__ARCHIVED__ = archived({ missedDraws: 8, solidRate: 0 })
    for (let i = 0; i < 20; i++) await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.6)
  })

  it('borne basse : redescend vers 1.0 quand les draws ne sont plus manqués', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.6 }
    global.__ARCHIVED__ = archived({ missedDraws: 0, solidRate: 1 })
    for (let i = 0; i < 20; i++) await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.0)
  })

  it('assainit une valeur historique hors plage (65.65) et repersiste', () => {
    // setup.js mocke fs globalement ; après resetModules on retrouve LA MÊME
    // instance de mock que celle capturée par autoOptimizer dans ce registre.
    const fs = require('fs')
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 65.65 }
    opt._sanitizeWeights()
    expect(opt.weights.draw_bias).toBe(1.6)
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      opt.configPath,
      expect.stringContaining('"draw_bias": 1.6')
    )
  })
})
