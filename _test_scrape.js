const axios = require('axios');
const https = require('https');
async function test() {
  try {
    const r = await axios.get('https://www.promosport-pronostic.com/index.php/welcome/promo_pronostic?jeux=Promosport', {
      httpsAgent: new https.Agent({ keepAlive: true }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      },
      timeout: 30000
    });
    console.log('STATUS:', r.status);
    console.log('HTML length:', r.data.length);
    const html = r.data;
    console.log('Has f_table:', html.includes('id="f_table"'));
    const idPos = html.indexOf('id="f_table"');
    console.log('f_table position:', idPos);
    if (idPos >= 0) {
      const tableOpen = html.lastIndexOf('<table', idPos);
      const tableClose = html.indexOf('</table>', idPos);
      console.log('tableOpen:', tableOpen, 'tableClose:', tableClose);
      const tableHtml = html.substring(tableOpen, tableClose + 8);
      console.log('table HTML length:', tableHtml.length);
      const trCount = (tableHtml.match(/<tr/gi) || []).length;
      console.log('tr count:', trCount);
      const numMatches = (tableHtml.match(/class=.num_match./gi) || []).length;
      console.log('num_match count:', numMatches);
    }
  } catch(e) {
    console.error('ERROR:', e.message);
  }
  // Also test promosportplus.com
  try {
    console.log('\n--- Testing promosportplus.com ---');
    const r2 = await axios.get('https://www.promosportplus.com/promosport-concours-de-la-semaine', {
      httpsAgent: new https.Agent({ keepAlive: true }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      },
      timeout: 15000
    });
    console.log('STATUS:', r2.status);
    console.log('HTML length:', r2.data.length);
    const h = r2.data;
    console.log('Has num_match:', h.includes("num_match"));
    const trBlocks = h.split(/<tr[^>]*>/i).length;
    console.log('tr blocks count:', trBlocks);
    const numMatchSpans = (h.match(/<span class='num_match'>/gi) || []).length;
    console.log('num_match span count:', numMatchSpans);
  } catch(e) {
    console.error('promosportplus ERROR:', e.message);
  }
}
test();
