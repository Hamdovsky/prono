#!/bin/bash

# ============================================
# Replit Start Script — Titanium AI
# ============================================

echo "🚀 Starting Titanium AI on Replit..."

# ── 1. Install Python dependencies ──────────
echo "📦 Installing Python dependencies..."
pip install --break-system-packages -r requirements-fastapi.txt 2>/dev/null || \
pip3 install --break-system-packages -r requirements-fastapi.txt 2>/dev/null || \
echo "⚠️  pip failed, trying manual install..."
pip install --break-system-packages fastapi uvicorn pydantic numpy pandas scipy xgboost scikit-learn psycopg2-binary redis httpx requests joblib beautifulsoup4 lxml 2>/dev/null || \
echo "⚠️  Some Python packages failed"

# ── 2. Install Node.js dependencies ─────────
echo "📦 Installing Node.js dependencies..."
npm install --omit=dev 2>/dev/null || echo "⚠️  npm install had issues"

# ── 3. Build frontend ───────────────────────
echo "🔨 Building frontend..."
npm run build 2>/dev/null || echo "⚠️  Build failed, continuing..."

# ── 4. Create necessary directories ────────
mkdir -p logs data

# ── 5. Start Python FastAPI in background ───
echo "🐍 Starting Python FastAPI on port 8000..."
PYTHONPATH=$(pwd)/core:$(pwd) python3 -m uvicorn core.fastapi_server:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers 1 &
FASTAPI_PID=$!
echo "   FastAPI PID: $FASTAPI_PID"

# Wait for FastAPI to be ready
echo "⏳ Waiting for FastAPI to start..."
sleep 5

# ── 6. Start Node.js server ────────────────
echo "🟢 Starting Node.js server on port ${PORT:-3000}..."
export INFERENCE_URL="http://127.0.0.1:8000"
export PORT="${PORT:-3000}"
export NODE_ENV=production
export PYTHONUNBUFFERED=1

node --expose-gc --max-old-space-size=512 server.js
