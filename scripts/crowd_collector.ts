// @ts-nocheck
import fs from 'fs'
import path from 'path'
import {  scrapeTunisieGrid  } from '../core/promosport_tunisie_scraper'
import logger from '../core/logger'

const CROWD_PATH = path.join(__dirname, '..', 'data', 'crowd_profile.json')
const VOTE_HISTORY_PATH = path.join(__dirname, '..', 'data', 'tunisian_vote_history.json')

async function collectLatestGrid() {
  // Try current year (2026), fallback to 2025
  let grid = await scrapeTunisieGrid(876) // latest known
  if (!grid || grid.matches.length < 5) {
    grid = await scrapeTunisieGrid(875)
  }
  if (!grid || grid.matches.length < 5) {
    logger.warn('[CROWD-COLLECT] No valid grid found')
    return null
  }

  // Load vote history
  let history = []
  if (fs.existsSync(VOTE_HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(VOTE_HISTORY_PATH, 'utf-8'))
    } catch (e) {
      history = []
    }
  }

  // Skip if already collected
  if (history.some((h) => h.grid === grid.no)) {
    logger.info(
      `[CROWD-COLLECT] Grid ${grid.no} already collected (${history.filter((h) => h.grid === grid.no).length} matches)`
    )
    return null
  }

  // Collect only matches with results and votes
  const collected = grid.matches
    .filter((m) => m.result && m.publicVote && m.result !== 'N')
    .map((m) => ({
      grid: grid.no,
      idx: m.idx,
      home: m.home,
      away: m.away,
      scoreHome: m.scoreHome,
      scoreAway: m.scoreAway,
      result: m.result,
      vote1: m.publicVote.p1,
      voteX: m.publicVote.px,
      vote2: m.publicVote.p2,
      collectedAt: new Date().toISOString(),
    }))

  history.push(...collected)
  fs.writeFileSync(VOTE_HISTORY_PATH, JSON.stringify(history, null, 2))

  // Update crowd profile with new data
  await rebuildCrowdProfile(history)

  logger.info(
    `[CROWD-COLLECT] Grid ${grid.no}: collected ${collected.length} matches (total: ${history.length})`
  )
  return { grid: grid.no, collected: collected.length, total: history.length }
}

async function rebuildCrowdProfile(allMatches) {
  if (allMatches.length === 0) return

  let total = 0
  let right = 0
  const byBin = {}

  for (const m of allMatches) {
    const picks = [
      { label: '1', pct: m.vote1 },
      { label: 'X', pct: m.voteX },
      { label: '2', pct: m.vote2 },
    ]
    picks.sort((a, b) => b.pct - a.pct)
    const crowdFav = picks[0].label
    const favPct = picks[0].pct
    const correct = crowdFav === m.result

    const bin = Math.floor(favPct / 10) * 10
    if (!byBin[bin]) byBin[bin] = { right: 0, total: 0 }
    byBin[bin].total++
    if (correct) byBin[bin].right++

    total++
    if (correct) right++
  }

  const weak = Object.entries(byBin)
    .filter(([k]) => parseInt(k) < 70)
    .reduce((s, [, d]) => ({ r: s.r + d.right, t: s.t + d.total }), { r: 0, t: 0 })
  const strong = Object.entries(byBin)
    .filter(([k]) => parseInt(k) >= 70)
    .reduce((s, [, d]) => ({ r: s.r + d.right, t: s.t + d.total }), { r: 0, t: 0 })

  // Load existing profile and update tunisianCrowd
  let profile = {}
  if (fs.existsSync(CROWD_PATH)) {
    try {
      profile = JSON.parse(fs.readFileSync(CROWD_PATH, 'utf-8'))
    } catch (e) {
      profile = {}
    }
  }

  profile.tunisianCrowd = {
    totalMatches: total,
    crowdRight: right,
    crowdWrong: total - right,
    crowdAccuracy: +((right / total) * 100).toFixed(1),
    byConfidence: Object.entries(byBin)
      .sort((a, b) => a[0] - b[0])
      .map(([bin, data]) => ({
        bin: `${bin}-${parseInt(bin) + 9}%`,
        total: data.total,
        right: data.right,
        accuracy: +((data.right / data.total) * 100).toFixed(1),
      })),
    gridsAnalyzed: [...new Set(allMatches.map((m) => m.grid))].sort(),
    insight: {
      weakConfidence_under70: {
        accuracy: weak.t > 0 ? +((weak.r / weak.t) * 100).toFixed(1) : 0,
        action: "CONTRARIAN - prendre l'opposé du favori",
      },
      strongConfidence_70plus: {
        accuracy: strong.t > 0 ? +((strong.r / strong.t) * 100).toFixed(1) : 0,
        action: 'SUIVRE la foule (prudence)',
      },
    },
    lastUpdated: new Date().toISOString(),
  }

  fs.writeFileSync(CROWD_PATH, JSON.stringify(profile, null, 2))
  logger.info(
    `[CROWD-COLLECT] Profile rebuilt: ${total} matches, ${right} right (${((right / total) * 100).toFixed(1)}%)`
  )
}

async function backfillGrids(start, end, delayMs = 3000) {
  // Load existing history to skip already-collected grids
  let history = []
  if (fs.existsSync(VOTE_HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(VOTE_HISTORY_PATH, 'utf-8'))
    } catch (e) {
      history = []
    }
  }
  const existingGrids = new Set(history.map((h) => h.grid))

  const toScrape = []
  for (let g = start; g <= end; g++) {
    if (!existingGrids.has(String(g))) toScrape.push(g)
  }

  logger.info(`[BACKFILL] ${toScrape.length} grids missing in range ${start}-${end}`)
  let collected = 0
  let skipped = 0

  for (let i = 0; i < toScrape.length; i++) {
    const gridNo = toScrape[i]
    try {
      const grid = await scrapeTunisieGrid(gridNo)
      if (grid && grid.matches && grid.matches.length >= 5) {
        const newMatches = grid.matches
          .filter((m) => m.result && m.publicVote && m.result !== 'N')
          .map((m) => ({
            grid: String(gridNo),
            idx: m.idx,
            home: m.home,
            away: m.away,
            scoreHome: m.scoreHome,
            scoreAway: m.scoreAway,
            result: m.result,
            vote1: m.publicVote.p1,
            voteX: m.publicVote.px,
            vote2: m.publicVote.p2,
            collectedAt: new Date().toISOString(),
          }))

        if (newMatches.length > 0) {
          history.push(...newMatches)
          collected += newMatches.length
          logger.info(
            `[BACKFILL] Grid ${gridNo}: +${newMatches.length} matchs (total: ${history.length})`
          )
        } else {
          skipped++
        }
      } else {
        skipped++
      }
    } catch (e) {
      logger.warn(`[BACKFILL] Grid ${gridNo}: error (${e.message})`)
      skipped++
    }

    // Progress every 10 grids
    if ((i + 1) % 10 === 0) {
      logger.info(
        `[BACKFILL] Progress: ${i + 1}/${toScrape.length} (${collected} matchs collects, ${skipped} vides)`
      )
    }

    // Save incrementally every 5 grids
    if ((i + 1) % 5 === 0) {
      fs.writeFileSync(VOTE_HISTORY_PATH, JSON.stringify(history, null, 2))
    }

    // Rate limit
    if (i < toScrape.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  // Final save
  fs.writeFileSync(VOTE_HISTORY_PATH, JSON.stringify(history, null, 2))
  logger.info(`[BACKFILL] Saved ${history.length} matchs to ${VOTE_HISTORY_PATH}`)

  // Rebuild profile
  await rebuildCrowdProfile(history)
  logger.info(`[BACKFILL] Done: +${collected} matchs, ${skipped} grilles vides/erreurs`)

  return { collected, skipped, total: history.length }
}

// Auto-run if called directly
if (require.main === module) {
  const cmd = process.argv[2]
  if (cmd === 'backfill') {
    const start = parseInt(process.argv[3] || '623')
    const end = parseInt(process.argv[4] || '875')
    backfillGrids(start, end)
      .then((r) =>
        console.log(`Backfill termine: ${r.collected} matchs collects (total: ${r.total})`)
      )
      .catch((e) => console.error(e))
  } else {
    collectLatestGrid()
      .then((r) => {
        if (r)
          console.log(`Collected grid ${r.grid}: ${r.collected} new matches (${r.total} total)`)
        else console.log('No new grid data')
      })
      .catch((e) => console.error(e))
  }
}

export = { collectLatestGrid, rebuildCrowdProfile, backfillGrids }
