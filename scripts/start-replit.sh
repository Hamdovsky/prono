#!/bin/bash

echo "============================================"
echo "  Titanium AI — Replit Launcher"
echo "============================================"

# ── 1. Install Python dependencies ──────────
echo "[1/6] Installing Python dependencies..."
pip3 install --break-system-packages -r requirements-fastapi.txt 2>&1 | tail -3 || \
pip install --break-system-packages fastapi uvicorn pydantic numpy pandas scipy xgboost scikit-learn psycopg2-binary redis httpx requests joblib beautifulsoup4 lxml 2>&1 | tail -3 || \
echo "WARN: Some Python packages failed"

# ── 2. Install Node.js dependencies ─────────
echo "[2/6] Installing Node.js dependencies..."
npm install 2>&1 | tail -3

# ── 3. Build frontend ───────────────────────
echo "[3/6] Building frontend..."
npm run build 2>&1 | tail -3 || echo "WARN: Build skipped"

# ── 4. Create directories ───────────────────
mkdir -p logs data

# ── 5. Start Python FastAPI in background ───
echo "[4/6] Starting Python FastAPI on port 8000..."
export PYTHONPATH="$(pwd)/core:$(pwd)"
cd /home/runner/$REPL_SLUG 2>/dev/null || cd ~ 2>/dev/null || true
python3 -m uvicorn core.fastapi_server:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers 1 \
  --log-level warning &
FASTAPI_PID=$!
echo "  FastAPI PID: $FASTAPI_PID"

# Wait for FastAPI to be ready
echo "[5/6] Waiting for FastAPI (10s)..."
sleep 10

# Check if FastAPI is alive
if kill -0 $FASTAPI_PID 2>/dev/null; then
  echo "  FastAPI is running!"
else
  echo "  WARN: FastAPI failed to start, continuing without it..."
fi

# ── 6. Start Node.js server ────────────────
echo "[6/6] Starting Node.js server..."
export INFERENCE_URL="http://127.0.0.1:8000"
export PORT="${REPL_PORT:-3000}"
export NODE_ENV=production
export PYTHONUNBUFFERED=1

exec node --expose-gc --max-old-space-size=512 server.js
