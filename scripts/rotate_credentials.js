const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NEW_API_SECRET = crypto.randomBytes(32).toString('hex');

const OLD_API_SECRET = process.env.OLD_API_SECRET || '8d6b2de5208b41f34b15fb93121dd72bd5eee734dc3b29c9';
const OLD_RENDER_KEY_1 = process.env.OLD_RENDER_KEY_1 || 'rnd_BjMptWe5fHH766B8wNBCs9vGQHZj';
const OLD_RENDER_KEY_2 = process.env.OLD_RENDER_KEY_2 || 'rnd_9qe0wyfpN1GEBRX4ELHx2BqnMtJ1';
const NEON_PROJECT_ID = process.env.NEON_PROJECT_ID || 'ep-wandering-wave-atp6q80z';

async function main() {
  console.log('=== ROTATION DES CREDENTIALS ===\n');

  console.log('[1] Nouvelle API_SECRET_KEY:', NEW_API_SECRET.substring(0, 16) + '...');
  console.log(`  Compatible avec: tous les services Render (API_SECRET_KEY env var)`);

  // Render API
  console.log('\n[2] Tentative rotation Render API keys...');
  for (const [name, key] of Object.entries({
    account1: OLD_RENDER_KEY_1,
    account2: OLD_RENDER_KEY_2,
  })) {
    try {
      const res = await axios.post('https://api.render.com/v1/user/api-keys/rotate', {}, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 15000,
      });
      console.log(`  ✅ ${name}: ${res.data?.apiKey?.substring(0, 20)}...`);
    } catch (e) {
      console.log(`  ❌ ${name}: ${e.response?.status} ${e.response?.data?.message || e.message}`);
      console.log(`     → Dashboard: https://dashboard.render.com/u/api-keys`);
    }
  }

  // Neon password reset via API
  console.log('\n[3] Tentative rotation Neon...');
  try {
    const res = await axios.post(`https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/actions/reset_password`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    console.log(`  ✅ Neon: ${res.status}`);
  } catch (e) {
    console.log(`  ❌ Neon: ${e.response?.status} — nécessite clé API Neon`);
    console.log(`     → Dashboard: https://console.neon.tech`);
  }

  console.log('\n=== RÉSUMÉ ===');
  console.log('Nouvelle API_SECRET_KEY:', NEW_API_SECRET);
  console.log('Actions manuelles requises:');
  console.log('  1. Render Account 1: https://dashboard.render.com/u/api-keys');
  console.log('  2. Render Account 2: https://dashboard.render.com/u/api-keys (déconnecter/reconnecter)');
  console.log('  3. Neon: https://console.neon.tech → Reset password');
  console.log('  4. Upstash: https://console.upstash.com → Reset password');
  console.log('  5. Mettre à jour API_SECRET_KEY sur TOUS les services Render (Dashboard → Environment)');
  console.log('\nAprès rotation manuelle, mettre à jour AGENTS.md avec les nouveaux credentials.');
}

main().catch(console.error);
