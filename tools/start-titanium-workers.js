require('dotenv').config();
const { worker } = require('./src/TitaniumLive/Workforce');

console.log('🚀 [TITANIUM WORKFORCE] Worker Thread Pool Started');
console.log('📡 Waiting for matches to be assigned from the queue...');

// Worker is automatically started when imported. We just keep the process alive
process.stdin.resume();

process.on('SIGINT', async () => {
    console.log('\n[WORKFORCE] Shutting down workers...');
    await worker.close();
    process.exit(0);
});
