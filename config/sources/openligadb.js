// Source plugin: OpenLigaDB (free, keyless). Per-league backfill for European
// competitions (Bundesliga, 2. Bundesliga, UCL, Eredivisie, Austria, Swiss, ...).

module.exports = {
  name: 'openligadb',
  priority: 3,
  type: 'fixtures',
  enabled: process.env.OPENLIGADB_ENABLED !== 'false',
  // Rate-limits aggressively (429): needs a longer window than the default 20s.
  timeoutMs: 60000,
  rate: { max: 10, perMs: 60000, minTime: 300 },
  async fetch(dateStr) {
    const svc = require('../../services/openligadbService')
    return svc.fetchEvents(dateStr)
  },
}
