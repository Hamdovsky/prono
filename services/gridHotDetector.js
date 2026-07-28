const fs = require('fs')
const path = require('path')

const TUNISIAN_VOTES_PATH = path.join(__dirname, '..', 'data', 'tunisian_vote_history.json')
const GRID_HISTORY_PATH = path.join(
  __dirname,
  '..',
  'data',
  'promosport_analysis',
  'historical_data.json'
)

function loadTunisianVotes() {
  try {
    if (fs.existsSync(TUNISIAN_VOTES_PATH)) {
      const raw = fs.readFileSync(TUNISIAN_VOTES_PATH, 'utf-8')
      return JSON.parse(raw)
    }
  } catch (e) {
    console.error('Erreur chargement votes Tunisie:', e.message)
  }
  return []
}

function loadGridHistory() {
  try {
    if (fs.existsSync(GRID_HISTORY_PATH)) {
      const raw = fs.readFileSync(GRID_HISTORY_PATH, 'utf-8')
      return JSON.parse(raw)
    }
  } catch (e) {
    console.error('Erreur chargement histoire grids:', e.message)
  }
  return { grids: {} }
}

function calculateGridScore(gridEntry) {
  if (!gridEntry) return { score: 0, rating: 'N/A', factors: [] }

  const { cagnotte, matches } = gridEntry
  const factors = []
  let score = 0

  // 1. Cagnotte (0-30 points)
  if (cagnotte) {
    const cagnotteScore = Math.min(30, cagnotte / 1000)
    score += cagnotteScore
    factors.push({ name: 'Cagnotte', value: cagnotte, weight: 30, score: cagnotteScore })
  }

  // 2. Nombre de matchs (0-10 points)
  if (matches && matches.length >= 10) {
    const matchScore = Math.min(10, matches.length)
    score += matchScore
    factors.push({ name: 'Matchs', value: matches.length, weight: 10, score: matchScore })
  }

  // 3. Taux de réussite (0-30 points)
  if (matches && matches.length > 0) {
    const wins = matches.filter((m) => m.result === '1').length
    const winRate = wins / matches.length
    const winScore = winRate * 30
    score += winScore
    factors.push({
      name: 'Taux de réussite',
      value: `${(winRate * 100).toFixed(0)}%`,
      weight: 30,
      score: winScore,
    })
  }

  // 4. Volatilité faible = meilleur (0-20 points)
  if (matches && matches.length > 0) {
    const consensusScores = matches.map((m) => {
      const v1 = m.publicVote?.p1 || 0
      const vx = m.publicVote?.px || 0
      const v2 = m.publicVote?.p2 || 0
      const total = v1 + vx + v2
      if (total === 0) return 0.5
      return Math.max(v1, vx, v2) / total
    })
    const avgConsensus = consensusScores.reduce((a, b) => a + b, 0) / consensusScores.length
    const volatScore = avgConsensus * 20
    score += volatScore
    factors.push({
      name: 'Consensus',
      value: `${(avgConsensus * 100).toFixed(0)}%`,
      weight: 20,
      score: volatScore,
    })
  }

  // 5. Score de confiance (0-10 points)
  if (matches && matches.length > 0) {
    const confidentMatches = matches.filter((m) => {
      const v1 = m.publicVote?.p1 || 0
      const vx = m.publicVote?.px || 0
      const v2 = m.publicVote?.p2 || 0
      const total = v1 + vx + v2
      if (total === 0) return false
      const maxVote = Math.max(v1, vx, v2)
      return maxVote / total > 0.6
    }).length
    const confScore = (confidentMatches / matches.length) * 10
    score += confScore
    factors.push({
      name: 'Matchs confiants',
      value: confidentMatches,
      weight: 10,
      score: confScore,
    })
  }

  // Normalisation sur 100
  const finalScore = Math.min(100, score)

  // Rating
  let rating = '❄️ Froid'
  if (finalScore >= 80) rating = '🔥 TRÈS CHAUD'
  else if (finalScore >= 65) rating = '🔥 CHAUD'
  else if (finalScore >= 50) rating = '🌡️ Tiède'
  else if (finalScore >= 35) rating = '❄️ Frais'
  else rating = '🧊 TRÈS FRAIS'

  return { score: finalScore, rating, factors }
}

function detectHotGrids(options = {}) {
  const { limit = 10, minScore = 50, includePast = true } = options

  const allVotes = loadTunisianVotes()
  const gridHistory = loadGridHistory()

  // Grouper par grid
  const gridMap = new Map()

  allVotes.forEach((entry) => {
    const gridNo = entry.grid
    if (!gridMap.has(gridNo)) {
      gridMap.set(gridNo, {
        grid: gridNo,
        cagnotte: entry.cagnotte,
        matches: [],
        dates: [],
      })
    }

    if (entry.matches) {
      gridMap.get(gridNo).matches.push(...entry.matches)
    }
    if (entry.collectedAt) {
      gridMap.get(gridNo).dates.push(entry.collectedAt)
    }
  })

  // Calculer le score pour chaque grid
  const results = []

  gridMap.forEach((gridData) => {
    const scoreData = calculateGridScore(gridData)

    results.push({
      grid: gridData.grid,
      cagnotte: gridData.cagnotte,
      matchCount: gridData.matches.length,
      lastDate: gridData.dates.length > 0 ? gridData.dates[gridData.dates.length - 1] : null,
      ...scoreData,
    })
  })

  // Trier par score décroissant
  results.sort((a, b) => b.score - a.score)

  // Filtrer et retourner
  const filtered = results.filter((g) => g.score >= minScore).slice(0, limit)

  return {
    success: true,
    data: filtered,
    totalAnalyzed: results.length,
    timestamp: new Date().toISOString(),
  }
}

function getGridRecommendations() {
  const hotGrids = detectHotGrids({ limit: 5, minScore: 60 })
  const allGrids = detectHotGrids({ limit: 50, minScore: 0 })

  return {
    success: true,
    hotGrids: hotGrids.data,
    bestOfAll: allGrids.data.slice(0, 3),
    analysis: {
      totalGrids: allGrids.totalAnalyzed,
      hotGridsCount: hotGrids.data.length,
      avgScore: allGrids.data.reduce((sum, g) => sum + g.score, 0) / allGrids.data.length || 0,
    },
  }
}

module.exports = {
  detectHotGrids,
  getGridRecommendations,
  calculateGridScore,
  loadTunisianVotes,
  loadGridHistory,
}
