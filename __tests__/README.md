# Promosport AI - Jest Test Suite

## Overview
This suite provides comprehensive unit testing for critical Promosport AI system components, targeting **70% code coverage**.

## Structure

```
__tests__/
├── setup.js                     # Global Jest configuration & mocks
├── logger.test.js               # core/logger.js - log rotation, burst protection
├── securityEngine.test.js       # core/securityEngine.js - rate limiting & auth
├── shieldEngine.test.js         # core/shieldEngine.js - proxy rotation & health
├── redisClient.test.js          # core/redisClient.js - Redis cache with metrics
├── redisCache.test.js           # services/redisCache.js - high-level cache service
├── database.test.js             # core/database.js - SQLite wrapper & migrations
├── matches.test.js              # routes/matches.js - upcoming, edge, refresh
├── system.test.js               # routes/system.js - health, status, predict
├── scraper.test.js              # routes/scraper.js - booking codes endpoint
├── botService.test.js           # services/botService.js - Telegram bot
├── scraperApiService.test.js    # services/scraperApiService.js - external API fetch
├── additionalRoutes.test.js     # integration tests for other routes
├── enrichedPredictions.test.js  # core/enriched_predictions.js - AI enrichment
├── configEngine.test.js         # core/configEngine.js - config management
├── valueBetEngine.test.js       # src/services/ValueBetEngine.js - value detection
├── speedCache.test.js           # core/speedCache.js - in-memory caching
├── networkConfig.test.js        # core/networkConfig.js - HTTP pooling config
```

## Key Tested Components

| Component | File | Coverage Focus |
|-----------|------|----------------|
| Logger | `logger.test.js` | Log rotation, burst protection, error handling |
| Security Engine | `securityEngine.test.js` | Rate limiting, token authentication |
| Shield Engine | `shieldEngine.test.js` | Latency monitoring, proxy rotation |
| Redis Client | `redisClient.test.js` | Cache get/set, metrics, fallback |
| Redis Cache | `redisCache.test.js` | Live matches, team history, TTL |
| Database | `database.test.js` | CRUD, migrations, transactions |
| API Routes (Matches) | `matches.test.js` | Filtering, enrichment, edge detection |
| API Routes (System) | `system.test.js` | Health, status, protected endpoints |
| API Routes (Scraper) | `scraper.test.js` | Booking codes management |
| Bot Service | `botService.test.js` | Telegram commands, alerts |
| Scraper API | `scraperApiService.test.js` | External data normalization |
| Enriched Predictions | `enrichedPredictions.test.js` | AI enrichment pipeline |
| Value Bet Engine | `valueBetEngine.test.js` | EV calculations, value detection |
| Speed Cache | `speedCache.test.js` | TTL caching, invalidation |
| Config Engine | `configEngine.test.js` | Configuration persistence |

## External Dependencies Mocked

- **Sofascore/External APIs**: Mocked via `axios` in `scraperApiService.test.js`
- **Telegram Bot**: HTTP requests mocked via `https` module mock in `botService.test.js`
- **Redis**: `ioredis` mocked globally in `setup.js`; `redis-memory-server` also mocked
- **SQLite**: Real database wrapped - tests guard against write errors with try/catch; uses statement caching verification

## Running Tests

```bash
# Run all tests with coverage report
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npx jest path/to/test.file.js

# Generate detailed coverage
npx jest --coverage
```

## Configuration

Jest configuration is in `jest.config.js`:
- Test environment: `node`
- Test discovery: `**/__tests__/**/*.test.js`
- Coverage targets: 70% branches/functions/lines/statements
- Global setup: `__tests__/setup.js`
- Max workers: 2 (to avoid SQLite concurrency issues)

## Notes

- Tests use **soft mocks** for IO operations; filesystem is stubbed
- Database tests use defensive try/catch to avoid corrupting real data
- Singleton services (logger, shieldEngine) are reset between tests via re-require patterns
- Mock Redis provides full API surface but performs no real caching

## Extending Coverage

To add more tests for uncovered branches:
1. Create new `*.test.js` in `__tests__/`
2. Import target module using `require('../relative/path')`
3. Use Jest's mocking utilities to simulate external services
4. Ensure tests run deterministically without network/DB side effects
