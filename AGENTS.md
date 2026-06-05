# AGENTS.md — Titanium AI Project Conventions

## Stack
- **Backend**: Node.js/Express 5, CommonJS (`require`/`module.exports`)
- **Frontend**: React 19, Vite 7, Tailwind CSS, plain JS (no TypeScript)
- **AI/ML**: Python 3.10, FastAPI, XGBoost, scikit-learn
- **DB**: SQLite (`better-sqlite3`) dev, PostgreSQL/TimescaleDB prod
- **Cache**: Redis (`ioredis`) with in-memory fallback
- **Real-time**: Socket.IO
- **Testing**: Jest (Node), pytest (Python)

## Code Style
- No TypeScript — all JS/JSX
- No semicolons in JS
- Backend: `camelCase`, `snake_case` only in Python
- Arabic/French strings allowed in comments and error messages
- `try/catch` preferred over `.catch()` chains
- `except Exception:` not bare `except:` (fixed globally)

## Key Files
- `server.js` — Express entry point
- `core/prediction_engine.py` — Main prediction logic (Python)
- `core/ml_features.py` — Feature extraction
- `core/fastapi_server.py` — FastAPI inference API
- `core/database.js` — DB abstraction layer
- `render.yaml` — Render.com deployment config

## Deployment
- **Render**: Docker-based, free plan (512MB RAM)
- Node heap: `--max-old-space-size=256` (never 2048)
- No Chromium/Puppeteer in Docker image
- GitHub → auto-deploy on push to `main`

## Prediction Pipeline
1. `server.js` receives match → calls FastAPI `http://127.0.0.1:8000/predict`
2. `prediction_engine.py:process_prediction()` runs ML + Monte Carlo
3. Returns verdict, confidence, expected score, surgical markets
4. DeepSeek/Groq service enriches Top 3 selections with tactical briefing

## Common Pitfalls
- `_sanitize()` only reads from `match_obj`, not `features` → always use `features.get()` or direct locals
- `analysis` is a `dict`, not a `list` — use `analysis["key"] = val`
- Always initialize vars before try blocks that assign them
- risk_score must be computed before being checked
