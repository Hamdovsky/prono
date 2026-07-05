const axios = require('axios');
const https = require('https');
const http = require('http');
const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error
};

async function scrapePromosportOdds() {
  const url = 'https://www.promosportplus.com/promosport-concours-de-la-semaine';
  console.log(`📡 Fetching odds from ${url}`);
  
  try {
    const response = await axios.get(url, {
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },
      timeout: 30000, // Increased from 10000 to 30000
      decompress: true
    });

    const html = response.data;
    if (!html || typeof html !== 'string') {
      console.log('❌ No HTML returned');
      return null;
    }
    console.log(`✅ HTML received: ${html.length} bytes`);

    // 1. Extract Concours Metadata
    const concoursMatch = html.match(/(?:Concours\s+)?Promosport\s+N[°o]?\s*(\d+)\s+du\s+(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i);
    const concoursNumber = concoursMatch ? concoursMatch[1] : 'unknown';
    const concoursDate = concoursMatch ? concoursMatch[2] : new Date().toLocaleDateString();
    console.log(`\n📋 Concours N°${concoursNumber} du ${concoursDate}`);

    // 2. Identify Match Rows with num_match class
    const matches = [];
    const trBlocks = html.split(/<tr[^>]*>/i).slice(1);

    for (const block of trBlocks) {
      if (!block.includes("num_match")) continue;

      try {
        // Extract Match ID
        const idMatch = block.match(/<span class='num_match'>(\d+)<\/span>/i);
        if (!idMatch) continue;
        const id = idMatch[1];

        // Extract Day and Time
        const dayMatch = block.match(/<span class='dateenvoi'>([a-z]{3})<\/span>/i);
        const timeAttrMatch = block.match(/title='[^']*à\s*([\d:]+)'/i);
        const matchTime = `${dayMatch ? dayMatch[1] : '---'} ${timeAttrMatch ? timeAttrMatch[1] : ''}`.trim();

        // Extract Teams
        const equipeMatches = [...block.matchAll(/<td class='equipe[^']*'>[\s\S]*?<img[^>]*>\s*([^<]+?)\s*(?:<span|<\/td>)/gi)];
        if (equipeMatches.length < 2) continue;

        let homeTeam = equipeMatches[0][1].trim().replace(/<.*$/, '').trim();
        let awayTeam = equipeMatches[1][1].trim().replace(/<.*$/, '').trim();

        // Extract Probabilities (lm6 class)
        const probMatches = [];
        const probRegex = /<td class='lm6'[^>]*>(\d+)%<\/td>/gi;
        let pm;
        while ((pm = probRegex.exec(block)) !== null) {
          probMatches.push(parseInt(pm[1]));
        }

        if (homeTeam !== "Unknown" && awayTeam !== "Unknown" && probMatches.length >= 3) {
          matches.push({
            id: parseInt(id),
            date: matchTime,
            homeTeam: homeTeam.replace(/\s+/g, ' '),
            awayTeam: awayTeam.replace(/\s+/g, ' '),
            p1: probMatches[0],
            px: probMatches[1],
            p2: probMatches[2]
          });
        }
      } catch (e) {
        console.error(`Error parsing block: ${e.message}`);
      }
    }

    console.log(`\n📊 Found ${matches.length} matches with odds`);
    if (matches.length > 0) {
      matches.sort((a, b) => a.id - b.id);
      console.log('\n' + '='.repeat(80));
      console.log('ID'.padEnd(4) + 'Date'.padEnd(12) + 'Home'.padEnd(22) + '1%'.padEnd(6) + 'X%'.padEnd(6) + '2%'.padEnd(6) + 'Away');
      console.log('='.repeat(80));
      matches.forEach(m => {
        console.log(
          String(m.id).padEnd(4) +
          m.date.padEnd(12) +
          m.homeTeam.padEnd(22) +
          String(m.p1).padEnd(6) + '%' +
          String(m.px).padEnd(5) + '%' +
          String(m.p2).padEnd(5) + '%' +
          m.awayTeam
        );
      });
    }
    return matches;
  } catch (err) {
    console.error(`❌ Scrape error: ${err.message}`);
    if (err.code === 'ECONNABORTED') console.error('   → Timeout: le site met trop de temps à répondre');
    if (err.code === 'ERR_TIMEOUT') console.error('   → Timeout: le site met trop de temps à répondre');
    return null;
  }
}

scrapePromosportOdds().then(matches => {
  if (matches) {
    console.log('\n✅ Scrape réussi!');
    process.exit(0);
  } else {
    console.log('\n❌ Scrape échoué');
    process.exit(1);
  }
});
