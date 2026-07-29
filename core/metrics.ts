import client from 'prom-client'

const register = client.register

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
})

const getHttpRequestDuration = () => register.getSingleMetric('http_request_duration_seconds')

const activeConnections = new client.Gauge({
  name: 'active_connections',
  help: 'Number of active connections',
  registers: [register],
})

const predictionsTotal = new client.Counter({
  name: 'predictions_generated_total',
  help: 'Total predictions generated',
  labelNames: ['type'],
  registers: [register],
})

const cacheHits = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  registers: [register],
})

const cacheMisses = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  registers: [register],
})

const scraperSuccess = new client.Counter({
  name: 'scraper_success_total',
  help: 'Successful scraper runs',
  registers: [register],
})

const scraperFailures = new client.Counter({
  name: 'scraper_failures_total',
  help: 'Failed scraper runs',
  registers: [register],
})

const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half_open)',
  labelNames: ['name'],
  registers: [register],
})

export {
  httpRequestsTotal,
  getHttpRequestDuration,
  activeConnections,
  predictionsTotal,
  cacheHits,
  cacheMisses,
  scraperSuccess,
  scraperFailures,
  circuitBreakerState,
  register,
}
