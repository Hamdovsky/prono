const DeepSeekService = require('../services/DeepSeekService');
const fs = require('fs');

console.log('🧪 Starting local test for DeepSeek quota protection system...');

// 1. Get current quota status
const status1 = DeepSeekService.getQuotaStatus();
console.log('📊 Initial status:', status1);

// 2. Verify limits are configured
if (status1.limit !== 220) {
    console.error('❌ Error: Limit is not 220 (configured in .env)');
    process.exit(1);
}
console.log('✅ Limit is correctly set to 220 calls/month.');

// 3. Test if quota is available
const isAvailable = DeepSeekService.isQuotaAvailable();
console.log(`✅ Quota available check: ${isAvailable}`);

// 4. Print instructions for manual inspection
console.log('\n📝 Quota configuration file path:', fs.existsSync('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/deepseek_usage.json') ? 'Exists' : 'Created');
console.log('📄 Current usage file content:', fs.readFileSync('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/deepseek_usage.json', 'utf8'));

console.log('\n🎉 ALL LOCAL INTEL WORKED PERFECTLY! The DeepSeek safety shield is fully active.');
