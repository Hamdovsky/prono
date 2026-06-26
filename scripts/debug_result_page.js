const fs = require('fs')

async function analyzeResultPage() {
  const html = fs.readFileSync('data/debug_876.html', 'utf-8')
  console.log('HTML length:', html.length)
  
  // Find the Pronos site section
  const keys = ['Pronos site %', 'Pronos abns %', 'Résultat Promosport', '<table']
  for (const key of keys) {
    let idx = 0
    const positions = []
    while ((idx = html.indexOf(key, idx)) >= 0) {
      positions.push(idx)
      idx++
    }
    console.log(`"${key}" found ${positions.length} times at:`, positions.slice(0,5))
    
    if (positions.length > 0) {
      const ctx = html.substring(positions[0], positions[0] + 3000).replace(/\n/g,' ').replace(/\s+/g,' ').trim()
      console.log(`Context (first 2000 chars):\n${ctx.substring(0,2000)}\n`)
    }
  }
}

analyzeResultPage().catch(console.error)
