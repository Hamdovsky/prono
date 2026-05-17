const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

(async () => {
    try {
        console.log('🚀 [REDIS] Initializing Official Native Redis for Windows...');
        
        // 1. Cleanup old instances
        try {
            if (process.platform === 'win32') {
                execSync('taskkill /F /IM redis-server.exe /T', { stdio: 'ignore' });
            }
        } catch (_) {}

        const redisPath = path.join(__dirname, '..', 'bin', 'redis', 'redis-server.exe');
        
        if (!fs.existsSync(redisPath)) {
            console.error('❌ [REDIS] Native Redis binary not found at:', redisPath);
            process.exit(1);
        }

        // 2. Launch Official Redis (with save disabled to prevent Windows fork failure issues)
        const redisProcess = spawn(redisPath, ['--save', ''], {
            cwd: path.join(__dirname, '..', 'bin', 'redis'),
            stdio: 'inherit'
        });

        console.log(`✅ [REDIS] Official Server active on port 6379 (Persistence Disabled).`);

        redisProcess.on('error', (err) => {
            console.error('❌ [REDIS] Process error:', err);
        });

        process.on('SIGINT', () => {
            console.log('\n🛑 [REDIS] Shutting down...');
            redisProcess.kill();
            process.exit(0);
        });

    } catch (err) {
        console.error('❌ [REDIS] Critical Failure:', err);
    }
})();
