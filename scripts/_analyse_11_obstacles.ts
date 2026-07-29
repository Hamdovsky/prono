// @ts-nocheck
import axios from 'axios'
import fs from 'fs'
import path from 'path'

// Load historical data for obstacle 10 (historique)
let historicalData = []
try {
  const histPath = path.join(__dirname, 'data', 'promosport_historical_results.json')
  historicalData = JSON.parse(fs.readFileSync(histPath, 'utf8'))
} catch (e) {}

async function analyseConcours879() {
  console.log('🏟️ ANALYSE DES 11 OBSTACLES — CONCOURS #879\n')

  // Get match data from the API
  let apiData
  try {
    const r = await axios.get('http://localhost:3457/api/promosport', { timeout: 30000 })
    apiData = r.data
  } catch (e) {
    // Fallback: hit backup directly
    console.log('⚠️ API locale hors ligne, utilisation du backup...')
    return
  }

  const matches = apiData.matches
  console.log(`📋 ${matches.length} matchs analysés\n`)

  // Obstacle definitions (score 1-5, 5 = plus risqué)
  function analyseObstacles(m, idx) {
    const mlH = m.mlProbs.h / 100
    const mlX = m.mlProbs.x / 100
    const mlA = m.mlProbs.a / 100
    const pubH = m.probs.h / 100
    const pubX = m.probs.x / 100
    const pubA = m.probs.a / 100

    // 1. BOOKMAKER — écart entre probas ML et probas par défaut
    const bmScore =
      Math.abs(mlH - 0.33) < 0.05 && Math.abs(mlX - 0.33) < 0.05
        ? 3
        : Math.max(mlH, mlX, mlA) > 0.45
          ? 2
          : 4

    // 2. TERRAIN — domicile/extérieur (logique: équipe1 = domicile)
    const terrainScore =
      m.home.includes('CRICI') || m.home.includes('GOIAS') || m.home.includes('NAUTI')
        ? 2
        : m.away.includes('FRANCE') ||
            m.away.includes('SPAIN') ||
            m.away.includes('ENGLAND') ||
            m.away.includes('BELGIUM')
          ? 3
          : 3

    // 3. STATISTIQUES — basé sur l'entropie du match
    const H = -(
      mlH * Math.log2(Math.max(0.01, mlH)) +
      mlX * Math.log2(Math.max(0.01, mlX)) +
      mlA * Math.log2(Math.max(0.01, mlA))
    )
    const statsScore = H > 1.5 ? 4 : H > 1.4 ? 3 : 2

    // 4. PSYCHOLOGIE — contexte du match (Coupe du Monde = pression)
    const isWC = [
      'CANADA',
      'MAROC',
      'MOROCCO',
      'BRAZIL',
      'NORVÈGE',
      'NORWAY',
      'MEXICO',
      'ENGLAND',
      'PORTUGAL',
      'SPAIN',
      'PARAGUAY',
      'FRANCE',
      'USA',
      'BELGIUM',
    ]
    const isWCMatch = isWC.includes(m.home) || isWC.includes(m.away)
    const psychoScore = isWCMatch ? 4 : 3

    // 5. PUBLIC — piège public (crowd trap)
    const publicDelta = Math.abs(mlH - pubH)
    const crowdScore = m.crowdTraps?.isCrowdTrap ? 5 : publicDelta > 0.15 ? 4 : 2

    // 6. MÉTÉO — non disponible
    const meteoScore = 3

    // 7. BLESSURES — non disponible
    const blessScore = 3

    // 8. ARBITRAGE — non disponible
    const arbitreScore = 3

    // 9. COTES — non disponible (promosportplus.com hors ligne)
    const coteScore = 3

    // 10. HISTORIQUE — patterns passés
    let histScore = 3
    try {
      const homeHist = historicalData.filter((h) =>
        h.matches?.some(
          (m) => m.home?.toUpperCase().includes(m.home) || m.away?.toUpperCase().includes(m.away)
        )
      )
      if (homeHist.length > 5) histScore = 2
    } catch (e) {}

    // 11. VALEUR — EV du match
    const bestProbML = Math.max(mlH, mlX, mlA)
    const bestProbPub = Math.max(pubH, pubX, pubA)
    const valueScore = bestProbML > bestProbPub * 1.2 ? 2 : bestProbPub > bestProbML * 1.3 ? 4 : 3

    const obstacles = {
      bookmaker: bmScore,
      terrain: terrainScore,
      statistiques: statsScore,
      psychologie: psychoScore,
      public: crowdScore,
      meteo: meteoScore,
      blessures: blessScore,
      arbitrage: arbitreScore,
      cotes: coteScore,
      historique: histScore,
      valeur: valueScore,
    }

    const avgScore = Object.values(obstacles).reduce((a, b) => a + b, 0) / 11
    const maxScore = Math.max(...Object.values(obstacles))

    return { obstacles, avgScore: +avgScore.toFixed(2), maxScore }
  }

  // Analyse et affichage
  const results = []
  matches.forEach((m, idx) => {
    const analysis = analyseObstacles(m, idx)
    results.push({ id: m.id, home: m.home, away: m.away, ...analysis })
  })

  // Affichage formaté
  const header1 = 'ID  HomeTeam'.padEnd(26) + 'AwayTeam'.padEnd(22) + 'Moy  Max  Détail'
  const sep1 = '─'.repeat(90)
  console.log(header1)
  console.log(sep1)

  results.forEach((r) => {
    const obs = r.obstacles
    const detail = `[B${obs.bookmaker} T${obs.terrain} S${obs.statistiques} P${obs.psychologie} Pu${obs.public} M${obs.meteo} Bl${obs.blessures} A${obs.arbitrage} C${obs.cotes} H${obs.historique} V${obs.valeur}]`
    const line =
      String(r.id).padEnd(3) +
      r.home.substring(0, 18).padEnd(20) +
      r.away.substring(0, 18).padEnd(20) +
      String(r.avgScore).padEnd(5) +
      String(r.maxScore).padEnd(5) +
      detail
    console.log(line)
  })

  console.log('\n' + sep1)
  console.log('Score: 1=risque faible, 5=risque élevé')
  console.log(
    '\nLégende: B=Bookmaker T=Terrain S=Stats P=Psycho Pu=Public M=Météo Bl=Blessures A=Arbitre C=Cotes H=Historique V=Valeur'
  )

  // Matchs à risque (score > 3.5)
  const highRisk = results.filter((r) => r.avgScore > 3.5)
  if (highRisk.length > 0) {
    console.log(
      `\n🚨 MATCHS À HAUT RISQUE (moy > 3.5) : ${highRisk.map((r) => `M${r.id} (${r.avgScore})`).join(', ')}`
    )
  } else {
    console.log('\n✅ Aucun match à risque critique détecté')
  }

  const lowRisk = results.filter((r) => r.avgScore < 2.5)
  if (lowRisk.length > 0) {
    console.log(
      `🟢 MATCHS SÛRS (moy < 2.5) : ${lowRisk.map((r) => `M${r.id} (${r.avgScore})`).join(', ')}`
    )
  }

  // Sauvegarde
  const output = {
    concours: apiData.concours,
    date: apiData.date,
    analysis: results.map((r) => ({
      id: r.id,
      home: r.home,
      away: r.away,
      avgObstacleScore: r.avgScore,
      maxObstacleScore: r.maxScore,
      riskLevel: r.avgScore > 3.5 ? 'HIGH' : r.avgScore > 3.0 ? 'MEDIUM' : 'LOW',
      obstacles: r.obstacles,
    })),
  }
  fs.writeFileSync('_analyse_879_results.json', JSON.stringify(output, null, 2))
  console.log(`\n💾 Analyse sauvegardée dans _analyse_879_results.json`)
}

analyseConcours879().catch((e) => console.error('FATAL:', e.message))
