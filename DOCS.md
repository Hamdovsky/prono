# Documentation Index - Titanium Promosport AI

## 📚 Documentation Overview

This file serves as the main index for all project documentation.

## 🎯 Quick Links

| Document | Description |
|----------|-------------|
| [README.md](./README.md) | Main project overview, installation, usage |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture, data flows, components |
| [API.md](./API.md) | Complete OpenAPI/Swagger documentation |
| [DEPLOY.md](./DEPLOY.md) | Deployment guides (dev, staging, prod) |
| [RUNBOOKS/](./RUNBOOKS/) | Incident response and operational procedures |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development guidelines, Git workflow |
| [CHANGELOG.md](./CHANGELOG.md) | Version history and release notes |

## 🏗️ Architecture

### High Level
```
[Frontend React] ←WebSocket→ [Node.js Express API] ←→ [Redis Cache]
                                    ↓
                            [Python ML Engine]
                                    ↓
                            [SQLite/PostgreSQL]
                                    ↓
                          [Promosport Scraper]
```

### Core Components

1. **Express API** (`server.js`)
   - REST endpoints
   - WebSocket gateway
   - Middleware stack
   - Circuit breakers

2. **Redis Client** (`core/redisClient.js`)
   - Primary caching layer
   - In-memory fallback
   - Metrics collection

3. **Security Engine** (`core/securityEngine.js`)
   - Rate limiting
   - Auth middleware
   - Request validation

4. **Promosport Engine** (`core/promosport_engine.js`)
   - AI prediction generation
   - Grid assembly
   - Cache management

5. **Scraper** (`core/promosport_scraper.js`)
   - Puppeteer-based
   - Axios fallback
   - Circuit breaker protected

## 🔐 Security Model

### Authentication
- Bearer token (configurable via env)
- Optional JWT for enhanced auth (future)

### Authorization
- Role-based access control (admin, user, viewer)
- Middleware: `securityEngine.authenticate`

### Input Validation
- Express-validator / Joi on all POST/PUT
- Type checking on API boundaries

### Headers
- Helmet CSP enabled
- HSTS strictly enforced
- X-Frame-Options: DENY

## 🧪 Testing Strategy

### Unit Tests
- Location: `/__tests__/`
- Framework: Jest
- Coverage: 70% target

### Integration Tests
- API endpoints with Supertest
- Database transactions
- Redis connectivity

### E2E Tests
- Cypress (future)
- Critical user journeys

## 📊 Monitoring & Observability

### Metrics
- Prometheus format on `/metrics`
- Grafana dashboards (see `monitoring/`)

### Logging
- Structured JSON logs
- Winston/console with levels
- Request correlation IDs

### Traces
- OpenTelemetry (future)
- Jaeger integration (future)

### Alerts
- Prometheus Alertmanager
- Slack / Telegram webhooks
- PagerDuty (critical)

## 🚀 Deployment

### Development
```bash
npm run dev
```
- Hot reload via Vite
- Auto-restart on changes
- Debug port 9229

### Staging
```bash
NODE_ENV=staging npm start
```
- Separate DB and Redis
- Feature flags enabled
- Reduced resources

### Production
```bash
NODE_ENV=production npm start
```
- PM2 cluster mode
- Multiple workers
- Health checks

### Docker
```bash
docker-compose -f docker-compose.prod.yml up -d
```

## 🔄 CI/CD Pipeline

### GitHub Actions
- Lint on PR
- Test on push
- Build on merge
- Deploy to staging (manual)
- Deploy to prod (manual + approval)

## 🗄️ Database Schema

See `core/database.js` for:
- Table definitions
- Migration scripts
- Query methods

Key tables:
- `matches` - Match records
- `predictions` - AI predictions
- `patterns` - Historical patterns
- `leagues` - League configs
- `users` - User accounts (if auth enabled)

## 🛠️ Development Setup

### Prerequisites
- Node 18+
- Python 3.10+
- Redis (optional but recommended)
- Git

### Steps
1. Clone repository
2. `npm ci`
3. Copy `.env.example` → `.env`
4. `npm run dev`
5. Visit `http://localhost:5173`

## 🐛 Common Issues

| Issue | Solution |
|-------|----------|
| Port 3001 in use | `netstat -ano \| findstr :3001` → `taskkill /PID <pid>` |
| Redis connection refused | Start Redis or set DISABLE_REDIS=true |
| Scraper timeout | Check network, increase timeout in config |
| ML model missing | Run `npm run learn` to generate |
| Memory usage high | Reduce worker count, increase GC frequency |

## 📈 Performance Tuning

### Node.js
```bash
NODE_OPTIONS="--max-old-space-size=4096" npm start
```

### V8 Flags
```bash
node --optimize-for-size --max-old-space-size=8192 server.js
```

### Database
- Add indexes on frequently queried columns
- Use connection pooling
- Enable WAL mode (SQLite)

### Redis
- Configure maxmemory policy
- Use pipelining for bulk operations
- Monitor slowlog

## 🔍 Debugging

### Enable Debug Logging
```bash
DEBUG=* npm run dev
```

### Inspect Production
```bash
# Attach to running process
node inspect server.js

# Or use Chrome DevTools
chrome://inspect
```

### Check Circuit Breakers
```bash
curl http://localhost:3001/health | jq .circuitBreakers
```

## 📦 Package Structure

### Dependencies
- Express 5 - Web framework
- Socket.IO - Real-time
- ioredis - Redis client
- Axios - HTTP client
- BullMQ - Job queues
- Puppeteer - Headless browser

### Dev Dependencies
- Jest - Testing
- ESLint - Linting
- Vite - Build tool
- TypeScript - Type checking (optional)

## 🤝 Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## 📄 License

ISC - See LICENSE file