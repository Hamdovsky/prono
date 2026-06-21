/**
 * 🏆 GÉNÉRATEUR COUPON PROMOSPORT — CONCOURS 856
 * Génère directement les 4 grilles IA sans passer par le serveur.
 * Usage: node scripts/generate_coupon_856.js
 */

// ======= DONNÉES RÉELLES CONCOURS 856 (02/05/2026) =======
const matches856 = [
  { id: 1, homeTeam: "VALENCE",             awayTeam: "ATLETICO MADRID",  homeWinProbability: 0.18, drawProbability: 0.18, awayWinProbability: 0.64, matchTime: "sam 15:15", leagueName: "La Liga" },
  { id: 2, homeTeam: "DEPORTIVO ALAVES",    awayTeam: "ATHLETIC BILBAO",  homeWinProbability: 0.44, drawProbability: 0.14, awayWinProbability: 0.42, matchTime: "sam 17:30", leagueName: "La Liga" },
  { id: 3, homeTeam: "LEVERKUSEN",          awayTeam: "RB LEIPZIG",       homeWinProbability: 0.42, drawProbability: 0.18, awayWinProbability: 0.40, matchTime: "sam 17:30", leagueName: "Bundesliga" },
  { id: 4, homeTeam: "HOFFENHEIM",          awayTeam: "STUTTGART",        homeWinProbability: 0.30, drawProbability: 0.32, awayWinProbability: 0.38, matchTime: "sam 14:30", leagueName: "Bundesliga" },
  { id: 5, homeTeam: "EINTRACHT FRANCFORT", awayTeam: "HAMBOURG",         homeWinProbability: 0.68, drawProbability: 0.23, awayWinProbability: 0.09, matchTime: "sam 14:30", leagueName: "Bundesliga" },
  { id: 6, homeTeam: "UNION BERLIN",        awayTeam: "FC COLOGNE",       homeWinProbability: 0.41, drawProbability: 0.44, awayWinProbability: 0.15, matchTime: "sam 14:30", leagueName: "Bundesliga" },
  { id: 7, homeTeam: "WERDER BREME",        awayTeam: "AUGSBURG",         homeWinProbability: 0.33, drawProbability: 0.33, awayWinProbability: 0.34, matchTime: "sam 14:30", leagueName: "Bundesliga" },
  { id: 8, homeTeam: "BAYERN MUNICH",       awayTeam: "HEIDENHEIM",       homeWinProbability: 0.72, drawProbability: 0.21, awayWinProbability: 0.07, matchTime: "sam 14:30", leagueName: "Bundesliga" },
  { id: 9, homeTeam: "WOLVERHAMPTON",       awayTeam: "SUNDERLAND",       homeWinProbability: 0.27, drawProbability: 0.18, awayWinProbability: 0.55, matchTime: "sam 14:30", leagueName: "Premier League" },
  { id: 10, homeTeam: "BRENTFORD",          awayTeam: "WEST HAM",         homeWinProbability: 0.34, drawProbability: 0.17, awayWinProbability: 0.49, matchTime: "sam 14:30", leagueName: "Premier League" },
  { id: 11, homeTeam: "EVERTON",            awayTeam: "IPSWICH TOWN",     homeWinProbability: 0.17, drawProbability: 0.36, awayWinProbability: 0.47, matchTime: "sam 14:30", leagueName: "Premier League" },
  { id: 12, homeTeam: "ARSENAL",            awayTeam: "MANCHESTER CITY",  homeWinProbability: 0.66, drawProbability: 0.20, awayWinProbability: 0.14, matchTime: "sam 14:30", leagueName: "Premier League" },
  { id: 13, homeTeam: "BRIGHTON",           awayTeam: "MANCHESTER UTD",   homeWinProbability: 0.38, drawProbability: 0.24, awayWinProbability: 0.38, matchTime: "sam 14:30", leagueName: "Premier League" },
];

// ======= MOTEUR AI (copie légère du core/promosport_engine.js) =======
function seededRand(seed) {
  let hash = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function generateGrids(matches) {
  const enriched = matches.map(m => {
    const p1 = m.homeWinProbability;
    const px = m.drawProbability;
    const p2 = m.awayWinProbability;
    const H = -(p1 * Math.log2(p1 || 0.01) + px * Math.log2(px || 0.01) + p2 * Math.log2(p2 || 0.01));
    const crowdP1 = m.homeWinProbability || 0.33;
    const isCrowdTrap = (crowdP1 - p1 > 0.20 && p1 < 0.50);
    const confidence = 80 - (H * 15);
    return { ...m, p1, px, p2, entropy: H, confidence, isCrowdTrap,
      intel: {
        form: Math.round(60 + seededRand(`${m.homeTeam}_form`) * 20),
        logistics: Math.round(70 + seededRand(`${m.awayTeam}_logistics`) * 10),
        motivation: 75,
        sharp: Math.round(confidence)
      }
    };
  });

  const gridConfigs = [
    { id: 'T1', name: 'TITANIUM AI (OPTIMIZED)',    doubles: 5, bias: 'fav'   },
    { id: 'T2', name: 'EXPERT VALUE (DRAW BIAS)',   doubles: 4, bias: 'draw'  },
    { id: 'T3', name: 'SÉCURITÉ (BANKER FOCUS)',    doubles: 3, bias: 'safe'  },
    { id: 'T4', name: 'COUVERTURE (ANTI-CROWD)',    doubles: 3, bias: 'upset' },
  ];

  return gridConfigs.map((cfg, gIdx) => {
    const doubleIds = [...enriched]
      .sort((a, b) => {
        const tA = a.isCrowdTrap ? 10 : 0;
        const tB = b.isCrowdTrap ? 10 : 0;
        const bias = (Math.sin(gIdx + (a.id * 0.7)) * 0.4);
        return (b.entropy + tB + bias) - (a.entropy + tA);
      })
      .slice(0, cfg.doubles).map(m => m.id);

    const gridMatches = enriched.map(m => {
      const isDouble = doubleIds.includes(m.id);
      let choices = [];

      if (cfg.bias === 'safe') {
        const max = Math.max(m.p1, m.px, m.p2);
        choices.push(m.p1 === max ? '1' : (m.p2 === max ? '2' : 'X'));
      } else if (cfg.bias === 'draw') {
        if (m.px > 0.30) choices.push('X'); else choices.push(m.p1 > m.p2 ? '1' : '2');
      } else if (cfg.bias === 'upset') {
        if (m.p1 > 0.65) choices.push('1');
        else if (m.p2 > 0.25) choices.push('2');
        else choices.push('X');
      } else {
        if (m.p1 > 0.45) choices.push('1');
        else if (m.p2 > 0.40) choices.push('2');
        else choices.push('X');
      }

      if (isDouble) {
        const probs = [{v:'1',p:m.p1},{v:'X',p:m.px},{v:'2',p:m.p2}].sort((a,b)=>b.p-a.p);
        const first = choices[0];
        let second;
        if (cfg.bias === 'upset' && !choices.includes('2')) second = '2';
        else if (cfg.bias === 'draw' && !choices.includes('X')) second = 'X';
        else second = (probs[0].v === first) ? probs[1].v : probs[0].v;
        choices.push(second);
      }

      choices = [...new Set(choices)].sort((a,b) => ({'1':0,'X':1,'2':2}[a] - {'1':0,'X':1,'2':2}[b]));
      return { id: m.id, home: m.homeTeam, away: m.awayTeam, choices, isDouble };
    });

    return { name: cfg.name, doubles: cfg.doubles, matches: gridMatches };
  });
}

// ======= AFFICHAGE =======
function pad(str, len) { return String(str).padEnd(len); }
function center(str, len) { const s = String(str); const pad = Math.max(0, len - s.length); return ' '.repeat(Math.floor(pad/2)) + s + ' '.repeat(Math.ceil(pad/2)); }

const grids = generateGrids(matches856);
const lines = [];

lines.push('');
lines.push('╔══════════════════════════════════════════════════════════════════════════════════════════════╗');
lines.push('║          ⚽  TITANIUM PROMOSPORT AI — CONCOURS No 856  —  02/05/2026 (14:30)             ║');
lines.push('║              Saison 2024-2025  |  La Liga, Bundesliga, Premier League                       ║');
lines.push('╠══════════════════════════════════════════════════════════════════════════════════════════════╣');
lines.push(`║  ${'N°'.padEnd(4)} ${'Équipe 1'.padEnd(24)} ${'%1'.padEnd(5)} ${'%X'.padEnd(5)} ${'%2'.padEnd(5)}  ║  ${'Grille 1'.padEnd(12)} ${'Grille 2'.padEnd(12)} ${'Grille 3'.padEnd(12)} ${'Grille 4'.padEnd(10)}║`);
lines.push('╠══════════════════════════════════════════════════════════════════════════════════════════════╣');

matches856.forEach((m, idx) => {
  const g1 = grids[0].matches[idx].choices.join('');
  const g2 = grids[1].matches[idx].choices.join('');
  const g3 = grids[2].matches[idx].choices.join('');
  const g4 = grids[3].matches[idx].choices.join('');
  const isD1 = grids[0].matches[idx].isDouble;
  const isD2 = grids[1].matches[idx].isDouble;
  const isD3 = grids[2].matches[idx].isDouble;
  const isD4 = grids[3].matches[idx].isDouble;
  const tag1 = isD1 ? '🔵' : '  ';
  const tag2 = isD2 ? '🔵' : '  ';
  const tag3 = isD3 ? '🔵' : '  ';
  const tag4 = isD4 ? '🔵' : '  ';

  lines.push(`║  ${String(m.id).padEnd(4)} ${(m.homeTeam+' vs '+m.awayTeam).substring(0,24).padEnd(24)} ${String(Math.round(m.homeWinProbability*100)+'%').padEnd(5)} ${String(Math.round(m.drawProbability*100)+'%').padEnd(5)} ${String(Math.round(m.awayWinProbability*100)+'%').padEnd(5)}  ║  ${tag1}${g1.padEnd(10)} ${tag2}${g2.padEnd(10)} ${tag3}${g3.padEnd(10)} ${tag4}${g4.padEnd(8)}║`);
});

lines.push('╠══════════════════════════════════════════════════════════════════════════════════════════════╣');
grids.forEach((g, i) => {
  lines.push(`║  GRILLE ${i+1}: ${g.name.padEnd(32)} → ${g.doubles} DOUBLES  (🔵 = double chance)                       ║`);
});
lines.push('╚══════════════════════════════════════════════════════════════════════════════════════════════╝');
lines.push('');
lines.push('📊 ANALYSE MATCHS CLÉS:');
lines.push('  ▸ Match 1  — VALENCE vs ATLETICO (18/18/64%) → PIÈGE: Atlético favori écrasant, prendre 2');
lines.push('  ▸ Match 5  — EINTRACHT vs HAMBOURG (68/23/09%) → BANKER 1: Eintracht domicile fort');
lines.push('  ▸ Match 8  — BAYERN vs HEIDENHEIM (72/21/07%) → BANKER 1: Bayern Bundesliga massif');
lines.push('  ▸ Match 12 — ARSENAL vs MAN CITY (66/20/14%) → BANKER 1: Gunners à l\'Emirates');
lines.push('  ▸ Match 7  — WERDER vs AUGSBURG (33/33/34%) → DOUBLE OBLIGATOIRE: Équilibre total');
lines.push('');

console.log(lines.join('\n'));

// Aussi sauvegarder en JSON
const output = {
  concours: '856',
  date: '02/05/2026',
  saison: '2024-2025',
  grids: grids.map((g, i) => ({
    numero: i + 1,
    nom: g.name,
    doubles: g.doubles,
    pronostics: g.matches.map(m => ({
      id: m.id,
      home: m.home,
      away: m.away,
      prono: m.choices.join(''),
      double: m.isDouble
    }))
  }))
};

const fs = require('fs');
const outPath = './scripts/data/coupon_856.json';
fs.mkdirSync('./scripts/data', { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\n✅ Coupon 856 sauvegardé → ${outPath}\n`);
