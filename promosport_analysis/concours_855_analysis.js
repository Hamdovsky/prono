/**
 * PROMOSPORT CONCOURS 855 — ANALYSE INTELLIGENTE
 * Croisement ADN historique + Probabilités des matchs réels
 * Date: 29-30 Avril 2026
 */

const matches = [
  { id: 1, home: "Atletico Madrid", away: "Arsenal",        league: "Champions League",  p1: 30, pX: 28, p2: 42 },
  { id: 2, home: "Braga",           away: "Freiburg",       league: "Europa League",     p1: 45, pX: 19, p2: 36 },
  { id: 3, home: "Nottingham F.",   away: "Aston Villa",    league: "Premier League",    p1: 32, pX: 22, p2: 46 },
  { id: 4, home: "Rayo Vallecano",  away: "Strasbourg",     league: "Amical",            p1: 54, pX: 16, p2: 30 },
  { id: 5, home: "Shakhtar",        away: "Crystal Palace", league: "Amical",            p1: 47, pX: 17, p2: 36 },
  { id: 6, home: "Al Nassr",        away: "Al Ahli",        league: "Saudi Pro League",  p1: 54, pX: 16, p2: 30 },
  { id: 7, home: "FAR Rabat",       away: "Raja Casablanca",league: "Maroc Botola",      p1: 35, pX: 39, p2: 26 },
  { id: 8, home: "Esperance",       away: "CS Sfaxien",     league: "Tunisie L1",        p1: 56, pX: 16, p2: 28 },
  { id: 9, home: "JS Kairouanaise", away: "Ben Guerdane",   league: "Tunisie L1",        p1: 30, pX: 33, p2: 37 },
  { id: 10, home: "O. Beja",        away: "CA Bizertin",    league: "Tunisie L1",        p1: 28, pX: 39, p2: 33 },
  { id: 11, home: "Universitario",  away: "Nacional",       league: "Copa Libertadores", p1: 27, pX: 27, p2: 46 },
  { id: 12, home: "Cerro Porteno",  away: "Palmeiras",      league: "Copa Libertadores", p1: 19, pX: 20, p2: 61 },
  { id: 13, home: "Estudiantes",    away: "Flamengo",       league: "Copa Libertadores", p1: 21, pX: 25, p2: 54 },
];

// ADN historique par position (sur 48 concours)
const dnaByPos = [
  { pos: 1,  p1: 39.6, pX: 18.8, p2: 41.7, bestDC: "12", dcRate: 81.3 },
  { pos: 2,  p1: 39.6, pX: 20.8, p2: 39.6, bestDC: "12", dcRate: 79.2 },
  { pos: 3,  p1: 41.7, pX: 25.0, p2: 33.3, bestDC: "12", dcRate: 75.0 },
  { pos: 4,  p1: 33.3, pX: 31.3, p2: 35.4, bestDC: "12", dcRate: 68.8 },
  { pos: 5,  p1: 39.6, pX: 20.8, p2: 39.6, bestDC: "12", dcRate: 79.2 },
  { pos: 6,  p1: 45.8, pX: 16.7, p2: 37.5, bestDC: "12", dcRate: 83.3 },
  { pos: 7,  p1: 54.2, pX: 22.9, p2: 22.9, bestDC: "1X", dcRate: 77.1 },
  { pos: 8,  p1: 43.8, pX: 22.9, p2: 33.3, bestDC: "12", dcRate: 77.1 },
  { pos: 9,  p1: 33.3, pX: 31.3, p2: 35.4, bestDC: "12", dcRate: 68.8 },
  { pos: 10, p1: 39.6, pX: 31.3, p2: 29.2, bestDC: "1X", dcRate: 70.8 },
  { pos: 11, p1: 45.8, pX: 25.0, p2: 29.2, bestDC: "12", dcRate: 75.0 },
  { pos: 12, p1: 37.5, pX: 27.1, p2: 35.4, bestDC: "12", dcRate: 72.9 },
  { pos: 13, p1: 37.5, pX: 27.1, p2: 35.4, bestDC: "12", dcRate: 72.9 },
];

console.log('\n' + '═'.repeat(80));
console.log('  🔮 CONCOURS 855 — ANALYSE INTELLIGENTE CROISÉE');
console.log('  PromosportPlus.com | 29-30 Avril 2026');
console.log('═'.repeat(80));

// ─────────────────────────────────────────────────────────────────────
// SCORE COMBINÉ: ADN + Stats du Match
// ─────────────────────────────────────────────────────────────────────
function computeScore(match, dna) {
  // Score pour chaque signe = 0.5*match_stats + 0.5*adn_historique
  const s1 = 0.5 * match.p1 + 0.5 * dna.p1;
  const sX = 0.5 * match.pX + 0.5 * dna.pX;
  const s2 = 0.5 * match.p2 + 0.5 * dna.p2;
  return { s1, sX, s2 };
}

// Calcul de l'incertitude (plus les 3 scores sont proches, plus c'est incertain)
function computeUncertainty(s1, sX, s2) {
  const max = Math.max(s1, sX, s2);
  const min = Math.min(s1, sX, s2);
  return 100 - (max - min); // plus haut = plus incertain
}

console.log('\n📊 ANALYSE CROISÉE (ADN historique × Statistiques du match)\n');
console.log('  M# | Rencontre                          | Score 1 | Score X | Score 2 | Favori | Incert.');
console.log('─'.repeat(95));

const analysis = matches.map((m, i) => {
  const dna = dnaByPos[i];
  const { s1, sX, s2 } = computeScore(m, dna);
  const uncertainty = computeUncertainty(s1, sX, s2);
  const sorted = [['1', s1], ['X', sX], ['2', s2]].sort((a,b) => b[1]-a[1]);
  const favori = sorted[0][0];
  
  // Meilleures DC pour ce match (combinaison des 2 signes les + probables)
  const dcOptions = [
    { name: '1X', score: s1+sX },
    { name: 'X2', score: sX+s2 },
    { name: '12', score: s1+s2 },
  ].sort((a,b) => b.score - a.score);
  
  const matchName = `${m.home} vs ${m.away}`;
  const shortName = matchName.length > 34 ? matchName.substring(0, 33)+'…' : matchName;
  
  console.log(
    `  M${String(m.id).padStart(2)} | ${shortName.padEnd(35)} | ${s1.toFixed(1).padStart(5)}%  | ${sX.toFixed(1).padStart(5)}%  | ${s2.toFixed(1).padStart(5)}%  |   ${favori}   | ${uncertainty.toFixed(1)}%`
  );
  
  return { ...m, s1, sX, s2, uncertainty, favori, bestDC: dcOptions[0].name, bestDCScore: dcOptions[0].score, dna };
});

// ─────────────────────────────────────────────────────────────────────
// SÉLECTION DES 5 MEILLEURES DC
// Critère: les 5 matchs avec la plus forte INCERTITUDE combinée
// ─────────────────────────────────────────────────────────────────────
console.log('\n\n🎯 SÉLECTION OPTIMALE DES 5 DOUBLES CHANCES\n');

// Facteur d'incertitude combinée: ADN incertitude + match incertitude
const sortedByUncertainty = [...analysis].sort((a,b) => b.uncertainty - a.uncertainty);
const top5 = sortedByUncertainty.slice(0, 5);
const top5Ids = new Set(top5.map(t => t.id));

console.log('  Matchs les plus incertains → DOUBLE CHANCE recommandée:\n');
console.log('  Rang | M# | Rencontre                     | DC     | Couverture | Raison');
console.log('─'.repeat(85));
top5.sort((a,b) => a.id - b.id).forEach((m, rank) => {
  const shortName = `${m.home} vs ${m.away}`;
  const truncName = shortName.length > 28 ? shortName.substring(0,27)+'…' : shortName;
  // Couverture = pourcentage que la DC couvre
  const coverage = m.bestDC === '1X' ? m.s1 + m.sX :
                   m.bestDC === 'X2' ? m.sX + m.s2 :
                   m.s1 + m.s2;
  const reason = m.bestDC === '1X' ? `1(${m.s1.toFixed(0)}%) ou X(${m.sX.toFixed(0)}%)` :
                 m.bestDC === 'X2' ? `X(${m.sX.toFixed(0)}%) ou 2(${m.s2.toFixed(0)}%)` :
                 `1(${m.s1.toFixed(0)}%) ou 2(${m.s2.toFixed(0)}%)`;
  console.log(`  #${rank+1}   | M${String(m.id).padStart(2)} | ${truncName.padEnd(28)} | ${m.bestDC.padEnd(6)} | ${coverage.toFixed(1).padStart(5)}%     | ${reason}`);
});

// ─────────────────────────────────────────────────────────────────────
// TICKET FINAL CONCOURS 855
// ─────────────────────────────────────────────────────────────────────
console.log('\n\n╔' + '═'.repeat(78) + '╗');
console.log('║' + '   🏆 TICKET FINAL — CONCOURS 855 PROMOSPORT'.padEnd(78) + '║');
console.log('║' + '   Stratégie: 8 simples + 5 Doubles Chances optimales'.padEnd(78) + '║');
console.log('╠' + '═'.repeat(78) + '╣');
console.log('║  M#  │ Rencontre                              │ Pronostic │ Type               ║');
console.log('╠' + '═'.repeat(78) + '╣');

analysis.forEach(m => {
  const shortName = `${m.home} vs ${m.away}`;
  const truncName = shortName.length > 38 ? shortName.substring(0,37)+'…' : shortName;
  
  let prono, type;
  if (top5Ids.has(m.id)) {
    prono = m.bestDC;
    type = '🎯 DOUBLE CHANCE   ';
  } else {
    prono = m.favori;
    type = `Simple (${m[`s${m.favori.toLowerCase()}`]?.toFixed(0) || '—'}%)         `;
    type = type.substring(0, 19);
  }
  
  console.log(`║  M${String(m.id).padStart(2)} │ ${truncName.padEnd(38)} │ ${prono.padEnd(9)} │ ${type} ║`);
});

console.log('╠' + '═'.repeat(78) + '╣');

// Calcul couverture globale du ticket
let totalCoverage = 1.0;
analysis.forEach(m => {
  if (top5Ids.has(m.id)) {
    const cov = m.bestDC === '1X' ? (m.s1+m.sX)/100 :
                m.bestDC === 'X2' ? (m.sX+m.s2)/100 :
                (m.s1+m.s2)/100;
    totalCoverage *= cov;
  } else {
    totalCoverage *= (m[`s${m.favori === 'X' ? 'X' : m.favori}`] / 100);
  }
});

console.log(`║  📊 Couverture probabiliste globale du ticket: ${(totalCoverage*100).toFixed(4)}%`.padEnd(79) + '║');
console.log('║  ⚙️  Basé sur: 48 concours historiques + stats matchs réels'.padEnd(79) + '║');
console.log('╚' + '═'.repeat(78) + '╝');

// ─────────────────────────────────────────────────────────────────────
// ALERTES SPÉCIALES
// ─────────────────────────────────────────────────────────────────────
console.log('\n⚠️  ALERTES & OBSERVATIONS CLÉS:\n');

const alerts = [];
if (analysis[6].p1 > 50 && analysis[6].dna.p1 > 50) alerts.push('✅ M7 (FAR vs Raja): Double tendance domicile forte — Simple 1 très fiable (54% match + 54% ADN)');
if (analysis[7].p1 > 50) alerts.push('✅ M8 (Esperance vs Sfaxien): Domicile favori fort (56%) — DC 12 sécurisée');
if (analysis[11].p2 > 55) alerts.push('⚡ M12 (Cerro vs Palmeiras): 2 très fort (61%) — Palmeiras favori extérieur clair');
if (analysis[12].p2 > 50) alerts.push('⚡ M13 (Estudiantes vs Flamengo): 2 fort (54%) — Flamengo favori extérieur');
if (analysis[6].pX > 35) alerts.push('⚠️  M7 (FAR vs Raja): X élevé (39%) — Match nul fréquent dans les derbys marocains');
if (analysis[9].pX > 35) alerts.push('⚠️  M10 (O.Beja vs CA Bizertin): X élevé (39%) — Incertitude Ligue 1 Tunisie');

alerts.forEach(a => console.log(`  ${a}`));

console.log('\n' + '═'.repeat(80) + '\n');
