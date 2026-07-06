const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../core/logger');

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');

const GRID_NAMES = ['T1', 'T2', 'T3', 'T4'];

function getDb() {
  return new Database(ARCHIVE_PATH);
}

function seededRand(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  return () => {
    h = (h * 16807) % 2147483647;
    return (h - 1) / 2147483646;
  };
}

function splitMatchesIntoBands(matches) {
  const sorted = [...matches].sort((a, b) => a.entropy - b.entropy);
  const n = sorted.length;
  return {
    easy: sorted.slice(0, 4),
    medium: sorted.slice(4, 10),
    hard: sorted.slice(10)
  };
}

function assignDoubles(processedMatches) {
  const choices = { T1: [], T2: [], T3: [], T4: [] };
  const assign = {};

  // Rank by uncertainty (entropy + confidence adjustment)
  const ranked = processedMatches.map(m => ({
    ...m,
    uncertainty: m.entropy - (m.confidence / 100) * 0.5
  })).sort((a, b) => b.uncertainty - a.uncertainty)

  // Top 3 = core doubles (all 4 grids)
  const core = ranked.slice(0, 3)

  // Rest: determine singles based on confidence threshold
  const candidates = ranked.slice(3)
  candidates.sort((a, b) => b.confidence - a.confidence)
  const MIN_CONF_SINGLE = 75
  const singles = candidates.filter(c => c.confidence >= MIN_CONF_SINGLE).slice(0, 4)
  const mediums = candidates.filter(c => !singles.find(s => s.idx === c.idx))

  // Core: all 4 grids double
  for (const m of core) {
    assign[m.idx] = [];
    for (const g of GRID_NAMES) {
      const top2 = [m.probs[0] > m.probs[2] ? '1' : '2', m.probs[1] > Math.max(m.probs[0], m.probs[2]) ? 'X' : (m.probs[0] > m.probs[2] ? '2' : '1')]
        .filter((v, i, a) => a.indexOf(v) === i).slice(0, 2)
      if (top2.length < 2) top2.push(['1', 'X', '2'].find(v => v !== top2[0]))
      choices[g].push({ matchIdx: m.idx, picks: top2 });
      assign[m.idx].push(g);
    }
  }

  // Medium: each doubled by exactly 2 grids (round-robin)
  for (let i = 0; i < mediums.length; i++) {
    const m = mediums[i];
    const gridPair = [GRID_NAMES[i % 4], GRID_NAMES[(i + 2) % 4]];
    const top2 = m.probs[0] > 0.5 ? ['1', m.probs[1] > m.probs[2] ? 'X' : '2']
      : m.probs[2] > 0.5 ? ['2', m.probs[1] > m.probs[0] ? 'X' : '1']
      : ['1', '2'];
    for (const g of gridPair) {
      choices[g].push({ matchIdx: m.idx, picks: top2 });
    }
    assign[m.idx] = gridPair;
  }

  // Singles: only 1 grid, 1 pick
  for (let i = 0; i < singles.length; i++) {
    const m = singles[i];
    const grid = GRID_NAMES[i];
    const pick = m.probs[0] > 0.6 ? ['1'] : m.probs[2] > 0.6 ? ['2'] : ['X'];
    choices[grid].push({ matchIdx: m.idx, picks: pick });
    assign[m.idx] = [grid];
  }

  return choices;
}

function computeProbsFromVotes(voteH, voteD, voteA) {
  const total = voteH + voteD + voteA;
  if (total === 0) return [0.424, 0.259, 0.317];
  const p1 = voteH / total;
  const px = voteD / total;
  const p2 = voteA / total;
  return [p1, px, p2];
}

function computeProbsFromHistory(teamStatsHome, teamStatsAway) {
  const hw = teamStatsHome?.winRate ?? 0.424;
  const hd = teamStatsHome?.drawRate ?? 0.259;
  const hl = teamStatsHome?.lossRate ?? 0.317;
  const aw = teamStatsAway?.winRate ?? 0.424;
  const ad = teamStatsAway?.drawRate ?? 0.259;
  const al = teamStatsAway?.lossRate ?? 0.317;

  const p1 = hw * 0.5 + al * 0.3 + 0.424 * 0.2;
  const p2 = aw * 0.5 + hl * 0.3 + 0.317 * 0.2;
  const px = (hd + ad) * 0.4 + 0.259 * 0.2;
  const total = p1 + px + p2;
  return [p1 / total, px / total, p2 / total];
}

function getTeamStats(db, teamName) {
  const row = db.prepare(`
    SELECT
      COUNT(*) as games,
      SUM(CASE WHEN result = '1' AND homeTeam = ? THEN 1
               WHEN result = '2' AND awayTeam = ? THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result = 'X' THEN 1 ELSE 0 END) as draws
    FROM promosport_archive
    WHERE (homeTeam = ? OR awayTeam = ?) AND result IS NOT NULL AND result != 'N'
  `).get(teamName, teamName, teamName, teamName);

  if (!row || row.games === 0) return null;
  return {
    games: row.games,
    winRate: row.wins / row.games,
    drawRate: row.draws / row.games,
    lossRate: (row.games - row.wins - row.draws) / row.games
  };
}

function computeEntropy(probs) {
  const [p1, px, p2] = probs;
  let H = 0;
  for (const p of [p1, px, p2]) {
    if (p > 0) H -= p * Math.log2(p);
  }
  return H;
}

function backtest() {
  console.log('========================================');
  console.log('  PROMOSPORT BACKTEST ENGINE');
  console.log('========================================\n');

  const db = getDb();

  const concoursList = db.prepare(`
    SELECT DISTINCT concours FROM promosport_archive
    WHERE result IS NOT NULL AND result != 'N'
    ORDER BY concours
  `).all().map(r => r.concours);

  console.log(`Total concours with results: ${concoursList.length}`);

  const allResults = [];
  let totalCorrect = 0;
  let totalMatches = 0;

  for (let ci = 0; ci < concoursList.length; ci++) {
    const concours = concoursList[ci];
    const matches = db.prepare(`
      SELECT * FROM promosport_archive
      WHERE concours = ? AND result IS NOT NULL AND result != 'N'
      ORDER BY match_idx
    `).all(String(concours));

    if (matches.length !== 13) {
      if (matches.length < 10) continue;
    }

    const processed = matches.map(m => {
      const probs = computeProbsFromVotes(m.vote_home || 33, m.vote_draw || 33, m.vote_away || 34);
      const entropy = computeEntropy(probs);
      const confidence = Math.max(50, 80 - (entropy * 15));
      return {
        idx: m.match_idx,
        home: m.homeTeam,
        away: m.awayTeam,
        actual: m.result,
        probs,
        entropy,
        confidence,
        voteH: m.vote_home || 33,
        voteD: m.vote_draw || 33,
        voteA: m.vote_away || 34
      };
    }).sort((a, b) => a.idx - b.idx);

    const gridChoices = assignDoubles(processed);

    const results = GRID_NAMES.map(gridName => {
      const gChoices = gridChoices[gridName];
      let correct = 0;
      let total = 0;
      const details = [];

      for (const choice of gChoices) {
        const match = processed.find(m => m.idx === choice.matchIdx);
        if (!match) continue;
        total++;
        const isCorrect = choice.picks.includes(match.actual);
        if (isCorrect) correct++;
        details.push({
          matchIdx: match.idx,
          home: match.home,
          away: match.away,
          picks: choice.picks,
          actual: match.actual,
          isCorrect
        });
      }

      return {
        concours,
        grid: gridName,
        correct,
        total,
        accuracy: total > 0 ? (correct / total) * 100 : 0,
        details
      };
    });

    for (const r of results) {
      allResults.push(r);
      totalCorrect += r.correct;
      totalMatches += r.total;
    }

    if ((ci + 1) % 20 === 0 || ci === 0 || ci === concoursList.length - 1) {
      const acc = totalMatches > 0 ? (totalCorrect / totalMatches) * 100 : 0;
      console.log(`  Concours ${concours} (${ci + 1}/${concoursList.length}): Grid accs = ${results.map(r => `${r.grid}:${r.accuracy.toFixed(1)}%`).join(', ')} | Running: ${acc.toFixed(1)}%`);
    }
  }

  db.close();

  // Overall stats
  const overall = totalMatches > 0 ? (totalCorrect / totalMatches) * 100 : 0;
  console.log(`\n========================================`);
  console.log(`  BACKTEST RESULTS`);
  console.log(`========================================`);
  console.log(`  Concours tested: ${concoursList.length}`);
  console.log(`  Total match-snapshots: ${totalMatches}`);
  console.log(`  Total correct: ${totalCorrect}`);
  console.log(`  Overall accuracy: ${overall.toFixed(2)}%`);
  console.log();

  // Per-grid stats
  const gridStats = {};
  for (const r of allResults) {
    if (!gridStats[r.grid]) gridStats[r.grid] = { correct: 0, total: 0 };
    gridStats[r.grid].correct += r.correct;
    gridStats[r.grid].total += r.total;
  }

  console.log(`  Per-Grid Accuracy:`);
  for (const g of GRID_NAMES) {
    const s = gridStats[g];
    if (s && s.total > 0) {
      console.log(`    ${g}: ${((s.correct / s.total) * 100).toFixed(2)}% (${s.correct}/${s.total})`);
    }
  }

  // Per-season breakdown (every 50 concours)
  console.log(`\n  Accuracy Trend (per 50 concours):`);
  for (let i = 0; i < allResults.length; i += 50 * 4) {
    const chunk = allResults.slice(i, i + 50 * 4);
    const chunkCorrect = chunk.reduce((s, r) => s + r.correct, 0);
    const chunkTotal = chunk.reduce((s, r) => s + r.total, 0);
    const chunkAcc = chunkTotal > 0 ? (chunkCorrect / chunkTotal) * 100 : 0;
    const chunkConcours = [...new Set(chunk.map(r => r.concours))];
    console.log(`    Concours ${chunkConcours[0] || '?'}-${chunkConcours[chunkConcours.length - 1] || '?'}: ${chunkAcc.toFixed(2)}% (${chunkCorrect}/${chunkTotal})`);
  }

  // Classification par type d'assignation
  console.log(`\n  Accuracy by Assignment Type:`);
  const bands = { single: { correct: 0, total: 0 }, double: { correct: 0, total: 0 } };
  for (const r of allResults) {
    for (const d of r.details) {
      const band = d.picks.length > 1 ? 'double' : 'single';
      bands[band].total++;
      if (d.isCorrect) bands[band].correct++;
    }
  }
  for (const [b, s] of Object.entries(bands)) {
    if (s.total > 0) console.log(`    ${b} (${s.total}): ${((s.correct / s.total) * 100).toFixed(2)}% (${s.correct}/${s.total})`);
  }

  return { concoursCount: concoursList.length, totalMatches, totalCorrect, overallAccuracy: overall };
}

function backtestGoldCoupon() {
  console.log('\n========================================');
  console.log('  GOLD COUPON BACKTEST (6 doubles)');
  console.log('========================================');

  const db = getDb();
  const concoursList = db.prepare(`SELECT DISTINCT concours FROM promosport_archive WHERE result IS NOT NULL AND result != 'N' ORDER BY concours`).all().map(r => r.concours);
  let totalMatches = 0, totalCorrect = 0;

  for (let ci = 0; ci < concoursList.length; ci++) {
    const concours = concoursList[ci];
    const matches = db.prepare(`SELECT * FROM promosport_archive WHERE concours = ? AND result IS NOT NULL AND result != 'N' ORDER BY match_idx`).all(String(concours));
    if (matches.length < 10) continue;

    const processed = matches.map(m => {
      const probs = computeProbsFromVotes(m.vote_home || 33, m.vote_draw || 33, m.vote_away || 34);
      const entropy = computeEntropy(probs);
      const confidence = Math.max(50, 80 - (entropy * 15));
      return { idx: m.match_idx, actual: m.result, probs, entropy, confidence };
    }).sort((a, b) => b.entropy - a.entropy);

    // Top 6 by entropy → doubles, bottom 7 → singles
    const doubles = processed.slice(0, 6);
    const singles = processed.slice(6);

    let correct = 0, total = 0;
    for (const m of doubles) {
      const top2 = m.probs[0] > m.probs[2] ? ['1', m.probs[1] > m.probs[2] ? 'X' : '2'] : [m.probs[2] > m.probs[1] ? '2' : 'X', '1'];
      if (top2.includes(m.actual)) correct++;
      total++;
    }
    for (const m of singles) {
      const pick = m.probs[0] > 0.6 ? '1' : m.probs[2] > 0.6 ? '2' : 'X';
      if (pick === m.actual) correct++;
      total++;
    }

    totalMatches += total;
    totalCorrect += correct;
  }

  db.close();
  const acc = totalMatches > 0 ? (totalCorrect / totalMatches) * 100 : 0;
  console.log(`  Concours: ${concoursList.length} | Exact: ${totalCorrect}/${totalMatches} = ${acc.toFixed(2)}%`);
  return { concoursCount: concoursList.length, totalMatches, totalCorrect, accuracy: acc };
}

if (require.main === module) {
  const result = backtest();
  if (process.argv.includes('--gold')) {
    const gold = backtestGoldCoupon();
    console.log(`\nGrid 4×6: ${result.overallAccuracy.toFixed(2)}% | Gold 6D: ${gold.accuracy.toFixed(2)}%`);
  } else {
    backtestGoldCoupon();
  }
}

module.exports = { backtest };
