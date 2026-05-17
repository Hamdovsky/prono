
const http = require('http');
const { spawn } = require('child_process');

console.log('Starting Hardened Titanium Server...');
const server = spawn('node', ['server.js'], { 
    cwd: process.cwd(),
    env: { ...process.env, PORT: '3001' }
});

server.stdout.on('data', (data) => {
    process.stdout.write(data);
    if (data.toString().includes('Titanium Server listening')) {
        console.log('\n--- Server is UP. Testing socket.io polling ---');
        testSocketIO();
    }
});

server.stderr.on('data', (data) => {
    process.stderr.write('\x1b[31m' + data + '\x1b[0m');
});

function testSocketIO() {
    const route = '/socket.io/?EIO=4&transport=polling';
    console.log(`\nTesting ${route}...`);
    
    const req = http.request({
        hostname: '127.0.0.1',
        port: 3001,
        path: route,
        method: 'GET'
    }, (res) => {
        console.log(`STATUS: ${res.statusCode}`);
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            console.log('BODY:', body.substring(0, 100));
            if (res.statusCode === 200) {
                console.log('✅ Socket.io polling OK');
                server.kill();
                process.exit(0);
            } else {
                console.error('❌ Socket.io polling FAILED');
                server.kill();
                process.exit(1);
            }
        });
    });

    req.on('error', (e) => {
        console.error(`\nPROBLEM: ${e.message}`);
        server.kill();
        process.exit(1);
    });
    req.end();
}

setTimeout(() => {
    console.error('\nTimeout');
    server.kill();
    process.exit(1);
}, 45000);
