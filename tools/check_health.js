const http = require('http');

http.get('http://127.0.0.1:5000/api/health', (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        try {
            const data = JSON.parse(body);
            console.log('Health Data:', JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('Raw Health Body:', body);
        }
    });
}).on('error', (err) => {
    console.error('Error fetching health:', err.message);
});
