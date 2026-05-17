const client = require('prom-client');

const register = client.register;

// ⚠️ Do NOT clear the registry globally — express-prom-bundle shares the same
// prom-client singleton registry and its metrics would be lost too.
// Instead, metrics are registered with { registers: [register] } for isolation.

// Counter: total HTTP requests
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// Histogram: request duration
// 🚨 express-prom-bundle already creates 'http_request_duration_seconds'.
// We expose a lazy getter so server.js can reference it AFTER promBundle init.
// This prevents the "metric already registered" crash on every hot-restart.
const getHttpRequestDuration = () => register.getSingleMetric('http_request_duration_seconds');

// Gauge: active connections
const activeConnections = new client.Gauge({
  name: 'active_connections',
  help: 'Number of active connections',
  registers: [register]
});

// Counter: predictions generated
const predictionsTotal = new client.Counter({
  name: 'predictions_generated_total',
  help: 'Total predictions generated',
  labelNames: ['type'],
  registers: [register]
});

// Counter: cache hits/misses
const cacheHits = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  registers: [register]
});

const cacheMisses = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  registers: [register]
});

// Counter: scrapes success/fail
const scraperSuccess = new client.Counter({
  name: 'scraper_success_total',
  help: 'Successful scraper runs',
  registers: [register]
});

const scraperFailures = new client.Counter({
  name: 'scraper_failures_total',
  help: 'Failed scraper runs',
  registers: [register]
});

// Gauge: circuit breaker state (0=closed, 1=open, 2=half_open)
const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half_open)',
  labelNames: ['name'],
  registers: [register]
});

module.exports = {
  httpRequestsTotal,
  getHttpRequestDuration,
  activeConnections,
  predictionsTotal,
  cacheHits,
  cacheMisses,
  scraperSuccess,
  scraperFailures,
  circuitBreakerState,
  register
};