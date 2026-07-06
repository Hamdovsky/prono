const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../core/logger');
const { scrapeTunisieGrid } = require('../core/promosport_tunisie_scraper');

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');

function getDb() {
  return new Database(ARCHIVE_PATH);
}

function storePrediction(concours, date, grids) {
  try {
    const db = getDb();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS promosport_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concours TEXT NOT NULL,
        date TEXT,
        grid_name TEXT,
        match_idx INTEGER,
        home_team TEXT,
        away_team TEXT,
        choices TEXT,
        created_at DATETIME DEFAULT datetime('now'),
        UNIQUE(concours, grid_name, match_idx)
      )
    `).run();

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO promosport_predictions
        (concours, date, grid_name, match_idx, home_team, away_team, choices, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const tx = db.transaction(() => {
      for (const grid of grids) {
        for (const match of grid.matches) {
          upsert.run(
            String(concours),
            date,
            grid.name,
            match.id,
            match.home,
            match.away,
            JSON.stringify(match.choices)
          );
        }
      }
    });
    tx();
    db.close();
    logger.info(`[PROMOSPORT-RESULT] Stored ${grids.length * 13} predictions for concours ${concours}`);
    return true;
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] storePrediction error: ${e.message}`);
    return false;
  }
}

async function checkAndFetchResults(concoursNumber) {
  try {
    const grid = await scrapeTunisieGrid(concoursNumber);
    if (!grid || !grid.matches || grid.matches.length === 0) {
      logger.info(`[PROMOSPORT-RESULT] No results yet for concours ${concoursNumber}`);
      return null;
    }

    const finishedMatches = grid.matches.filter(m => m.result && m.result !== 'N');
    if (finishedMatches.length === 0) {
      logger.info(`[PROMOSPORT-RESULT] Concours ${concoursNumber} not finished yet`);
      return null;
    }

    const db = getDb();
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO promosport_archive
        (concours, match_idx, homeTeam, awayTeam, result,
         vote_home, vote_draw, vote_away, score_home, score_away, date, is_finished, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    `);

    const tx = db.transaction(() => {
      for (const m of grid.matches) {
        if (!m.result || m.result === 'N') continue;
        upsert.run(
          String(concoursNumber),
          m.idx,
          m.home.toUpperCase(),
          m.away.toUpperCase(),
          m.result,
          m.publicVote?.p1 || null,
          m.publicVote?.px || null,
          m.publicVote?.p2 || null,
          m.scoreHome || null,
          m.scoreAway || null,
          new Date().toISOString().slice(0, 10)
        );
      }
    });
    tx();
    db.close();

    logger.info(`[PROMOSPORT-RESULT] Fetched ${finishedMatches.length} results for concours ${concoursNumber}`);
    return finishedMatches;
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] checkAndFetchResults error for ${concoursNumber}: ${e.message}`);
    return null;
  }
}

function computeAccuracy(concoursNumber) {
  try {
    const db = getDb();
    const predictions = db.prepare(`
      SELECT pp.*, pa.result, pa.score_home, pa.score_away
      FROM promosport_predictions pp
      LEFT JOIN promosport_archive pa
        ON pp.concours = pa.concours
        AND pp.match_idx = pa.match_idx
      WHERE pp.concours = ? AND pa.result IS NOT NULL AND pa.result != 'N'
    `).all(String(concoursNumber));
    db.close();

    if (predictions.length === 0) return null;

    const byGrid = {};
    let totalCorrect = 0;
    let totalMatches = 0;

    for (const p of predictions) {
      if (!byGrid[p.grid_name]) byGrid[p.grid_name] = { correct: 0, total: 0, matchDetails: [] };
      const choices = JSON.parse(p.choices || '[]');
      const isCorrect = choices.includes(p.result);
      byGrid[p.grid_name].total++;
      byGrid[p.grid_name].correct += isCorrect ? 1 : 0;
      byGrid[p.grid_name].matchDetails.push({
        match_idx: p.match_idx,
        home: p.home_team,
        away: p.away_team,
        choices,
        result: p.result,
        score: p.score_home != null ? `${p.score_home}-${p.score_away}` : null,
        isCorrect
      });
      totalCorrect += isCorrect ? 1 : 0;
      totalMatches++;
    }

    const gridStats = Object.entries(byGrid).map(([name, data]) => ({
      name,
      accuracy: ((data.correct / data.total) * 100).toFixed(1) + '%',
      correct: data.correct,
      total: data.total,
      matchDetails: data.matchDetails
    }));

    return {
      concours: String(concoursNumber),
      totalMatches,
      totalCorrect,
      overallAccuracy: ((totalCorrect / totalMatches) * 100).toFixed(1) + '%',
      grids: gridStats
    };
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] computeAccuracy error: ${e.message}`);
    return null;
  }
}

function getRecentHistory(limit = 20) {
  try {
    const db = getDb();
    const concours = db.prepare(`
      SELECT DISTINCT pp.concours FROM promosport_predictions pp
      ORDER BY pp.concours DESC LIMIT ?
    `).all(limit).map(r => r.concours);
    db.close();
    return concours;
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] getRecentHistory error: ${e.message}`);
    return [];
  }
}

function getOverallStats() {
  try {
    const db = getDb();
    const concoursList = db.prepare(`
      SELECT DISTINCT pp.concours FROM promosport_predictions pp
      INNER JOIN promosport_archive pa ON pp.concours = pa.concours AND pa.is_finished = 1
    `).all().map(r => r.concours);
    db.close();

    const accuracies = concoursList.map(c => computeAccuracy(c)).filter(Boolean);
    if (accuracies.length === 0) return null;

    const totalCorrect = accuracies.reduce((s, a) => s + a.totalCorrect, 0);
    const totalMatches = accuracies.reduce((s, a) => s + a.totalMatches, 0);
    const gridAverages = {};
    for (const acc of accuracies) {
      for (const g of acc.grids) {
        if (!gridAverages[g.name]) gridAverages[g.name] = { correct: 0, total: 0 };
        gridAverages[g.name].correct += g.correct;
        gridAverages[g.name].total += g.total;
      }
    }

    return {
      concoursCount: accuracies.length,
      totalMatches,
      totalCorrect,
      overallAccuracy: ((totalCorrect / totalMatches) * 100).toFixed(1) + '%',
      perGrid: Object.entries(gridAverages).map(([name, data]) => ({
        name,
        accuracy: ((data.correct / data.total) * 100).toFixed(1) + '%',
        correct: data.correct,
        total: data.total
      })),
      recentConcours: accuracies.slice(-10).map(a => ({
        concours: a.concours,
        accuracy: a.overallAccuracy,
        correct: a.totalCorrect,
        total: a.totalMatches
      }))
    };
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] getOverallStats error: ${e.message}`);
    return null;
  }
}

module.exports = { storePrediction, checkAndFetchResults, computeAccuracy, getRecentHistory, getOverallStats };
