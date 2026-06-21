const http = require('http');

const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/refresh-upcoming',
    method: 'POST'
};

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
        console.log('Refresh response:', body);
    });
});

req.on('error', (e) => {
    console.error('Refresh failed:', e.message);
});

req.end();
