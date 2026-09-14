/**
 * core/clv.pickClosingSnapshot (E35) — la cloture est la derniere cote AVANT kickoff.
 */
const { pickClosingSnapshot } = require('../core/clv')

test('null si pas de lignes', () => {
  expect(pickClosingSnapshot([], 1000)).toBe(null)
  expect(pickClosingSnapshot(null, 1000)).toBe(null)
})

test('kickoff inconnu (0) -> retourne la plus recente (preserver ancien comportement)', () => {
  const rows = [{ timestamp: 2000, odds_home: 1.5 }, { timestamp: 1000, odds_home: 2 }]
  expect(pickClosingSnapshot(rows, 0)).toBe(rows[0])
})

test('choisit la derniere ligne <= kickoff (ignore le post-kickoff)', () => {
  const a = { timestamp: 2000, tag: 'post' } // apres kickoff
  const b = { timestamp: 1500, tag: 'closing' }
  const c = { timestamp: 1000, tag: 'early' }
  expect(pickClosingSnapshot([a, b, c], 1600).tag).toBe('closing')
})

test('exactement au kickoff inclus', () => {
  const b = { timestamp: 1600, tag: 'closing' }
  expect(pickClosingSnapshot([b], 1600).tag).toBe('closing')
})

test('toutes les lignes apres le kickoff -> null (pas de fausse cloture)', () => {
  const a = { timestamp: 2000 }
  const z = { timestamp: 3000 }
  expect(pickClosingSnapshot([z, a], 1600)).toBe(null)
})

test('timestamp manquant (0) ignore quand kickoff connu', () => {
  const good = { timestamp: 1500, tag: 'ok' }
  expect(pickClosingSnapshot([{ timestamp: 0 }, good], 1600).tag).toBe('ok')
})
