const { spawn, exec } = require('child_process');
const path = require('path');

const SERVER_SCRIPT = path.join(__dirname, 'server.js');
const MAX_RESTARTS = 10;
let restartCount = 0;

function startServer() {
    console.log('🛡️  ANTI-ERROR SYSTEM: Starting Titanium Server...');

    // Spawn server.js
    const server = spawn('node', [SERVER_SCRIPT], {
        stdio: 'inherit', // Pipe output directly to console
        shell: true
    });

    server.on('close', (code) => {
        if (code === 0) {
            console.log('✅ Server stopped gracefully.');
            process.exit(0);
        } else {
            console.error(`❌ Server crashed with code ${code}`);
            handleCrash(code);
        }
    });

    server.on('error', (err) => {
        console.error('❌ Failed to start server:', err);
        handleCrash(1);
    });
}

function handleCrash(code) {
    restartCount++;
    console.log(`⚠️  Restarting... (${restartCount}/${MAX_RESTARTS})`);

    // Check for EADDRINUSE logic (Surgical fix for 3000 port)
    console.log('🔧 AUTO-FIX: Clearing port 3000...');

    // Windows specifically: find PID on port 3000 and kill it
    const command = 'netstat -ano | findstr :3000';
    exec(command, (err, stdout, stderr) => {
        if (stdout) {
            const lines = stdout.trim().split('\n');
            lines.forEach(line => {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0' && pid !== process.pid.toString()) {
                    console.log(`🗡️  Killing process ${pid} using port 3000...`);
                    exec(`taskkill /F /PID ${pid}`);
                }
            });
        }

        // Prepare to restart
        setTimeout(() => {
            if (restartCount < MAX_RESTARTS) {
                startServer();
            } else {
                console.error('🚨 CRITICAL: Too many crashes. Stopping.');
                process.exit(1);
            }
        }, 3000); // 3 second cooldown for port release
    });
}

// Start the supervisor
startServer();
