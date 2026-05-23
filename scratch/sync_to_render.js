const D = require('better-sqlite3');
const https = require('https');
const db = new D('data/tactical.db', { readonly: true });

console.log('Loading matches from local database...');
const matches = db.prepare('SELECT * FROM matches').all();
console.log(`Loaded ${matches.length} matches from local database.`);

// Group into chunks of 100 matches to prevent payload limits
const CHUNK_SIZE = 100;
const chunks = [];
for (let i = 0; i < matches.length; i += CHUNK_SIZE) {
    chunks.push(matches.slice(i, i + CHUNK_SIZE));
}

console.log(`Prepared ${chunks.length} chunks of ${CHUNK_SIZE} matches each.`);

async function sendChunk(chunk, index) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ matches: chunk });
        
        const req = https.request({
            hostname: 'prono-l5e3.onrender.com',
            port: 443,
            path: '/api/sync-matches',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`[Chunk ${index + 1}/${chunks.length}] Success! StatusCode: 200`);
                    resolve(JSON.parse(data));
                } else {
                    console.error(`[Chunk ${index + 1}/${chunks.length}] Failed with StatusCode ${res.statusCode}: ${data}`);
                    reject(new Error(`Status: ${res.statusCode}`));
                }
            });
        });

        req.on('error', (e) => {
            console.error(`[Chunk ${index + 1}/${chunks.length}] Network error:`, e.message);
            reject(e);
        });

        req.write(payload);
        req.end();
    });
}

async function runSync() {
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Sending chunk ${i + 1}/${chunks.length}...`);
        try {
            await sendChunk(chunks[i], i);
            // Sleep slightly between requests to not overwhelm Render
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.error(`Error at chunk ${i + 1}:`, e.message);
        }
    }
    console.log('Synchronization complete!');
    db.close();
}

runSync();
