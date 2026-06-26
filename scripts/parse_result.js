const axios = require('axios')
const fs = require('fs')

async function parseResultGrid(gridNo) {
  const url = `https://www.promosport-pronostic.com/index.php/welcome/promo_result?grille=${gridNo}&jeux=Promosport&imp_annee=2025`
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9',
    },
    timeout: 20000,
  })
  const html = res.data
  
  // Find data after "Résultat Promosport"
  const startMarker = 'Résultat Promosport'
  const startIdx = html.indexOf(startMarker)
  if (startIdx < 0) return null
  
  // Extract grid number
  const gridMatch = html.substring(startIdx, startIdx + 50).match(/n[°]?(\d+)/)
  
  // Extract cagnotte
  const cagMatch = html.match(/Cagnotte:\s*([\d\s]+)\s*TND/)
  
  // Find actual matches by looking for score patterns near team names
  // Match pattern: <td>...score...</td>...<td>team1</td>...<td>team2</td>
  const matches = []
  
  // Strategy: Find all sections with score patterns and percentages
  // Look for: <td> <p class="colorlive score_matchidNNNN">X - Y</p> </td>
  const scoreRegex = /<p\s+class="[^"]*(?:colorlive\s+score_matchid|c_score)[^"]*">\s*(\d+)\s*-\s*(\d+)\s*<\/p>/g
  let scoreMatch
  const scorePositions = []
  while ((scoreMatch = scoreRegex.exec(html)) !== null) {
    scorePositions.push({
      pos: scoreMatch.index,
      homeScore: parseInt(scoreMatch[1]),
      awayScore: parseInt(scoreMatch[2]),
    })
  }
  
  // For each score, look backward for teams and forward for percentages
  for (const sp of scorePositions) {
    // Look backwards for team names (within 300 chars)
    const before = html.substring(Math.max(0, sp.pos - 300), sp.pos)
    const after = html.substring(sp.pos, sp.pos + 500)
    
    // Extract team names: look for patterns like >Equipe Name</a
    const teamRegex = /<a[^>]*>([A-Za-zéûîôäëü\s]+)<\/a>/g
    const teams = []
    let t
    while ((t = teamRegex.exec(before)) !== null) {
      teams.push(t[1].trim())
    }
    
    // Extract percentage patterns after score
    const pctRegex = /(\d+)%[^0-9]*?(\d+)%[^0-9]*?(\d+)%/g
    const pcts = []
    let p
    while ((p = pctRegex.exec(after)) !== null) {
      pcts.push({ p1: parseInt(p[1]), px: parseInt(p[2]), p2: parseInt(p[3]) })
    }
    
    // Determine result from scores
    let result = null
    if (sp.homeScore > sp.awayScore) result = '1'
    else if (sp.homeScore < sp.awayScore) result = '2'
    else result = 'X'
    
    // Find the match index (we can infer from position)
    matches.push({
      home: teams.slice(-1)[0] || '?',
      away: teams.slice(-3, -1)[0] || '?',
      scoreHome: sp.homeScore,
      scoreAway: sp.awayScore,
      result,
      publicVote: pcts[0] || null,
    })
  }
  
  // Also try to find individual result indicators (1/X/2 in result column)
  const resultRegex = /<td[^>]*>\s*<span[^>]*class="[^"]*res[^"]*"[^>]*>\s*([1X2])\s*<\/span>\s*<\/td>/g
  let rm
  while ((rm = resultRegex.exec(html)) !== null) {
    console.log(`Result marker: ${rm[1]} at ${rm.index}`)
  }
  
  return {
    no: gridMatch ? gridMatch[1] : String(gridNo),
    cagnotte: cagMatch ? parseInt(cagMatch[1].replace(/\s/g, '')) : null,
    matches,
    scrapedAt: new Date().toISOString(),
  }
}

async function main() {
  // Test on grid 875 (should have results)
  console.log('Parsing grid 875...')
  const grid = await parseResultGrid(875)
  if (grid) {
    console.log(`Grid: ${grid.no}, Matches: ${grid.matches.length}`)
    grid.matches.forEach((m, i) => {
      const vote = m.publicVote ? `${m.publicVote.p1}%/${m.publicVote.px}%/${m.publicVote.p2}%` : 'N/A'
      console.log(`  #${i+1} ${m.home} vs ${m.away} [${m.scoreHome}-${m.scoreAway}] → ${m.result} | Vote: ${vote}`)
    })
  } else {
    console.log('Failed to parse')
  }
}

main().catch(console.error)
