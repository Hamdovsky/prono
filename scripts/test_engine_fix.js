const { generatePromosportGrids } = require('./core/promosport_engine');
const mockMatches = [
  { id: 1, homeTeam: 'CANADA', awayTeam: 'MAROC', homeWinProbability: 0.33, drawProbability: 0.33, awayWinProbability: 0.34 },
  { id: 2, homeTeam: 'CANADA', awayTeam: 'MOROCCO', homeWinProbability: 0.33, drawProbability: 0.33, awayWinProbability: 0.34 },
  { id: 3, homeTeam: 'BRAZIL', awayTeam: 'NORVÈGE', homeWinProbability: 0.33, drawProbability: 0.33, awayWinProbability: 0.34 }
];

generatePromosportGrids(mockMatches).then(grids => {
  console.log('Successfully generated grids count:', grids.length);
  console.log('Grid 1 First Match Choices:', grids[0].matches[0].choices);
  console.log('Grid 1 Second Match Choices:', grids[0].matches[1].choices);
  console.log('Grid 1 Third Match Choices:', grids[0].matches[2].choices);
  console.log('Grid 1 First Match Probs:', grids[0].matches[0].p1, grids[0].matches[0].px, grids[0].matches[0].p2);
  console.log('Grid 1 Second Match Probs:', grids[0].matches[1].p1, grids[0].matches[1].px, grids[0].matches[1].p2);
  console.log('Grid 1 Third Match Probs:', grids[0].matches[2].p1, grids[0].matches[2].px, grids[0].matches[2].p2);
}).catch(e => console.error(e)).finally(() => process.exit());
