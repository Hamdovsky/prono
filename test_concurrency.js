
const http = require('http');
const { spawn } = require('child_process');

console.log('Starting Titanium Server (Concurrency Test)...');
const server = spawn('node', ['server.js'], { 
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3001' }
});

server.stdout.on('data', (data) => {
    process.stdout.write(data);
    if (data.toString().includes('Titanium Server listening')) {
        console.log('\n--- Server is UP. Launching concurrent requests ---');
        runConcurrencyTest();
    }
});

server.stderr.on('data', (data) => {
    process.stderr.write('\x1b[31m' + data + '\x1b[0m');
});

function runConcurrencyTest() {
    const routes = [
        '/api/health', '/api/live', '/api/upcoming', '/api/combos',
        '/api/health', '/api/live', '/api/upcoming', '/api/combos',
        '/api/health', '/api/live', '/api/upcoming', '/api/combos'
    ];
    let completed = 0;
    let failed = 0;

    routes.forEach((route, i) => {
        setTimeout(() => {
            console.log(`[Req ${i}] Sending GET ${route}...`);
            const req = http.request({
                hostname: '127.0.0.1',
                port: 3001,
                path: route,
                method: 'GET'
            }, (res) => {
                console.log(`[Req ${i}] STATUS: ${res.statusCode}`);
                let body = '';
                res.on('data', (d) => body += d);
                res.on('end', () => {
                    completed++;
                    if (res.statusCode !== 200) {
                        failed++;
                        console.error(`[Req ${i}] FAILED with ${res.statusCode}: ${body.substring(0, 100)}`);
                    }
                    checkDone();
                });
            });

            req.on('error', (e) => {
                completed++;
                failed++;
                console.error(`[Req ${i}] NETWORK ERROR: ${e.message}`);
                checkDone();
            });
            req.end();
        }, i * 50); // Small stagger
    });

    function checkDone() {
        if (completed === routes.length) {
            console.log(`\n--- Concurrency Test Finished. Failed: ${failed}/${routes.length} ---`);
            server.kill();
            process.exit(failed > 0 ? 1 : 0);
        }
    }
}

setTimeout(() => {
    console.error('\nTimeout waiting for server to start');
    server.kill();
    process.exit(1);
}, 60000);
