const axios = require('axios')

async function getTextVersion(gridNo) {
  const url = `https://www.promosport-pronostic.com/index.php/welcome/promo_result?grille=${gridNo}&jeux=Promosport&imp_annee=2025`
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Accept': 'text/plain,text/html,*/*',
    },
    timeout: 20000,
    // Get as text, don't parse
    responseType: 'text',
  })
  
  const text = res.data
  
  // Find "Pronos site %" which marks the start of the match table
  const marker = 'Pronos site %'
  const idx = text.indexOf(marker)
  if (idx < 0) {
    console.log('Marker not found')
    // Try to find the table by looking for "Equipe 1" in context
    const eqIdx = text.indexOf('Equipe 1')
    if (eqIdx >= 0) {
      console.log('Found "Equipe 1" at', eqIdx)
      console.log(text.substring(Math.max(0, eqIdx - 100), eqIdx + 200))
    }
    return null
  }
  
  // Extract a generous section around the table
  const section = text.substring(idx, idx + 5000)
  
  // Parse matches from the text
  // Pattern: |M|P|...|Equipe1|Score|Equipe2|Rés|Pronos site %|||Pronos abns %|M|
  // Each match line looks like: |1| |J 3|24/06|23:00|Scotland|0 - 3|Brazil|2|10% 21% 69%|...|
  
  const lines = section.split('\n')
  const matches = []
  let inTable = false
  
  for (const line of lines) {
    // Detect table rows with pipes
    if (line.includes('|---|---|')) {
      inTable = true
      continue
    }
    if (line.includes('Du 2026') || line.includes('Promosport')) {
      inTable = false
      continue
    }
    
    if (inTable && line.includes('|')) {
      const cells = line.split('|').map(c => c.trim())
      
      // Try to parse match number
      const num = parseInt(cells[0])
      if (num >= 1 && num <= 13) {
        // Find home team, score, away team, result
        let home, score, away, result, pct
        for (let i = 1; i < cells.length; i++) {
          if (cells[i].match(/^\d+\s*-\s*\d+$/)) {
            score = cells[i]
            // Home is 2 before score, away is 1 after
            home = cells[i-2]
            away = cells[i+1]
            result = cells[i+2]
            // Look for percentage pattern in remaining cells
            for (let j = i+3; j < cells.length; j++) {
              const pctMatch = cells[j].match(/(\d+)%\s*(\d+)%\s*(\d+)%/)
              if (pctMatch) {
                pct = { p1: parseInt(pctMatch[1]), px: parseInt(pctMatch[2]), p2: parseInt(pctMatch[3]) }
                break
              }
            }
            break
          }
        }
        
        if (home && away && score) {
          const parts = score.split('-').map(s => parseInt(s.trim()))
          matches.push({
            idx: num,
            home: home.replace(/<[^>]*>/g, '').trim(),
            away: away.replace(/<[^>]*>/g, '').trim(),
            scoreHome: parts[0],
            scoreAway: parts[1],
            result: result || (parts[0] > parts[1] ? '1' : parts[0] < parts[1] ? '2' : 'X'),
            publicVote: pct,
          })
        }
      }
    }
  }
  
  return { grid: gridNo, matches }
}

async function main() {
  console.log('Parsing grid 875 from text...')
  const result = await getTextVersion(875)
  if (result && result.matches.length > 0) {
    console.log(`Found ${result.matches.length} matches`)
    result.matches.forEach(m => {
      const vote = m.publicVote ? `Pub: ${m.publicVote.p1}%/${m.publicVote.px}%/${m.publicVote.p2}%` : 'No vote'
      console.log(`  #${m.idx} ${m.home} vs ${m.away} [${m.scoreHome}-${m.scoreAway}] → ${m.result} | ${vote}`)
    })
  } else {
    console.log('No matches found')
  }
}

main().catch(console.error)
