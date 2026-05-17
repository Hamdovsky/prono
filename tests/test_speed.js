const http = require('http');

const start = Date.now();
http.get('http://127.0.0.1:5000/api/upcoming', (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        const end = Date.now();
        console.log(`Time taken: ${end - start}ms`);
        try {
            const data = JSON.parse(body);
            console.log(`Received ${data.length} matches.`);
            if (data.length > 0) {
                const m = data[0];
                console.log('Sample Match:', m.homeTeam, 'vs', m.awayTeam);
                console.log('Enrichment Status:', m.xgboost_prediction_data ? 'ENRICHED' : 'PENDING');
            }
        } catch (e) {
            console.log('Error parsing JSON');
        }
    });
}).on('error', (err) => {
    console.error('Error fetching:', err.message);
});
