
const http = require('http');
const { spawn } = require('child_process');

console.log('Starting Titanium Server...');
const server = spawn('node', ['server.js'], { 
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3001' }
});

server.stdout.on('data', (data) => {
    process.stdout.write(data);
    if (data.toString().includes('Titanium Server listening')) {
        console.log('\n--- Server is UP. Testing routes ---');
        testRoutes();
    }
});

server.stderr.on('data', (data) => {
    process.stderr.write('\x1b[31m' + data + '\x1b[0m');
});

function testRoutes() {
    const routes = ['/api/health', '/api/live', '/api/upcoming', '/api/combos'];
    let index = 0;

    function next() {
        if (index >= routes.length) {
            console.log('\n--- All tests passed! ---');
            server.kill();
            process.exit(0);
        }
        const route = routes[index++];
        console.log(`\nTesting ${route}...`);
        
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3001,
            path: route,
            method: 'GET'
        }, (res) => {
            console.log(`STATUS [${route}]: ${res.statusCode}`);
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                console.log('BODY length:', body.length);
                if (res.statusCode !== 200) {
                    console.error('ERROR BODY:', body);
                    server.kill();
                    process.exit(1);
                }
                next();
            });
        });

        req.on('error', (e) => {
            console.error(`\nPROBLEM WITH ${route}: ${e.message}`);
            server.kill();
            process.exit(1);
        });
        req.end();
    }
    next();
}

setTimeout(() => {
    console.error('\nTimeout waiting for server to start');
    server.kill();
    process.exit(1);
}, 45000);
