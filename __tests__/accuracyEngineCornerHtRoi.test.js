// Audit C : ROI Corners/HT — avant ce commit, pickOdds renvoyait null pour ces
// marches => exclus du ROI. On verifie que les cotes archivees (colonnes
// odds_corner_*/odds_ht_*) sont desormais resolues et que le record est mesure.
const ae = require('../services/accuracyEngine')

describe('audit C : ROI Corners/HT active', () => {
  test('pickOdds resout les cotes archivees Corners/HT', () => {
    expect(ae.pickOdds('CORNERSOVER9.5', { cornerOver: 1.9 })).toBe(1.9)
    expect(ae.pickOdds('CORNERSUNDER9.5', { cornerUnder: 2.1 })).toBe(2.1)
    expect(ae.pickOdds('HTOVER0.5', { htOver: 1.8 })).toBe(1.8)
    expect(ae.pickOdds('HTUNDER0.5', { htUnder: 2.2 })).toBe(2.2)
  })

  test('isCorrect Corners/HT sur le resultat reel', () => {
    expect(ae.isCorrect('CORNERSOVER9.5', '1', 2, 1, { cornersHome: 6, cornersAway: 5 })).toBe(true)
    expect(ae.isCorrect('CORNERSOVER9.5', '1', 2, 1, { cornersHome: 4, cornersAway: 4 })).toBe(false)
    expect(ae.isCorrect('HTUNDER0.5', '2', 0, 1, { htHome: 0, htAway: 0 })).toBe(true)
  })

  test('record CORNERS avec cotes -> ROI resolvable a l agregation', () => {
    const recs = ae.recordsFromHistorical(
      {
        fullData: JSON.stringify({ prediction: 'CORNERS OVER 9.5', confidence: 80 }),
        scoreHome: 2,
        scoreAway: 1,
        corners_home: 6,
        corners_away: 5, // 11 > 9.5
        odds_corner_over: 1.9,
      },
      { marketFilter: 'all' }
    )
    const rec = recs.find((r) => r.pick === 'CORNERSOVER9.5')
    expect(rec).toBeTruthy()
    expect(rec.odds.cornerOver).toBe(1.9)
    expect(ae.pickOdds(rec.pick, rec.odds)).toBe(1.9) // -> ROI calcule (non null)
  })

  test('record HT avec cotes -> ROI resolvable a l agregation', () => {
    const recs = ae.recordsFromHistorical(
      {
        fullData: JSON.stringify({ prediction: 'HT UNDER 0.5', confidence: 70 }),
        scoreHome: 0,
        scoreAway: 1,
        score_home_ht: 0,
        score_away_ht: 0,
        odds_ht_under: 2.0,
      },
      { marketFilter: 'all' }
    )
    const rec = recs.find((r) => r.pick === 'HTUNDER0.5')
    expect(rec).toBeTruthy()
    expect(ae.pickOdds(rec.pick, rec.odds)).toBe(2.0)
  })

  test('sans cotes archivees -> toujours exclu du ROI (comptabilise a part)', () => {
    const recs = ae.recordsFromHistorical(
      {
        fullData: JSON.stringify({ prediction: 'CORNERS OVER 9.5', confidence: 80 }),
        scoreHome: 2,
        scoreAway: 1,
        corners_home: 6,
        corners_away: 5,
      },
      { marketFilter: 'all' }
    )
    const rec = recs.find((r) => r.pick === 'CORNERSOVER9.5')
    expect(ae.pickOdds(rec.pick, rec.odds)).toBeNull()
  })
})
