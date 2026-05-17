# 🏗️ System Architecture - Titanium Promosport AI

## Overview

Titanium is a multi-tier AI-powered betting prediction system designed for Promosport and similar prediction markets. It combines real-time web scraping, machine learning inference, and robust caching to deliver fast, accurate predictions.

## High-Level Architecture

```

   Client    
  (Browser)  

        HTTP/WebSocket
       

   Express.js Server      
   - REST API             
   - Rate Limiting        
   - Circuit Breakers     
   - Security Middleware  

                        
      
                               
       
   Socket.IO   Redis   Python  
   (Realtime)  Cache   Workers  
       
                               
                        
                          
                    
                      PostgreSQL 
                      SQLite     
                    
```

## Component Details

### 1. Presentation Layer (Frontend)

**Technology**: React 19 + Vite + Tailwind CSS

**Responsibilities**:
- Render prediction grids
- Display real-time updates via WebSocket
- User interaction (selections, filters)
- Visualization of AI confidence scores

**Key Files**:
- `src/App.jsx` - Main application component
- `src/components/Dashboard.jsx` - Primary dashboard
- `src/components/*.jsx` - UI components

### 2. API Gateway (Node.js/Express)

**Technology**: Express 5, Socket.IO, Helmet

**Responsibilities**:
- HTTP request routing
- Authentication & authorization
- Request validation
- Rate limiting
- Serve static assets (production)
- WebSocket gateway

**Middleware Stack**:
1. Helmet (security headers)
2. CORS (origin control)
3. Compression (gzip)
4. JSON body parser
5. Rate limiter (express-rate-limit)
6. Security engine (custom)
7. Performance audit
8. Router handlers

**Key Files**:
- `server.js` - Server bootstrap
- `routes/*.js` - Route definitions
- `core/securityEngine.js` - Auth & rate limits

### 3. Business Logic Layer (Services)

**Technology**: Node.js, Python (via subprocess)

**Services**:

#### 3.1 Promosport Scraper
- Fetches live match data from PromosportPlus
- Puppeteer for JavaScript-rendered pages
- Fallback to direct API calls
- Circuit breaker protection

**File**: `core/promosport_scraper.js`

#### 3.2 Prediction Engine
- Executes Python ML models
- Combines multiple algorithms
- Generates confidence scores
- Assembles prediction grids

**File**: `core/promosport_engine.js`

#### 3.3 Cache Service
- Redis primary storage
- In-memory Map fallback
- Automatic TTL management
- Metrics collection (hit rate, latency)

**File**: `core/redisClient.js`

#### 3.4 Database Layer
- SQLite (development)
- PostgreSQL (production)
- Schema migrations
- Query builders

**File**: `core/database.js`, `core/database_pg.js`

### 4. Data Layer

**Storage Technologies**:

#### 4.1 Primary Database
- **SQLite**: File-based, zero-config, ACID compliant
  - Used in development & small deployments
  - Single writer, multiple readers
  - WAL mode enabled for concurrency

- **PostgreSQL**: Client-server RDBMS
  - Used in production
  - Connection pooling via `pgbouncer`
  - Read replicas for scaling

#### 4.2 Cache Layer
- **Redis**: In-memory data store
  - TTL-based caching (60s default)
  - Pub/Sub for real-time updates
  - Persistence (AOF + RDB snapshots)

#### 4.3 Object Storage (Optional)
- **AWS S3 / MinIO**: For model artifacts, backups

### 5. Machine Learning Pipeline

**Technology**: Python 3.10+, scikit-learn, XGBoost, Prophet

**Workflow**:
```
Raw Match Data (Sofascore)
    ↓
Feature Engineering
    - Historical odds
    - Head-to-head records
    - Team form (last 5 matches)
    - Home/away splits
    - Injuries/suspensions
    - Weather conditions
    ↓
Model Inference (XGBoost)
    ↓
Ensemble (Weighted average)
    - XGBoost (40%)
    - Random Forest (30%)
    - Logistic Regression (30%)
    ↓
Calibration (Platt scaling)
    ↓
Confidence Score (0-100%)
```

**Models**:
- `stitch_v24_hybrid.json` - Current production model
- Retrained weekly via `npm run learn`

**Files**:
- `services/mlPredictionService.js` - Node/ML bridge
- `python/predict.py` - ML inference script

### 6. Infrastructure Layer

#### 6.1 Process Management
- **PM2**: Production process manager
  - Cluster mode (load balancing)
  - Zero-downtime reloads
  - Log management
  - Monitoring dashboard

#### 6.2 Monitoring
- **Prometheus**: Metrics collection
  - HTTP request latency
  - Cache hit rate
  - Circuit breaker states
  - System resources

- **Grafana**: Visualization
  - Real-time dashboards
  - Alert rules

- **Jaeger**: Distributed tracing (planned)

#### 6.3 Logging
- Structured JSON logs
- Winston transport (file + console)
- Log rotation (daily)
- Retention: 30 days

## Data Flows

### Flow 1: Prediction Request
```
1. Client → GET /api/promosport
2. Express → Rate limit check
3. Express → Cache check (Redis)
   ├─ Hit: Return cached data
   └─ Miss: Continue
4. Express → Scraper service
   → Puppeteer → Sofascore.com
   ← Raw match data
5. Express → Validation
6. Express → Prediction engine
   → Python process
   → Feature extraction
   → Model inference
   ← Predictions (JSON)
7. Express → Cache store (Redis, 60s TTL)
8. Express ← Response (JSON)
9. Client ← Render grid
```

### Flow 2: Real-Time Updates
```
1. Scraper cron (every 5 min)
2. Fetch latest matches
3. Compare with previous
4. If changes detected:
   → Emit socket.io event
   → All connected clients
   → Update UI in real-time
```

### Flow 3: Cache Invalidation
```
1. On new prediction:
   - Invalidate key: `promosport:grids`
   - Set new value with TTL
2. On match status change:
   - Invalidate: `match:{id}`
   - Update related keys
3. TTL expiration:
   - Automatic Redis eviction
   - Next request triggers refresh
```

## Scaling Strategy

### Vertical Scaling
- Increase Node.js heap size (`--max-old-space-size`)
- Add more CPU cores
- Increase Redis memory limit

### Horizontal Scaling
#### Node.js Layer
- PM2 cluster mode (all cores)
- Multiple instances behind load balancer
- Sticky sessions for WebSocket

#### Cache Layer
- Redis Cluster (sharding)
- Read replicas for read-heavy workloads

#### Database Layer
- PostgreSQL primary-replica
- Connection pooling
- Read/write splitting

#### Python Workers
- Multiple processes (multiprocessing)
- Queue-based (Celery/RQ)
- Separate worker servers

## Deployment Topology

### Development
```
Single machine (localhost)
├── Node.js (dev mode)
├── Redis (optional)
├── PostgreSQL (optional)
└── React dev server
```

### Staging
```
2-3 servers
├── Load balancer (nginx)
├── 2× Node.js instances
├── 1× Redis (with persistence)
├── 1× PostgreSQL
└── 1× Python worker
```

### Production (High Availability)
```
Multi-zone deployment
├── 3× Load balancers (active-active)
├── 6× Node.js (2 per zone)
├── Redis Cluster (3 master + 3 replica)
├── PostgreSQL cluster (1 primary + 2 replicas)
├── 3× Python workers (1 per zone)
└── Object storage (S3-compatible)
```

## Security Boundaries

```
Internet
    ↓
[CDN/WAF] ← DDoS protection, rate limiting
    ↓
[Load Balancer] ← TLS termination, health checks
    ↓
[Node.js Instances] ← Auth, business logic
    ↓
[Internal Network]
    ├── Redis (private subnet)
    ├── PostgreSQL (private subnet)
    └── Python Workers (private subnet)
```

## Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Redis down | Slower responses | In-memory fallback, degrade gracefully |
| DB connection lost | Cannot persist data | Retry with backoff, circuit breaker |
| Sofascore API down | No fresh data | Use cached data, increase TTL |
| Python worker crash | No predictions | Restart worker, fallback to simpler model |
| Memory leak | OOM kill | Health checks, auto-restart, memory limits |
| Network partition | Split brain | Quorum reads/writes, retry logic |

## Performance Characteristics

### Latency Targets
- API response (cache hit): < 50ms
- API response (cache miss): < 2s
- WebSocket broadcast: < 100ms
- DB query: < 100ms (95th percentile)

### Throughput Targets
- API: 1000 req/s per instance
- WebSocket: 10,000 concurrent connections
- Redis: 50,000 ops/s
- PostgreSQL: 1000 transactions/s

## Future Enhancements

1. **Service Mesh** (Istio/Linkerd)
   - Advanced traffic management
   - Mutual TLS
   - Distributed tracing

2. **Event-Driven Architecture**
   - Apache Kafka for event bus
   - Decouple services
   - Better scalability

3. **Kubernetes**
   - Container orchestration
   - Auto-scaling
   - Self-healing

4. **GraphQL**
   - Flexible queries
   - Reduce over-fetching
   - Better frontend autonomy

5. **ML Model Registry**
   - MLflow or Kubeflow
   - A/B testing
   - Automated retraining

## Decision Records

### ADR-001: SQLite vs PostgreSQL (Dev)
**Context**: Need lightweight DB for development
**Decision**: Use SQLite for dev, PostgreSQL for prod
**Consequences**: Slight behavioral differences, need adapter pattern

### ADR-002: Redis as Primary Cache
**Context**: Need sub-millisecond cache access
**Decision**: Redis with in-memory fallback
**Consequences**: Added complexity but high performance

### ADR-003: Express over Fastify
**Context**: Team familiarity, ecosystem
**Decision**: Express 5 for stability
**Consequences**: Slightly slower but easier maintenance

## References

- [C4 Model](https://c4model.com/) - Architecture diagrams
- [12-Factor App](https://12factor.net/) - Deployment methodology
- [SOLID Principles](https://en.wikipedia.org/wiki/SOLID) - OO design
- [CAP Theorem](https://en.wikipedia.org/wiki/CAP_theorem) - Distributed systems