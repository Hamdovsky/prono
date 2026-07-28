const axios = require('axios')
const cheerio = require('cheerio')
const logger = require('./logger')

const BASE_URL = 'https://www.promosport-pronostic.com/index.php/welcome/promo_result'

async function scrapeTunisieGrid(gridNo) {
  try {
    const currentYear = new Date().getFullYear()
    const url = `${BASE_URL}?grille=${gridNo}&jeux=Promosport&imp_annee=${currentYear}`
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
      timeout: 30000,
    })
    const $ = cheerio.load(res.data)

    const h2Text = $('h2:contains("Résultat Promosport")').first().text()
    const gridMatch = h2Text.match(/n[°\s]*(\d+)/i)
    const gridNoDetected = gridMatch ? gridMatch[1] : String(gridNo)

    const cagText = $('h2:contains("Cagnotte")').first().text()
    const cagMatch = cagText.match(/Cagnotte:\s*([\d\s]+)\s*TND/i)
    const cagnotte = cagMatch ? parseInt(cagMatch[1].replace(/\s/g, '')) : null

    // Table 0 = promo grid. Row 0 = header, Rows 1-13 = matches
    const matches = []
    const rows = $('table:eq(0) tr')

    rows.each((i, row) => {
      if (i === 0) return // skip header
      const allTds = $(row).find('td')
      // Match rows have 15 tds; row 1 has 12 (different format)
      if (allTds.length < 12) return

      const firstText = allTds.first().text().trim()
      const idx = parseInt(firstText)
      if (isNaN(idx) || idx < 1 || idx > 13) return

      const idxText = allTds.eq(0).text().trim()
      const home = allTds.eq(6).text().trim()
      const scoreText = allTds.eq(7).text().trim()
      const away = allTds.eq(8).text().trim()
      const resultText = allTds.eq(9).text().trim()

      if (!home || !away) return

      const scoreMatch = scoreText.match(/(\d+)\s*-\s*(\d+)/)
      if (!scoreMatch) return

      const result = ['1', 'X', '2', 'N'].includes(resultText) ? resultText : null

      // Vote percentages from td[10], td[11], td[12]
      const p1 = parseInt(allTds.eq(10).text().trim())
      const px = parseInt(allTds.eq(11).text().trim())
      const p2 = parseInt(allTds.eq(12).text().trim())

      const publicVote = !isNaN(p1) && !isNaN(px) && !isNaN(p2) ? { p1, px, p2 } : null

      matches.push({
        idx,
        home,
        away,
        scoreHome: parseInt(scoreMatch[1]),
        scoreAway: parseInt(scoreMatch[2]),
        result,
        publicVote,
      })
    })

    if (matches.length === 0) {
      logger.warn(`[TN-PARSE] Grid ${gridNo}: No matches parsed`)
      return null
    }

    matches.sort((a, b) => a.idx - b.idx)

    return {
      no: gridNoDetected,
      cagnotte,
      matches: matches.slice(0, 13),
      source: 'promosport-pronostic.com',
    }
  } catch (err) {
    logger.error(`[TN-PARSE] Grid ${gridNo}: ${err.message}`)
    return null
  }
}

async function scrapeBatch(fromGrid = 870, toGrid = 876) {
  const results = []
  for (let g = fromGrid; g <= toGrid; g++) {
    const grid = await scrapeTunisieGrid(g)
    if (grid && grid.matches.length >= 5) {
      results.push(grid)
      logger.info(`[TN-PARSE] Grid ${g}: ${grid.matches.length} matches`)
    }
  }
  return results
}

module.exports = { scrapeTunisieGrid, scrapeBatch }
