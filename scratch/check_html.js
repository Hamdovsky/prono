const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function debug() {
    const url = 'http://www.promosportplus.com/promosport-concours-de-la-semaine';
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    const html = response.data;
    fs.writeFileSync('debug_promosport.html', html);
    
    const trBlocks = html.split(/<tr[^>]*>/i).slice(1);
    console.log(`Total TR blocks: ${trBlocks.length}`);
    
    for (let i = 0; i < Math.min(10, trBlocks.length); i++) {
        console.log(`--- BLOCK ${i} ---`);
        console.log(trBlocks[i].substring(0, 500));
    }
}

debug();
