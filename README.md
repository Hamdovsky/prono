# Titanium Promosport AI - Stitch System

## 🚀 Overview
Advanced AI-powered betting prediction system for Promosport and other betting markets.
Built with Node.js, React, machine learning, and real-time data processing.

## 🛠️ Tech Stack
- **Backend**: Node.js 18+, Express 5, Socket.IO
- **Frontend**: React 19, Vite, Tailwind CSS
- **Database**: SQLite (dev), PostgreSQL (prod)
- **Caching**: Redis + in-memory fallback
- **ML**: Python scikit-learn, XGBoost, Prophet
- **Scraping**: Puppeteer, Axios
- **Real-time**: Socket.IO

## 📦 Installation

### Prerequisites
- Node.js 18+
- Python 3.10+ (with pip)
- Redis (recommended for production)
- SQLite3

### Quick Start
```bash
# Install dependencies
npm ci

# Copy environment template
cp .env.example .env

# Edit .env with your settings

# Development
npm run dev

# Production
npm start
```

## 🏗️ Project Structure
```
stitch/
├── core/              # Core engine modules
│   ├── database.js    # Database layer
│   ├── redisClient.js # Redis with fallback
│   ├── logger.js      # Structured logging
│   ├── monitor.js     # Process supervision
│   └── circuitBreaker.js # Fault tolerance
├── services/          # Business logic services
├── routes/            # Express API routes
├── src/               # React frontend
├── public/            # Static assets
└── tests/             # Jest test suites
```

## 🏃 Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server (Node + Vite) |
| `npm start` | Production build and serve |
| `npm run build` | Build frontend |
| `npm test` | Run Jest tests with coverage |
| `npm run scraper` | Run Promosport scraper |
| `npm run optimize` | DB optimize + build |
| `npm run learn` | Run adaptive learning sync |
| `npm run cleanup` | Clean temp files |

## 🔧 Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Server
PORT=3001
NODE_ENV=development

# Database
DB_PATH=./stitch_main.db

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Scraping
SCRAPER_URL=https://promosportplus.com/

# Telegram
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id

# ML / AI
ML_MODEL_PATH=./models/
```

## 🌐 API Endpoints

### Health & Monitoring
- `GET /health` - System health status
- `GET /metrics` - Prometheus metrics
- `GET /ping` - Liveness check

### Predictions
- `GET /api/promosport` - Promosport AI grids (scrapes live)
- `GET /api/patterns` - Historical patterns
- `GET /api/leagues` - League configurations

### Analytics
- `GET /api/audit/performance` - Performance snapshot
- `GET /api/props/today` - Player props

### System
- `POST /api/config` - Update config (auth required)

Modular routers under `/api/learn`, `/api/combos`, `/api/matches`, etc.

## 🤖 Circuit Breakers

Critical services protected with circuit breakers:

| Service | Timeout | Threshold | Reset |
|---------|---------|-----------|-------|
| Sofascore API | 10s | 5 errors | 30s |
| Redis | 2s | 3 errors | 15s |
| Telegram | 5s | 10 errors | 60s |
| Database | 5s | 5 errors | 10s |

## 📊 Monitoring

### Prometheus Metrics
```
http_requests_total{method, route, status_code}
http_request_duration_seconds{method, route}
circuit_breaker_state{name}
predictions_generated_total{type}
cache_hits_total / cache_misses_total
scraper_success_total / scraper_failures_total
```

### Access Metrics
- `GET /metrics` - Prometheus format
- `GET /health` - JSON health with circuit states

## 🧪 Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Watch mode
npm run test:watch
```

Coverage targets: 70% (branches, functions, lines, statements)

## 🛡️ Security

- Helmet HTTP headers (CSP, HSTS)
- Rate limiting per endpoint
- Request validation (Joi/Zod)
- XSS sanitization
- CORS origin restriction (prod)
- CSRF protection on mutative routes
- Bearer token auth on sensitive routes
- Environment-based config separation

## 🔄 Data Pipeline

```
Sofascore API
    ↓
 Puppeteer Scraper
    ↓
 Circuit Breaker
    ↓
 Schema Validation
    ↓
 AI Engine (XGBoost)
    ↓
 Postgres/SQLite
    ↓
 Redis Cache (60s TTL)
    ↓
 API Response
```

## 📈 Machine Learning

Models in `models/`:
- `stitch_v24_hybrid.json` - Current production

Features: historical odds, head-to-head, form, injuries, league strength

### Retraining
```bash
npm run learn  # Adaptive learning sync
```

ML pipeline uses MLflow for experiment tracking (optional).

## 💾 Backup

Automated backups via `backup_service.js`:
- Database dumps every 6 hours
- Compressed archives
- Retention: 30 days

Manual backup:
```bash
node backup_service.js --now
```

## 🐛 Troubleshooting

### Redis Connection Failed
- System falls back to in-memory Map cache
- Start Redis for full performance:
  ```bash
  redis-server
  ```

### Port 3001 Already in Use
- Server auto-kills existing process on startup (Windows)
- Or manually: `netstat -ano | findstr :3001` then `taskkill /PID <pid>`

### Scraper Returns No Matches
- Check `SCRAPER_URL` in .env
- Verify network access to promosportplus.com
- Circuit breaker may be open (wait or check `/health`)

### ML Model Predictions Poor
- Retrain with `npm run learn`
- Check `models/stitch_v24_hybrid.json` exists
- Verify Python environment has scikit-learn

## 📄 License

ISC

## 🔗 Related

- [PromosportPlus](https://promosportplus.com/)
- [Titanium Engine Docs](./docs/)

## 📞 Support

For issues or questions, check the runbooks in `/docs/RUNBOOKS/`.
