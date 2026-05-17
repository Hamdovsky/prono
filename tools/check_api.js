const http = require('http');

http.get('http://127.0.0.1:5000/api/upcoming', (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        try {
            const data = JSON.parse(body);
            console.log(`Received ${data.length} matches.`);
            if (data.length > 0) {
                console.log('Sample Match:', JSON.stringify(data[0], null, 2));
            }
        } catch (e) {
            console.log('Raw Upcoming Body:', body);
        }
    });
}).on('error', (err) => {
    console.error('Error fetching upcoming:', err.message);
});
