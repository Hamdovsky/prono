// @ts-nocheck
import fs from 'fs'
import path from 'path'
import {  scrapeBatch  } from '../core/promosport_tunisie_scraper'
import {  rebuildCrowdProfile  } from './crowd_collector'
import logger from '../core/logger'

const VOTE_HISTORY_PATH = path.join(__dirname, '..', 'data', 'tunisian_vote_history.json')

async function main() {
  const ranges = [
    [623, 680],
    [681, 740],
    [741, 800],
    [801, 840],
    [841, 869],
    [870, 876],
  ]

  let allMatches = []
  // Load existing if any
  if (fs.existsSync(VOTE_HISTORY_PATH)) {
    try {
      allMatches = JSON.parse(fs.readFileSync(VOTE_HISTORY_PATH, 'utf-8'))
    } catch (e) {
      allMatches = []
    }
  }

  const existingGrids = new Set(allMatches.map((m) => m.grid))
  console.log(`Loaded ${allMatches.length} existing matches from ${existingGrids.size} grids`)

  for (const [from, to] of ranges) {
    // Skip grids already collected
    const needed = []
    for (let g = from; g <= to; g++) {
      if (!existingGrids.has(String(g))) needed.push(g)
    }
    if (needed.length === 0) {
      console.log(`Range ${from}-${to}: all ${to - from + 1} grids already collected, skipping`)
      continue
    }

    console.log(
      `Scanning grids ${needed[0]}..${needed[needed.length - 1]} (${needed.length} new)...`
    )
    const grids = await scrapeBatch(needed[0], needed[needed.length - 1])
    if (grids.length === 0) {
      console.log(`  No grids found in range ${from}-${to}`)
      continue
    }

    for (const grid of grids) {
      for (const m of grid.matches) {
        if (!m.result || !m.publicVote || m.result === 'N') continue
        // Deduplicate by grid+idx
        const dup = allMatches.find((a) => a.grid === grid.no && a.idx === m.idx)
        if (dup) continue

        allMatches.push({
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
        })
      }
    }

    // Incremental save after each range
    fs.writeFileSync(VOTE_HISTORY_PATH, JSON.stringify(allMatches, null, 2))
    const right = allMatches.filter((m) => {
      const picks = [
        { label: '1', pct: m.vote1 },
        { label: 'X', pct: m.voteX },
        { label: '2', pct: m.vote2 },
      ]
      picks.sort((a, b) => b.pct - a.pct)
      return picks[0].label === m.result
    }).length
    console.log(
      `  → ${allMatches.length} total matches, ${right} right (${((right / allMatches.length) * 100).toFixed(1)}%)`
    )
  }

  // Final rebuild of profile
  await rebuildCrowdProfile(allMatches)

  const right = allMatches.filter((m) => {
    const picks = [
      { label: '1', pct: m.vote1 },
      { label: 'X', pct: m.voteX },
      { label: '2', pct: m.vote2 },
    ]
    picks.sort((a, b) => b.pct - a.pct)
    return picks[0].label === m.result
  }).length

  console.log(`\n========================================`)
  console.log(`BACKFILL COMPLETE`)
  console.log(`========================================`)
  console.log(`Total matchs: ${allMatches.length}`)
  console.log(
    `Foule correcte: ${right}/${allMatches.length} (${((right / allMatches.length) * 100).toFixed(1)}%)`
  )
  console.log(`Grilles: ${[...new Set(allMatches.map((m) => m.grid))].sort().join(', ')}`)
  console.log(`Sauvegardé dans: tunisian_vote_history.json + crowd_profile.json`)
}

main().catch(console.error)
