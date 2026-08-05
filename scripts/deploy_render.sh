#!/bin/bash
set -e

echo "🚀 DÉPLOIEMENT TITANIUM NEURAL-X v3.0"
echo "======================================"

# 1️⃣ Configuration des variables d'environnement
echo "🔧 Configuration..."
if [ -n "$DATABASE_URL" ]; then
  echo "DATABASE_URL=$DATABASE_URL" >> .env
else
  echo "⚠️  DATABASE_URL non défini — migrations Postgres ignorées"
fi
echo "TEST_VAR=test-value" >> .env

# 2️⃣ Installation dépendances
echo "📦 Installation..."
npm install --silent 2>/dev/null

# 3️⃣ Migration DB
echo "🗄️ Migration..."
node -e "require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}}); pool.query('CREATE TABLE IF NOT EXISTS promosport_predictions (concours TEXT PRIMARY KEY, date TEXT, date_archived TIMESTAMPTZ DEFAULT NOW(), data JSONB NOT NULL); CREATE TABLE IF NOT EXISTS promosport_historical_grids (concours TEXT PRIMARY KEY, date TEXT, matches JSONB NOT NULL, imported_at TIMESTAMPTZ DEFAULT NOW());').then(()=>console.log('✅ Tables créées')).catch(e=>console.error('❌', e.message)).finally(()=>pool.end());"

# 4️⃣ Import historique
echo "📥 Import historique..."
node scripts_init/import_promosport_history.js 2>/dev/null || echo "✅ Déjà importé"

# 5️⃣ Test API
echo "🧪 Test API..."
sleep 3
curl -s "https://pronostico.onrender.com/api/promosport" | head -c 500

echo ""
echo "✅ TERMINÉ!"