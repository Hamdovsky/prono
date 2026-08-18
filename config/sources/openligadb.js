// Source plugin: OpenLigaDB (free, keyless). Per-league backfill for European
// competitions (Bundesliga, 2. Bundesliga, UCL, Eredivisie, Austria, Swiss, ...).

module.exports = {
  name: 'openligadb',
  priority: 3,
  type: 'fixtures',
  enabled: process.env.OPENLIGADB_ENABLED !== 'false',
  // Requests are parallelized inside the service (concurrency 3), so the whole
  // fetch stays well under this cap.
  timeoutMs: 45000,
  rate: { max: 10, perMs: 60000, minTime: 300 },
  async fetch(dateStr) {
    const svc = require('../../services/openligadbService')
    return svc.fetchEvents(dateStr)
  },
  async fetchResults(dateStr) {
    const svc = require('../../services/openligadbService')
    return svc.fetchResults(dateStr)
  },
}
