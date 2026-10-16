/**
 * E130 — flag "nouveau coach" dans le scorer (plafond 70, meme pattern que
 * le garde-fou baseSolidMargin). Sans flag : comportement inchange.
 */
jest.mock('../core/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}))

const { computeConfidence } = require('../core/confidenceScorer')

const base = {
  mainPick: '1', topProb: 0.8, secondProb: 0.15, baseSolidMargin: 30,
  insufficientData: 0, league: 'Test League', marketType: '1X2',
}

describe('confidenceScorer coachNew (E130)', () => {
  it('plafonne a 70 quand nouveau coach', () => {
    const plain = computeConfidence({ ...base })
    expect(plain.confidence).toBeGreaterThan(70)
    const capped = computeConfidence({ ...base, coachNew: true })
    expect(capped.confidence).toBe(70)
    expect(capped.breakdown.coachNew).toBe(true)
    expect(capped.breakdown.coachCapped).toBe(true)
  })

  it('ne change rien sans flag ni sous le plafond', () => {
    const a = computeConfidence({ ...base })
    const b = computeConfidence({ ...base, coachNew: false })
    expect(b).toEqual(a)
    expect(b.breakdown.coachCapped).toBe(false)
    const low = computeConfidence({ ...base, topProb: 0.55, secondProb: 0.4, coachNew: true })
    expect(low.confidence).toBeLessThanOrEqual(70)
  })
})
