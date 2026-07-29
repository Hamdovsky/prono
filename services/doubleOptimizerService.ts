// @ts-nocheck
import logger from '../core/logger'

class DoubleOptimizerService {
  bestSingle(p1, px, p2) {
    const max = Math.max(p1, px, p2)
    return { pick: p1 === max ? '1' : p2 === max ? '2' : 'X', prob: max }
  }

  bestDouble(p1, px, p2) {
    const pairs = [
      { pick: ['1', 'X'], prob: p1 + px },
      { pick: ['1', '2'], prob: p1 + p2 },
      { pick: ['X', '2'], prob: px + p2 },
    ]
    return pairs.reduce((a, b) => (b.prob > a.prob ? b : a))
  }

  secondBestSingle(p1, px, p2, firstPick) {
    const sorted = [
      { v: '1', p: p1 },
      { v: 'X', p: px },
      { v: '2', p: p2 },
    ].sort((a, b) => b.p - a.p)
    return sorted.find((x) => x.v !== firstPick) || sorted[0]
  }

  computeMarginalGain(p1, px, p2) {
    const single = this.bestSingle(p1, px, p2)
    const dbl = this.bestDouble(p1, px, p2)
    return {
      bestSingle: single,
      bestDouble: dbl,
      gain: +(dbl.prob - single.prob).toFixed(4),
      gainPct: +((dbl.prob - single.prob) * 100).toFixed(1),
      doubleCoverage: +(dbl.prob * 100).toFixed(1),
    }
  }

  selectOptimalDoubles(matches, count = 5) {
    const scored = matches.map((m) => {
      const p1 = m.p1 || 0.33
      const px = m.px || 0.33
      const p2 = m.p2 || 0.34
      const mg = this.computeMarginalGain(p1, px, p2)

      const crowdFav = (m.homeWinProbability || 0.33) > (m.awayWinProbability || 0.34) ? '1' : '2'
      const isContrarian = mg.bestSingle.pick !== crowdFav

      return {
        id: m.id || m._id,
        home: m.homeTeam || m.home || '',
        away: m.awayTeam || m.away || '',
        p1,
        px,
        p2,
        ...mg,
        isContrarian,
        isCrowdTrap: m.isCrowdTrap || false,
      }
    })

    scored.sort((a, b) => b.gain - a.gain)
    const selected = scored.slice(0, count).map((m) => m.id)
    const ranked = scored.map((m, i) => ({ ...m, rank: i + 1, selected: selected.includes(m.id) }))

    const expectedSingle = scored.reduce((s, m) => s + m.bestSingle.prob, 0)
    const expectedDoubled = scored.reduce((s, m) => {
      if (selected.includes(m.id)) return s + m.bestDouble.prob
      return s + m.bestSingle.prob
    }, 0)

    return {
      selectedIds: selected,
      ranked,
      expectedCorrect: {
        allSingles: +expectedSingle.toFixed(2),
        withDoubles: +expectedDoubled.toFixed(2),
        gain: +(expectedDoubled - expectedSingle).toFixed(2),
        avgCoverage: +((expectedDoubled / matches.length) * 100).toFixed(1),
      },
    }
  }

  simulateDoubleCounts(matches) {
    const scored = matches.map((m) => {
      const p1 = m.p1 || 0.33
      const px = m.px || 0.33
      const p2 = m.p2 || 0.34
      const single = this.bestSingle(p1, px, p2)
      const dbl = this.bestDouble(p1, px, p2)
      return { gain: dbl.prob - single.prob, singleProb: single.prob, doubleProb: dbl.prob }
    })

    scored.sort((a, b) => b.gain - a.gain)

    const results = []
    for (let k = 0; k <= matches.length; k++) {
      const expected = scored.reduce((sum, m, i) => sum + (i < k ? m.doubleProb : m.singleProb), 0)
      results.push({
        doubles: k,
        expectedCorrect: +expected.toFixed(2),
        avgCoverage: +((expected / matches.length) * 100).toFixed(1),
        marginalGain: k === 0 ? 0 : +(expected - results[k - 1]?.expectedCorrect || 0).toFixed(2),
      })
    }
    return results
  }
}

export = new DoubleOptimizerService()
