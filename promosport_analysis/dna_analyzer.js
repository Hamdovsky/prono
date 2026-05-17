/**
 * PROMOSPORT DNA ANALYZER
 * Analyse l'empreinte ADN de la compétition Promosport
 * sur 50 concours historiques (No. 805 -> 854)
 */

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'historical_data.json'), 'utf8'));
const competitions = data.competitions.filter(c => !c.results.includes('-') && c.results.every(r => ['1','X','2'].includes(r)));

console.log(`\n${'='.repeat(70)}`);
console.log('  🧬 PROMOSPORT DNA FINGERPRINT ANALYZER');
console.log(`  Analyse de ${competitions.length} concours valides`);
console.log(`${'='.repeat(70)}\n`);

const MATCHES = 13;
const totalMatches = competitions.length * MATCHES;

// ─────────────────────────────────────────────────────────────
// 1. FRÉQUENCES GLOBALES
// ─────────────────────────────────────────────────────────────
let global = { '1': 0, 'X': 0, '2': 0 };
competitions.forEach(c => c.results.forEach(r => global[r]++));
const totalResults = competitions.length * MATCHES;

console.log('📊 1. FRÉQUENCES GLOBALES (ADN de base)');
console.log('─'.repeat(50));
['1','X','2'].forEach(sign => {
  const pct = ((global[sign] / totalResults) * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(pct / 2));
  console.log(`  ${sign} : ${global[sign].toString().padStart(4)} / ${totalResults}  (${pct.padStart(5)}%) ${bar}`);
});

// ─────────────────────────────────────────────────────────────
// 2. FRÉQUENCES PAR POSITION (match 1 à 13)
// ─────────────────────────────────────────────────────────────
console.log('\n📍 2. FRÉQUENCES PAR POSITION (Match 1 → 13)');
console.log('─'.repeat(70));
console.log('  Match |  1 (%)  |  X (%)  |  2 (%)  | Favori  | DC Optimale');
console.log('─'.repeat(70));

const positionStats = [];
for (let pos = 0; pos < MATCHES; pos++) {
  const counts = { '1': 0, 'X': 0, '2': 0 };
  competitions.forEach(c => counts[c.results[pos]]++);
  const total = competitions.length;
  const p1 = (counts['1'] / total * 100).toFixed(1);
  const pX = (counts['X'] / total * 100).toFixed(1);
  const p2 = (counts['2'] / total * 100).toFixed(1);
  
  const sorted = [['1', counts['1']], ['X', counts['X']], ['2', counts['2']]].sort((a,b) => b[1]-a[1]);
  const favori = sorted[0][0];
  
  // Double chance optimale = les 2 signes les plus fréquents
  const dc = sorted[0][0] + sorted[1][0];
  const dcPct = ((sorted[0][1] + sorted[1][1]) / total * 100).toFixed(1);
  
  positionStats.push({ pos: pos+1, counts, p1, pX, p2, favori, dc, dcPct });
  console.log(`  M${String(pos+1).padStart(2)}   |${p1.padStart(7)}%|${pX.padStart(7)}%|${p2.padStart(7)}%|  ${favori}      | ${dc} (${dcPct}%)`);
}

// ─────────────────────────────────────────────────────────────
// 3. DISTRIBUTION PAR CONCOURS
// ─────────────────────────────────────────────────────────────
console.log('\n🎲 3. DISTRIBUTION PAR CONCOURS (nb de 1, X, 2 par ticket)');
console.log('─'.repeat(50));
let distrib = {};
competitions.forEach(c => {
  const counts = { '1': 0, 'X': 0, '2': 0 };
  c.results.forEach(r => counts[r]++);
  const key = `1×${counts['1']} X×${counts['X']} 2×${counts['2']}`;
  distrib[key] = (distrib[key] || 0) + 1;
});
const sortedDistrib = Object.entries(distrib).sort((a,b) => b[1]-a[1]).slice(0, 15);
sortedDistrib.forEach(([k, v]) => {
  const pct = (v / competitions.length * 100).toFixed(1);
  console.log(`  ${k.padEnd(20)} → ${v}x  (${pct}%)`);
});

// ─────────────────────────────────────────────────────────────
// 4. SÉQUENCES CONSÉCUTIVES
// ─────────────────────────────────────────────────────────────
console.log('\n🔁 4. SÉQUENCES RÉPÉTÉES (même signe sur positions consécutives)');
console.log('─'.repeat(60));
let maxStreak = { sign: '', len: 0, pos: 0, comp: 0 };
competitions.forEach(c => {
  let streak = 1;
  for (let i = 1; i < MATCHES; i++) {
    if (c.results[i] === c.results[i-1]) {
      streak++;
      if (streak > maxStreak.len) maxStreak = { sign: c.results[i], len: streak, pos: i-streak+2, comp: c.id };
    } else {
      streak = 1;
    }
  }
});
console.log(`  Plus longue séquence: "${maxStreak.sign}" × ${maxStreak.len} fois`);
console.log(`  → Concours No.${maxStreak.comp}, débutant en position ${maxStreak.pos}`);

// ─────────────────────────────────────────────────────────────
// 5. NOMBRE MOYEN DE CHAQUE SIGNE PAR TICKET
// ─────────────────────────────────────────────────────────────
console.log('\n📈 5. MOYENNE PAR TICKET');
console.log('─'.repeat(50));
const avg1 = (global['1'] / competitions.length).toFixed(2);
const avgX = (global['X'] / competitions.length).toFixed(2);
const avg2 = (global['2'] / competitions.length).toFixed(2);
console.log(`  Victoire Domicile (1) : ${avg1} matches par ticket`);
console.log(`  Nul          (X)      : ${avgX} matches par ticket`);
console.log(`  Victoire Extérieur(2) : ${avg2} matches par ticket`);

// ─────────────────────────────────────────────────────────────
// 6. TENDANCES RÉCENTES (10 derniers concours)
// ─────────────────────────────────────────────────────────────
const recent = competitions.slice(0, 10);
const recentGlobal = { '1': 0, 'X': 0, '2': 0 };
recent.forEach(c => c.results.forEach(r => recentGlobal[r]++));
const recentTotal = recent.length * MATCHES;

console.log('\n🔥 6. TENDANCES RÉCENTES (10 derniers concours)');
console.log('─'.repeat(50));
['1','X','2'].forEach(sign => {
  const pct = (recentGlobal[sign] / recentTotal * 100).toFixed(1);
  const globalPct = (global[sign] / totalResults * 100).toFixed(1);
  const diff = (parseFloat(pct) - parseFloat(globalPct)).toFixed(1);
  const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
  console.log(`  ${sign} : ${pct}% (global: ${globalPct}%) ${arrow} ${Math.abs(diff)}%`);
});

// ─────────────────────────────────────────────────────────────
// 7. ANALYSE DES DOUBLES CHANCES PAR POSITION
// ─────────────────────────────────────────────────────────────
console.log('\n🎯 7. MEILLEURES DOUBLES CHANCES PAR POSITION');
console.log('─'.repeat(70));
console.log('  Match | 1X (%) | X2 (%) | 12 (%) | ✅ RECOMMANDÉE');
console.log('─'.repeat(70));

const dcRecommendations = [];
for (let pos = 0; pos < MATCHES; pos++) {
  const counts = { '1': 0, 'X': 0, '2': 0 };
  competitions.forEach(c => counts[c.results[pos]]++);
  const n = competitions.length;
  
  const pct1X = ((counts['1'] + counts['X']) / n * 100).toFixed(1);
  const pctX2 = ((counts['X'] + counts['2']) / n * 100).toFixed(1);
  const pct12 = ((counts['1'] + counts['2']) / n * 100).toFixed(1);
  
  const best = [['1X', parseFloat(pct1X)], ['X2', parseFloat(pctX2)], ['12', parseFloat(pct12)]].sort((a,b) => b[1]-a[1])[0];
  dcRecommendations.push({ pos: pos+1, best: best[0], bestPct: best[1], pct1X, pctX2, pct12, counts });
  
  console.log(`  M${String(pos+1).padStart(2)}   |${pct1X.padStart(6)}%|${pctX2.padStart(6)}%|${pct12.padStart(6)}%| ✅ ${best[0]} (${best[1]}%)`);
}

// ─────────────────────────────────────────────────────────────
// 8. SÉLECTION DES 5 MEILLEURES DOUBLES CHANCES
// ─────────────────────────────────────────────────────────────
console.log('\n\n🏆 8. TOP 5 POSITIONS POUR DOUBLE CHANCE (PROCHAIN TICKET)');
console.log('═'.repeat(70));

// Score = pct de la DC la plus forte, mais on favorise les positions 
// où le signe le plus rare est entre 25-45% (vraie incertitude)
const scored = dcRecommendations.map(d => {
  const counts = d.counts;
  const n = competitions.length;
  const uncertainty = 1 - Math.max(counts['1'], counts['X'], counts['2']) / n; // plus élevé = plus incertain
  const score = d.bestPct * (1 + uncertainty * 0.3);
  return { ...d, uncertainty: (uncertainty * 100).toFixed(1), score };
}).sort((a,b) => b.score - a.score);

const top5 = scored.slice(0, 5);
console.log('\n  Pos | DC      | Taux  | Incertitude | Raison');
console.log('─'.repeat(70));
top5.forEach((d, i) => {
  const counts = d.counts;
  const n = competitions.length;
  const sorted = [['1', counts['1']], ['X', counts['X']], ['2', counts['2']]].sort((a,b) => b[1]-a[1]);
  const reason = `${sorted[0][0]}(${(sorted[0][1]/n*100).toFixed(0)}%) ou ${sorted[1][0]}(${(sorted[1][1]/n*100).toFixed(0)}%)`;
  console.log(`  #${i+1}  M${String(d.pos).padStart(2)} | ${d.best}   | ${String(d.bestPct).padStart(5)}% | ${String(d.uncertainty).padStart(9)}%   | ${reason}`);
});

// ─────────────────────────────────────────────────────────────
// 9. PRONOSTIC TICKET SUIVANT (Concours 855)
// ─────────────────────────────────────────────────────────────
console.log('\n\n🔮 9. PRONOSTIC INTELLIGENT - CONCOURS 855');
console.log('═'.repeat(70));
console.log('\n  Stratégie: Signe le plus probable par position + 5 DC sur les matchs incertains\n');

const top5Positions = new Set(top5.map(d => d.pos));
console.log('  Match | Pronostic | Type');
console.log('─'.repeat(40));
for (let pos = 0; pos < MATCHES; pos++) {
  const stat = positionStats[pos];
  const counts = stat.counts;
  const n = competitions.length;
  const sorted = [['1', counts['1']], ['X', counts['X']], ['2', counts['2']]].sort((a,b) => b[1]-a[1]);
  
  if (top5Positions.has(pos+1)) {
    const dcStat = dcRecommendations[pos];
    console.log(`  M${String(pos+1).padStart(2)}   | ${dcStat.best}      | 🎯 DOUBLE CHANCE`);
  } else {
    console.log(`  M${String(pos+1).padStart(2)}   | ${sorted[0][0]}        | Simple (${(sorted[0][1]/n*100).toFixed(0)}%)`);
  }
}

// ─────────────────────────────────────────────────────────────
// 10. RÉSUMÉ ADN
// ─────────────────────────────────────────────────────────────
console.log('\n\n🧬 10. RÉSUMÉ ADN DE LA COMPÉTITION PROMOSPORT');
console.log('═'.repeat(70));
console.log(`\n  ✅ 13 matches par concours`);
console.log(`  ✅ Distribution moyenne: 1≈${avg1} | X≈${avgX} | 2≈${avg2} par ticket`);
console.log(`  ✅ Signe le plus fréquent: "1" (${((global['1']/totalResults)*100).toFixed(1)}%)`);
console.log(`  ✅ Nuls (X): ${((global['X']/totalResults)*100).toFixed(1)}% - ATTENTION zone incertaine`);
console.log(`  ✅ 5 DC optimales: Positions ${[...top5Positions].sort((a,b)=>a-b).join(', ')}`);
console.log(`\n${'═'.repeat(70)}\n`);

// Sauvegarde du rapport
const report = {
  analysisDate: new Date().toISOString(),
  competitionsAnalyzed: competitions.length,
  globalFrequencies: {
    '1': { count: global['1'], pct: ((global['1']/totalResults)*100).toFixed(1) },
    'X': { count: global['X'], pct: ((global['X']/totalResults)*100).toFixed(1) },
    '2': { count: global['2'], pct: ((global['2']/totalResults)*100).toFixed(1) }
  },
  averagePerTicket: { '1': avg1, 'X': avgX, '2': avg2 },
  top5DCPositions: top5.map(d => ({ position: d.pos, dc: d.best, successRate: d.bestPct })),
  positionStats: positionStats,
  nextCouponPrediction: {
    competition: 855,
    matches: Array.from({length: MATCHES}, (_, pos) => {
      const dcStat = dcRecommendations[pos];
      const stat = positionStats[pos];
      const counts = stat.counts;
      const n = competitions.length;
      const sorted = [['1', counts['1']], ['X', counts['X']], ['2', counts['2']]].sort((a,b) => b[1]-a[1]);
      if (top5Positions.has(pos+1)) {
        return { match: pos+1, prediction: dcStat.best, type: 'double_chance', successRate: dcStat.bestPct };
      } else {
        return { match: pos+1, prediction: sorted[0][0], type: 'simple', successRate: (sorted[0][1]/n*100).toFixed(1) };
      }
    })
  }
};

fs.writeFileSync(path.join(__dirname, 'dna_report.json'), JSON.stringify(report, null, 2));
console.log('  📁 Rapport sauvegardé dans dna_report.json\n');
