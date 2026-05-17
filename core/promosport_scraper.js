const axios = require('axios');
const http = require('http');
const https = require('https');
const logger = require('./logger');
const config = require('./configEngine');
const CircuitBreaker = require('./circuitBreaker');
const sofacoreBreaker = require('./circuitBreaker').breakers.sofacore;

async function scrapePromosport() {
  try {
    return await sofacoreBreaker.call(async () => {
      const url = config.promosportUrl || 'http://www.promosportplus.com/promosport-concours-de-la-semaine';
      logger.info(`📡 [SCRAPER] Requesting Promosport grid from: ${url}`);
      
      const response = await axios.get(url, {
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true }),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        },
        timeout: 10000
      });

      const html = response.data;
      if (!html || typeof html !== 'string') return [];

      // 1. Extract Concours Metadata
      const concoursMatch = html.match(/Concours\s+Promosport\s+No\s+(\d+)\s+du\s+([\d/]+)\s+\(([\d:]+)\)/i);
      const concoursDate = concoursMatch ? `${concoursMatch[2]} ${concoursMatch[3]}` : new Date().toLocaleDateString();
      const concoursNumber = concoursMatch ? concoursMatch[1] : '855';

      // 2. Identify Match Rows
      // Each match is in a <tr> with <span class='num_match'>
      const matches = [];
      const trBlocks = html.split(/<tr[^>]*>/i).slice(1); // Split by <tr> and skip header

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
          
          let homeTeam = equipeMatches[0][1].trim();
          let awayTeam = equipeMatches[1][1].trim();

          // Clean names (remove trailing span/tags if any)
          homeTeam = homeTeam.replace(/<.*$/, '').trim();
          awayTeam = awayTeam.replace(/<.*$/, '').trim();

          // Extract Probabilities (lm6 class)
          const probMatches = [];
          const probRegex = /<td class='lm6'[^>]*>(\d+)%<\/td>/gi;
          let pm;
          while ((pm = probRegex.exec(block)) !== null) {
            probMatches.push(parseInt(pm[1]) / 100);
          }

          if (homeTeam !== "Unknown" && awayTeam !== "Unknown" && probMatches.length >= 3) {
            matches.push({
              id: parseInt(id),
              homeTeam: homeTeam.replace(/\s+/g, ' '),
              awayTeam: awayTeam.replace(/\s+/g, ' '),
              leagueName: 'Promosport',
              homeWinProbability: probMatches[0],
              drawProbability: probMatches[1],
              awayWinProbability: probMatches[2],
              matchTime,
              concoursDate,
              concoursNumber
            });
          }
        } catch (e) {
          logger.error(`[SCRAPER] Error parsing block: ${e.message}`);
        }
      }

      // FINAL VALIDATION
      const sanitized = matches.filter(m => m.homeTeam.length < 35 && m.awayTeam.length < 35);
      
      if (sanitized.length < 13) {
          logger.warn(`⚠️ [SCRAPER] Scrape found only ${sanitized.length} matches. Rejection triggered.`);
          return [];
      }

      logger.info(`✅ [SCRAPER] ${sanitized.length} matches parsed successfully with real-time stats.`);
      return sanitized.slice(0, 13);
    });
  } catch (err) {
    logger.error('[PROMOSPORT] Scrape fatal error:', err.message);
    return [];
  }
}

module.exports = { scrapePromosport };
