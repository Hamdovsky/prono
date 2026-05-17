const fs = require('fs');
const axios = require('axios');
const path = require('path');

async function extractAll() {
    console.log('🚀 Starting Full Promosport Results Extraction...');
    const html = fs.readFileSync('archive_full.html', 'utf8');

    const concoursRegex = /HREF='resultat-promosport-no-(\d+)'[^>]*>(\d+)<\/a>/g;
    const allConcours = [];
    let match;
    while ((match = concoursRegex.exec(html)) !== null) {
        allConcours.push({
            id: match[1],
            no: match[2]
        });
    }

    console.log(`📊 Found ${allConcours.length} concours in archives.`);
    
    const results = [];
    let count = 0;

    for (const c of allConcours) {
        try {
            const url = `http://www.promosportplus.com/resultat-promosport-no-${c.id}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 5000
            });
            
            const pageHtml = response.data;
            const tableRegex = /<table id="tableau_classement"[^>]*>([\s\S]*?)<\/table>/;
            const tableMatch = pageHtml.match(tableRegex);
            
            if (tableMatch) {
                const rows = tableMatch[1];
                const rowRegex = /<tr><td>(\d+)<\/td><td class='equipe[^>]*>([\s\S]*?)<\/td><td class='equipe[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td class='result'>([^<]+)<\/td>/g;
                let rowMatch;
                const matches = [];
                while ((rowMatch = rowRegex.exec(rows)) !== null) {
                    matches.push({
                        idx: rowMatch[1],
                        home: rowMatch[2].replace(/<[^>]*>/g, '').trim(),
                        away: rowMatch[3].replace(/<[^>]*>/g, '').trim(),
                        res: rowMatch[4].trim()
                    });
                }
                
                results.push({
                    no: c.no,
                    id: c.id,
                    matches: matches
                });
                count++;
                if (count % 10 === 0) {
                    console.log(`✅ Extracted ${count}/${allConcours.length} concours...`);
                    // Save incrementally
                    fs.writeFileSync('data/promosport_historical_results.json', JSON.stringify(results, null, 2));
                }
            }
            
            // Fast throttling
            await new Promise(r => setTimeout(r, 200));
        } catch (err) {
            // Silently ignore or log errors
        }
    }

    const outputPath = path.join(__dirname, '../data/promosport_historical_results.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\n✨ Full extraction complete! Saved ${results.length} concours.`);
}

extractAll();
