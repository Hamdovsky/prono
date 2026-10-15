// Regression tests dashboard (E98) : vérifient, au niveau SOURCE, deux
// faiblesses corrigées dans Dashboard.jsx (les tests unitaires purs ne
// couvrent pas le rendu JSX ni le tri interne du composant).
//   1. La vue /live rendait AUSSI la table "TOUS LES MATCHS" (le else final du
//      ternaire de vue s'exécutait pour activeView === 'live'). Garde-fou : un
//      `activeView === 'live' ? null : (` doit exister.
//   2. `allMatchesList` triait `baseList` EN PLACE (applyMarketFilter renvoie la
//      même référence quand dominantFilter === 'ALL'). Garde-fou : tri sur copie.
const fs = jest.requireActual('fs') // setup.js mocke fs (readFileSync -> '{}')
const path = require('path')

const SRC = path.resolve(__dirname, '..', 'src')
const dashboardSource = () =>
  fs.readFileSync(path.join(SRC, 'components', 'Dashboard.jsx'), 'utf8')

describe('Dashboard view routing (E98 regression)', () => {
  it("la vue /live est exclue de la branche par defaut (pas de double rendu)", () => {
    const src = dashboardSource()
    // La branche live doit court-circuiter le rendu de la table par défaut.
    expect(src).toMatch(/activeView === 'live' \? null : \(/)
    // Les blocs live (liste + état vide) restent présents.
    expect(src).toMatch(/activeView === 'live' && liveMatches\.length > 0/)
    expect(src).toMatch(/activeView === 'live' && liveMatches\.length === 0/)
  })

  it('le tri par defaut ne mute pas baseList (tri sur copie)', () => {
    const src = dashboardSource()
    // `return [...filtered]` puis `.sort(` (au lieu de `filtered.sort(`).
    expect(src).toMatch(/return \[\.\.\.filtered\]\s*\.sort\(/)
    expect(src).not.toMatch(/return filtered\s*\.sort\(/)
  })
})
