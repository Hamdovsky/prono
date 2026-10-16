jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../core/database', () => ({
  getRecentArchivedMatches: jest.fn(async () => global.__ARCHIVED__ || []),
}))

/**
 * Fabrique un lot d'archive.
 * @param missedDraws  nombre de nuls (0-0) predict '1' avec draw_prob<30
 * @param solidRate    proportion de victoires '1' parmi les matchs non-nuls
 * @param n            taille du lot
 * @param solidMargin  valeur de base_solid_margin (>0 => match "solid")
 */
function archived({ missedDraws, solidRate, n = 12, solidMargin = 30 }) {
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
      quant: { base_solid_margin: solidMargin, main_pick: '1', draw_probability: 20 },
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

  it('borne haute : reste dans [1.0, 1.6] sur 20 cycles de missed draws', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    global.__ARCHIVED__ = archived({ missedDraws: 8, solidRate: 0 })
    for (let i = 0; i < 20; i++) await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBeGreaterThanOrEqual(1.0)
    expect(opt.weights.draw_bias).toBeLessThanOrEqual(1.6)
  })

  it('borne basse : reste dans [1.0, 1.6] quand les draws ne sont plus manqués', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.6 }
    global.__ARCHIVED__ = archived({ missedDraws: 0, solidRate: 1 })
    for (let i = 0; i < 20; i++) await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBeGreaterThanOrEqual(1.0)
    expect(opt.weights.draw_bias).toBeLessThanOrEqual(1.6)
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

// ── E103 : garde-fous anti-oscillation ────────────────────────────────────────
// Régression du bug réel : avec un jeu de données FIGÉ, l'ancienne logique
// faisait monter bsm_threshold +5 et draw_bias +0.15 a chaque cycle jusqu'aux
// plafonds (40 / 1.60) et y restait bloquée indéfiniment.
describe('autoOptimizer — anti-oscillation (E103)', () => {
  let opt
  let logger

  beforeEach(() => {
    jest.resetModules()
    // logger AVANT autoOptimizer : apres resetModules le registre est neuf, il
    // faut que le module capture la MEME instance de mock que celle du test.
    logger = require('../core/logger')
    opt = require('../core/autoOptimizer')
  })

  it('NE RAMPE PAS vers le plafond quand la métrique ne répond pas', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    // 30 matchs solid, 15 nuls manqués sur 30 = 50 % : signal fort et CONSTANT
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    for (let i = 0; i < 20; i++) await opt.optimizeModelBasedOnROI()
    // L'ancien code terminait à 1.6 (plafond). Le garde-fou doit reverter.
    expect(opt.weights.draw_bias).toBeLessThan(1.6)
  })

  it('revert explicitement la mutation sans effet et journalise 🚨', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI() // mutation up
    expect(opt.weights.draw_bias).toBe(1.15)
    await opt.optimizeModelBasedOnROI() // données identiques -> revert
    expect(opt.weights.draw_bias).toBe(1.0)
    const errors = logger.error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errors).toMatch(/REVERT/)
  })

  it('verrouille le paramètre pendant le lockout après un revert', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    await opt.optimizeModelBasedOnROI() // revert + lock 3 cycles
    expect(opt._isLocked('draw_bias')).toBe(true)
  })

  it('ACCEPTE la mutation quand la métrique progresse réellement', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    // Signal qui s'améliore franchement à chaque cycle : chaque mutation doit
    // être validée, donc le poids doit réellement grimper.
    global.__ARCHIVED__ = archived({ missedDraws: 12, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.15)
    global.__ARCHIVED__ = archived({ missedDraws: 6, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.3)
    // La mutation precedente a ete ACCEPTEE (et non revert) : le nouveau trial
    // porte la metrique d'apres celle de depart et non celle d'avant.
    expect(opt.state.pending).not.toBeNull()
    expect(opt.state.pending.param).toBe('draw_bias')
    expect(opt.state.pending.metricBefore).toBeCloseTo(20, 1)
  })

  it("alerte 🚨 quand le paramètre est déjà saturé", async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.6 }
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    const errors = logger.error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errors).toMatch(/SATUR/)
  })

  it("ne mute QU'UN paramètre par cycle", async () => {
    // bsm passe aussi en trigger « up » : les deux ne doivent pas bouger ensemble.
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 40 })
    const bsmBefore = opt.weights.bsm_threshold
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.15)
    expect(opt.weights.bsm_threshold).toBe(bsmBefore)
  })
})

// ── E103 : échantillon minimal sur la métrique "solid" ────────────────────────
describe('autoOptimizer — taille minimale d’échantillon', () => {
  let opt
  let logger

  beforeEach(() => {
    jest.resetModules()
    // logger AVANT autoOptimizer : apres resetModules le registre est neuf, il
    // faut que le module capture la MEME instance de mock que celle du test.
    logger = require('../core/logger')
    opt = require('../core/autoOptimizer')
  })

  it('refuse de bouger bsm_threshold sous 30 matchs "solid"', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    // 24 matchs (>= MIN_SAMPLE) tous "solid" (< MIN_SOLID_SAMPLE), 0% de winrate
    global.__ARCHIVED__ = archived({ missedDraws: 0, solidRate: 0, n: 24 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.bsm_threshold).toBe(20)
    const warns = logger.warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warns).toMatch(/matchs "solid"/)
  })

  it('accepte de bouger bsm_threshold au-dessus de 30 matchs "solid"', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    global.__ARCHIVED__ = archived({ missedDraws: 0, solidRate: 0, n: 40 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.bsm_threshold).toBe(25)
  })

  it('neutralise le signal quand aucun match n’est "solid" (0 -> pas 100 %)', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.0 }
    global.__ARCHIVED__ = archived({ missedDraws: 0, solidRate: 1, n: 40, solidMargin: 0 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.bsm_threshold).toBe(20)
    const warns = logger.warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warns).toMatch(/Aucun match "solid"/)
  })
})

// ── E127 : soupape anti-saturation ───────────────────────────────────────────
// Au plafond, aucun trial ne demarre (jamais de revert possible) : sans
// soupape, 30 cycles plaqués corrompent l'affichage + spamment les alertes.
// Apres SAT_LIMIT cycles satures d'affilee : retour aux planchers neutres.
describe('autoOptimizer — soupape anti-saturation (E127)', () => {
  let opt
  let logger

  beforeEach(() => {
    jest.resetModules()
    logger = require('../core/logger')
    opt = require('../core/autoOptimizer')
    opt.state.sat = {}
    opt.state.pending = null
    opt.state.locked = {}
  })

  it('reset draw_bias au plancher apres 3 cycles satures', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.6 }
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.6)
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.6)
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.0)
    const errors = logger.error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errors).toMatch(/SOUPAPE/)
  })

  it('reset bsm_threshold au plancher apres 3 cycles satures', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 40, draw_bias: 1.0 }
    // Signaux : bsm pousse up (winrate 0 %), draw ne pousse pas (0 % manques).
    // archived() met main_pick '1' partout : forcer des matchs non-solids
    // avec marge 0 pour neutraliser draw ? Non : missedDraws compte les nuls
    // predits '1' — avec solidRate 1 et missedDraws 0, draw ne pousse pas.
    global.__ARCHIVED__ = archived({ missedDraws: 0, solidRate: 0, n: 40 })
    await opt.optimizeModelBasedOnROI()
    await opt.optimizeModelBasedOnROI()
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.bsm_threshold).toBe(20)
  })

  it('remet le compteur a zero quand le signal retombe', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.6 }
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    await opt.optimizeModelBasedOnROI()
    expect(opt.state.sat.draw_bias).toBe(2)
    // Signal retombe dans la zone morte (10 % : ni up ni down).
    global.__ARCHIVED__ = archived({ missedDraws: 3, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.6)
    expect(opt.state.sat.draw_bias || 0).toBe(0)
  })

  it('ne reset pas avant la limite (2 cycles satures)', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.6 }
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    await opt.optimizeModelBasedOnROI()
    expect(opt.weights.draw_bias).toBe(1.6)
  })

  it('supporte un etat ancien sans compteur sat', async () => {
    opt.weights = { poisson_xg_weight: 1, bsm_threshold: 20, draw_bias: 1.6 }
    delete opt.state.sat
    opt.state.sat = opt.state.sat || {}
    global.__ARCHIVED__ = archived({ missedDraws: 15, solidRate: 0, n: 30 })
    await opt.optimizeModelBasedOnROI()
    expect(opt.state.sat.draw_bias).toBe(1)
  })
})
