// sourceMetrics.js — per-source metrics + silent-failure detection, computed
// from the rolling scan history (data/scraper_history.json). Pure functions,
// fully testable without I/O.

function computeSourceMetrics(history) {
  const metrics = {}
  for (const scan of history || []) {
    const srcs = scan.sources || {}
    for (const [name, s] of Object.entries(srcs)) {
      const m = (metrics[name] =
        metrics[name] || {
          scans: 0,
          successes: 0,
          failures: 0,
          totalFetched: 0,
          totalNew: 0,
          lastError: null,
          lastErrorAt: null,
          lastScanAt: null,
        })
      m.scans++
      if (s.error) {
        m.failures++
        m.lastError = s.error
        m.lastErrorAt = scan.finishedAt || scan.startedAt
      } else {
        m.successes++
      }
      m.totalFetched += s.fetched || 0
      m.totalNew += s.new || 0
      m.lastScanAt = scan.finishedAt || scan.startedAt
    }
  }
  for (const m of Object.values(metrics)) {
    m.avgFetched = m.scans ? Math.round(m.totalFetched / m.scans) : 0
    m.avgNew = m.scans ? Math.round(m.totalNew / m.scans) : 0
    m.successRate = m.scans ? m.successes / m.scans : 0
    delete m.totalFetched
    delete m.totalNew
  }
  return metrics
}

// Silent failure: a source returns 0 rows (no error thrown) for `window`
// consecutive scans, while earlier scans from that source produced data.
// Catches API breakages that fail quietly (403-style empties, shape changes).
function detectSilentFailure(history, source = 'livescore', window = 3) {
  if (!Array.isArray(history) || history.length < window + 1) return false
  const recent = history.slice(-window)
  const prior = history.slice(0, -window)
  const recentAllEmpty = recent.every((scan) => {
    const s = (scan.sources || {})[source]
    return s && !s.error && (s.fetched || 0) === 0
  })
  if (!recentAllEmpty) return false
  const priorFetched = prior.reduce(
    (acc, scan) => acc + ((scan.sources || {})[source]?.fetched || 0),
    0
  )
  return priorFetched > 0
}

module.exports = { computeSourceMetrics, detectSilentFailure }
