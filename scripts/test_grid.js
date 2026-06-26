const scrape = require('../core/promosport_scraper')
const fs = require('fs')

async function test() {
  const grid876 = await scrape.scrapePromosportGrid(876)
  console.log('Grid 876:', JSON.stringify(grid876, null, 2))
}

test().catch(console.error)
