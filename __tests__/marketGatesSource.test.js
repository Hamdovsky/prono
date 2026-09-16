/**
 * E51 — gate 1X2 : choix de la source du verdict selon DISABLE_PURE_1X2.
 *   - flag OFF (config actuelle) : le verdict 1X2 brut vit dans `prediction`
 *     (originalPrediction n'est jamais ecrit) -> le gate doit lire `prediction`.
 *   - flag ON : `prediction` est converti en DC ('1X'/'X2') -> le gate doit lire
 *     `originalPrediction` STRICT, sans fallback (sinon melange 1/X/2 et 1X/X2).
 *
 * Test PUR : evaluate1x2() prend des lignes deja chargees (aucune DB, aucun reseau).
 */
const gates = require('../scripts/check_market_gates')

const row = (prediction, original, scoreHome, scoreAway) => ({
  prediction,
  scoreHome,
  scoreAway,
  fullData: JSON.stringify(original ? { originalPrediction: original } : {}),
})

describe('E51 gate 1X2 - source du verdict', () => {
  afterEach(() => {
    delete process.env.DISABLE_PURE_1X2
  })

  describe('flag OFF -> lit `prediction`', () => {
    beforeEach(() => {
      delete process.env.DISABLE_PURE_1X2
    })

    it('_pure1x2SourceIsOriginal() = false', () => {
      expect(gates._pure1x2SourceIsOriginal()).toBe(false)
    })

    it('compte les verdicts depuis `prediction` (originalPrediction absent)', () => {
      const rows = [
        row('1', null, 2, 0), // predit home, gagne -> correct
        row('2', null, 0, 1), // predit away, gagne -> correct
        row('1', null, 0, 1), // predit home, perdu
      ]
      const g = gates.evaluate1x2(rows, false)
      expect(g.n).toBe(3)
      expect(g.ok).toBe(2)
      expect(g.source).toBe('prediction')
    })

    it('IGNORE fullData.originalPrediction quand il existe (flag off = prediction fait foi)', () => {
      // Ligne ou prediction='2' mais originalPrediction='1' (residu historique).
      const g = gates.evaluate1x2([row('2', '1', 0, 1)], false)
      expect(g.byOrig['2']).toEqual({ n: 1, ok: 1 })
      expect(g.byOrig['1']).toBeUndefined()
    })
  })

  describe('flag ON -> lit `originalPrediction` STRICT (pas de fallback)', () => {
    beforeEach(() => {
      process.env.DISABLE_PURE_1X2 = 'true'
    })

    it('_pure1x2SourceIsOriginal() = true', () => {
      expect(gates._pure1x2SourceIsOriginal()).toBe(true)
    })

    it('lit originalPrediction, PAS prediction (evite de compter 1X/X2 comme 1X2)', () => {
      const rows = [
        row('1X', '1', 2, 0), // prediction converti en DC ; original='1' -> compte
        row('X2', '2', 0, 1), // original='2' -> compte
      ]
      const g = gates.evaluate1x2(rows, true)
      expect(g.n).toBe(2)
      expect(g.byOrig['1']).toEqual({ n: 1, ok: 1 })
      expect(g.byOrig['2']).toEqual({ n: 1, ok: 1 })
      expect(g.byOrig['1X']).toBeUndefined()
      expect(g.source).toBe('originalPrediction')
    })

    it('PAS de fallback : sans originalPrediction, la ligne est exclue (pas prediction)', () => {
      // prediction='1' (brut) mais pas d'originalPrediction -> EXCLU sous flag on.
      const g = gates.evaluate1x2([row('1', null, 2, 0)], true)
      expect(g.n).toBe(0)
    })

    it('exclut les verdicts non purs convertis restants (1X/X2 sans original)', () => {
      const g = gates.evaluate1x2([row('1X', null, 2, 0)], true)
      expect(g.n).toBe(0)
    })
  })
})
