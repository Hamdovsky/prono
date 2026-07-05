const axios = require('axios');
const https = require('https');
async function test() {
  const r = await axios.get('https://www.promosport-pronostic.com/index.php/welcome/promo_pronostic?jeux=Promosport', {
    httpsAgent: new https.Agent({ keepAlive: true }),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9'
    },
    timeout: 30000
  });
  const html = r.data;
  
  // Extract f_table area
  const idPos = html.indexOf('id="f_table"');
  const tableOpen = html.lastIndexOf('<table', idPos);
  const tableClose = html.indexOf('</table>', idPos);
  const tableHtml = html.substring(tableOpen, tableClose + 8);
  
  // Write the table HTML to file for inspection
  require('fs').writeFileSync('_f_table_debug.html', tableHtml);
  console.log('Table HTML written to _f_table_debug.html');
  
  function parsePromosportPronostic(html) {
    let concoursNumber = '878';
    let concoursDate = new Date().toISOString().slice(0, 10);
    const titleMatch = html.match(/Promosport N[°]\s*(\d+)/i);
    if (titleMatch) concoursNumber = titleMatch[1];
    const dateMatch = html.match(/Du\s+(\d{4}-\d{2}-\d{2})\s+/i);
    if (dateMatch) concoursDate = dateMatch[1];
    
    const tableId = 'id="f_table"';
    const idPos = html.indexOf(tableId);
    if (idPos === -1) return [];
    
    const tableOpen = html.lastIndexOf('<table', idPos);
    const tableClose = html.indexOf('</table>', idPos);
    if (tableOpen === -1 || tableClose === -1) return [];
    
    const tableHtml = html.substring(tableOpen, tableClose + 8);
    
    const matches = [];
    let pos = 0;
    let rowNum = 0;
    
    while ((pos = tableHtml.indexOf('<tr', pos)) !== -1) {
      const trEnd = tableHtml.indexOf('</tr>', pos);
      if (trEnd === -1) break;
      const row = tableHtml.substring(pos, trEnd + 5);
      rowNum++;
      if (rowNum === 1) { pos = trEnd + 5; continue; }
      
      const numMatch = row.match(/<p[^>]*style=['"][^'"]*text-align:\s*center[^'"]*['"][^>]*>\s*(?:<a[^>]*>\s*)?(\d+)\s*(?:<\/a>\s*)?<\/p>/i);
      if (!numMatch) { 
        console.log('Row', rowNum, '- No match number found');
        console.log('First 200 chars:', row.substring(0, 200));
        pos = trEnd + 5; 
        continue; 
      }
      const id = parseInt(numMatch[1]);
      if (id < 1 || id > 13) { pos = trEnd + 5; continue; }
      
      const teamLinks = [];
      const linkRegex = /<a[^>]*class="nline"[^>]*>([^<]+)<\/a>/gi;
      let linkMatch;
      while ((linkMatch = linkRegex.exec(row)) !== null) {
        const text = linkMatch[1].trim();
        if (text.length > 1) teamLinks.push(text);
      }
      
      if (teamLinks.length < 2) {
        console.log('Row', rowNum, 'id=', id, '- Found only', teamLinks.length, 'teams:', teamLinks);
        pos = trEnd + 5; 
        continue;
      }
      
      matches.push({
        id,
        homeTeam: teamLinks[0].toUpperCase(),
        awayTeam: teamLinks[1].toUpperCase(),
        leagueName: 'Promosport',
        homeWinProbability: 0.33,
        drawProbability: 0.33,
        awayWinProbability: 0.34,
        matchTime: '---',
        concoursDate,
        concoursNumber
      });
      
      pos = trEnd + 5;
      if (matches.length >= 13) break;
    }
    
    const uniqueIds = new Set(matches.map(m => m.id));
    console.log('Unique IDs:', uniqueIds.size, 'of', matches.length, 'matches');
    if (uniqueIds.size !== 13) {
      console.log('IDs found:', [...uniqueIds].sort().join(','));
      return [];
    }
    
    return matches.sort((a, b) => a.id - b.id);
  }
  
  const result = parsePromosportPronostic(html);
  console.log('Parse result length:', result.length);
  if (result.length > 0) {
    console.log('First match:', JSON.stringify(result[0], null, 2));
  }
}
test().catch(e => console.error('FATAL:', e.message, e.stack));
