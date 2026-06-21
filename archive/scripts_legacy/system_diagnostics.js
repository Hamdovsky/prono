const axios = require('axios');
const chalk = require('chalk');

async function runDiagnostics() {
  console.log(chalk.blue.bold('\n🔍 [DIAGNOSTICS] Starting Titanium AI System Audit...\n'));

  const endpoints = [
    { name: 'Gateway Node.js', url: 'http://localhost:3001/health' },
    { name: 'Inference FastAPI', url: 'http://fastapi-ml:8000/health' }
  ];

  for (const endpoint of endpoints) {
    try {
      const start = Date.now();
      const response = await axios.get(endpoint.url, { timeout: 5000 });
      const latency = Date.now() - start;

      console.log(chalk.green(`✅ [${endpoint.name}] Online (${latency}ms)`));
      console.log(JSON.stringify(response.data, null, 2));
      console.log('--------------------------------------------------');
    } catch (err) {
      console.log(chalk.red(`❌ [${endpoint.name}] Offline or Error: ${err.message}`));
      if (err.response) {
        console.log(JSON.stringify(err.response.data, null, 2));
      }
      console.log('--------------------------------------------------');
    }
  }

  console.log(chalk.blue.bold('\n✨ Diagnostics Complete.\n'));
}

if (require.main === module) {
  runDiagnostics();
}
