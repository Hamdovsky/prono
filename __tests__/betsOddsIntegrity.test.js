/**
 * E75 — intégrité des cotes dans le suivi des paris.
 *
 * Ces tests verrouillent une famille de bugs qui rendait le ROI affiché faux :
 * quand une cote de marché est absente, le code en inventait une (1.00 pour un
 * pick « 12 », 1.20 pour « 1X »/« X2 », 2.00 par défaut) puis calculait le
 * profit dessus. Mesuré sur data/tactical.db : 11 994 lignes sur 13 156
 * (91,2 %) de la table `bets` portaient une cote fabriquée, et le ROI
 * +11,10 % affiché sur /bets en Provenait presque entièrement.
 *
 * Un prix de marché est une information : s'il n'est pas connu, il doit rester
 * inconnu.
 */

const path = require('path')

// ── _getPickOdds (services/settlementService.js) ────────────────────────────
// On recharge le module avec une base vide : la fonction est interne au module,
// on teste donc son comportement à travers l'export qui l'utilise.
function loadSettlement() {
  jest.resetModules()
  return require(path.join(__dirname, '..', 'services', 'settlementService'))
}

describe('E75 — les cotes de repli ne doivent plus exister', () => {
  const row = (over = {}) => ({
    odds_home: null,
    odds_draw: null,
    odds_away: null,
    odds_over25: null,
    odds_under25: null,
    odds_btts_yes: null,
    odds_btts_no: null,
    fullData: null,
    ...over,
  })

  // La résolution de cote passe par _getPickOdds, exposé pour les tests.
  const getOdds = (svc, r, pick) => svc.__test_getPickOdds(r, pick)

  test('un pick simple sans cote stockée renvoie 0, pas 2.0', () => {
    const svc = loadSettlement()
    expect(getOdds(svc, row(), '1')).toBe(0)
    expect(getOdds(svc, row(), 'X')).toBe(0)
    expect(getOdds(svc, row(), '2')).toBe(0)
  })

  test('une cote simple réellement stockée est renvoyée telle quelle', () => {
    const svc = loadSettlement()
    expect(getOdds(svc, row({ odds_home: 2.35 }), '1')).toBeCloseTo(2.35, 5)
    expect(getOdds(svc, row({ odds_draw: 3.4 }), 'X')).toBeCloseTo(3.4, 5)
  })

  test('double chance SANS les deux cotes simples : 0, pas 1.20', () => {
    const svc = loadSettlement()
    // Une seule jambe présente ne suffit pas à fixer un prix de double chance.
    expect(getOdds(svc, row({ odds_home: 1.5 }), '1X')).toBe(0)
    expect(getOdds(svc, row({ odds_draw: 4.0 }), '1X')).toBe(0)
    expect(getOdds(svc, row({ odds_away: 2.8 }), 'X2')).toBe(0)
    expect(getOdds(svc, row({ odds_home: 1.4 }), '12')).toBe(0)
  })

  test('double chance AVEC les deux cotes simples : prix déduit, non rond', () => {
    const svc = loadSettlement()
    // 1X avec h=1.5 et d=4.0 -> 1/(1/1.5 + 1/4.0) = 1.0909...
    const v = getOdds(svc, row({ odds_home: 1.5, odds_draw: 4.0 }), '1X')
    expect(v).toBeCloseTo(1 / (1 / 1.5 + 1 / 4), 5)
    // La signature du repli (1.20 exact) ne doit plus jamais apparaître.
    expect(v).not.toBeCloseTo(1.2, 2)
  })

  test('« 12 » ne peut pas valoir 1.00 : impossible sur un marché à marge', () => {
    const svc = loadSettlement()
    const v = getOdds(svc, row({ odds_home: 2.0, odds_away: 2.0 }), '12')
    // 1/(1/2+1/2) = 1.0 exactement — précisément la signature du repli h=a=2.
    expect(v).toBeCloseTo(1.0, 5)
    // Le point important : avec de vraies cotes de marché (somme des probas
    // implicites > 1), un prix de double chance « 12 » est TOUJOURS < 1.
    const reel = getOdds(svc, row({ odds_home: 1.9, odds_away: 2.05 }), '12')
    expect(reel).toBeLessThan(1)
  })

  test('O0.5 ne doit jamais être résolu avec le prix de la ligne 2.5', () => {
    const svc = loadSettlement()
    // Over 0.5 vaut ~1.05, Over 2.5 vaut ~2.0 : ce sont deux marchés distincts.
    // Résoudre « O0.5 » avec odds_over25 fausserait le profit d'un facteur 2.
    expect(getOdds(svc, row({ odds_over25: 2.0 }), 'O0.5')).toBe(0)
    expect(getOdds(svc, row({ odds_over25: 2.0 }), 'OVER 2.5')).toBeCloseTo(2.0, 5)
    expect(getOdds(svc, row({ odds_under25: 1.85 }), 'UNDER 2.5')).toBeCloseTo(1.85, 5)
  })

  test('BTTS oui et non ne sont pas intervertis', () => {
    const svc = loadSettlement()
    const r = row({ odds_btts_yes: 1.72, odds_btts_no: 2.05 })
    expect(getOdds(svc, r, 'BTTS YES')).toBeCloseTo(1.72, 5)
    expect(getOdds(svc, r, 'BTTS NO')).toBeCloseTo(2.05, 5)
  })

  test('une cote lue dans fullData reste prise en compte', () => {
    const svc = loadSettlement()
    const r = row({ fullData: JSON.stringify({ odds_home: 1.95 }) })
    expect(getOdds(svc, r, '1')).toBeCloseTo(1.95, 5)
  })
})
