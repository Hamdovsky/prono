// sourceOrchestrator.js — resilient multi-source fixture orchestrator.
//
// Runs a scan across several free sources (Livescore primary, Sofascore
// fallback, OpenLigaDB/Football-Data per-league backfill), dedupes by canonical
// match_key (see matchKey.js), tracks per-source health (see sourceHealth.js),
// logs per-scan stats and raises a Telegram alert if MENA coverage drops to 0.
//
// Providers are injectable for testability; default providers are registered by
// createDefaultProviders() and lazily require their underlying modules so that
// unit tests never touch the network.

const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')
const { SourceHealthTracker } = require('./sourceHealth')
const { SourceRateLimiter } = require('./sourceRateLimiter')
const { getOrComputeMatchKey } = require('./matchKey')
const { detectSilentFailure } = require('./sourceMetrics')

const DATA_DIR = path.join(__dirname, '..', 'data')
const LOG_PATH = path.join(DATA_DIR, 'scraper_sources.log')
const STATE_PATH = path.join(DATA_DIR, 'scraper_state.json')
const HISTORY_PATH = path.join(DATA_DIR, 'scraper_history.json')
const MAX_HISTORY = 50
const SILENT_ALERT_MIN_MS = 60 * 60 * 1000 // throttle: 1 alert/hour

const MENA_KEYWORDS = [
  'algeria', 'tunisia', 'morocco', 'egypt', 'saudi', 'uae', 'qatar',
  'bahrain', 'kuwait', 'oman', 'jordan', 'lebanon', 'iraq', 'syria',
  'yemen', 'libya', 'sudan', 'palestine', 'arab', 'gulf',
]

function isMena(match) {
  const haystack = [
    match.league,
    match.category_name,
    match.country,
    match.tournament_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return MENA_KEYWORDS.some((k) => haystack.includes(k))
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function appendLogLine(line) {
  try {
    ensureDataDir()
    fs.appendFileSync(LOG_PATH, `${line}\n`)
  } catch (e) {
    logger.warn(`[ORCHESTRATOR] Could not write log: ${e.message}`)
  }
}

function writeState(state) {
  try {
    ensureDataDir()
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (e) {
    logger.warn(`[ORCHESTRATOR] Could not write state: ${e.message}`)
  }
}

class SourceOrchestrator {
  constructor(opts = {}) {
    this.health = opts.health || new SourceHealthTracker()
    this.providers = opts.providers || []
    this.store = opts.store || null // { getExistingKeys(): Map<key,row>, persist(match,key): Promise }
    this.telegram = opts.telegram || null // { sendAlert(msg): Promise } (botService)
    this.logPath = opts.logPath || LOG_PATH
    this.statePath = opts.statePath || STATE_PATH
    this.historyPath = opts.historyPath || HISTORY_PATH
    this.maxHistory = opts.maxHistory ?? parseInt(process.env.SOURCE_HISTORY_MAX || MAX_HISTORY, 10)
    this.menaKeywords = opts.menaKeywords || MENA_KEYWORDS
    this.fetchTimeoutMs =
      opts.fetchTimeoutMs ?? parseInt(process.env.SOURCE_FETCH_TIMEOUT_MS || 20000, 10)
    this.rateLimiter = opts.rateLimiter || new SourceRateLimiter()
    this._lastSilentAlertAt = 0
  }

  // Hard cap on a provider's fetch so a hanging source can never block a scan.
  _withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout of ${ms}ms exceeded`)), ms)
      promise.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        }
      )
    })
  }

  // Sorted providers by priority ascending (lower = tried first).
  _orderedProviders() {
    return [...this.providers].sort((a, b) => (a.priority || 0) - (b.priority || 0))
  }

  async runScan({ dates = [] } = {}) {
    const existingKeys = new Map()
    if (this.store && this.store.getExistingKeys) {
      try {
        const map = await this.store.getExistingKeys()
        for (const [k, v] of map) existingKeys.set(k, v)
      } catch (e) {
        logger.warn(`[ORCHESTRATOR] getExistingKeys failed: ${e.message}`)
      }
    }

    const providers = this._orderedProviders()
    const seen = new Set() // match_key already planned this scan
    const summary = {
      startedAt: new Date().toISOString(),
      dates,
      sources: {},
      coverage: { totalUnique: 0, new: 0, mena: 0, menaUnique: new Set() },
      skippedInCooldown: [],
    }

    for (const dateStr of dates) {
      for (const provider of providers) {
        if (!this.health.isUsable(provider.name)) {
          summary.skippedInCooldown.push(`${provider.name}@${dateStr}`)
          continue
        }
        const srcStat = (summary.sources[provider.name] =
          summary.sources[provider.name] || { fetched: 0, new: 0, error: null })
        const wasUsable = this.health.isUsable(provider.name)
        const timeoutMs = provider.timeoutMs || this.fetchTimeoutMs
        try {
          const matches =
            (await this._withTimeout(
              this.rateLimiter.schedule(provider.name, provider.rate, () => provider.fetch(dateStr)),
              timeoutMs
            )) || []
          this.health.recordSuccess(provider.name)
          srcStat.fetched += matches.length
          for (const match of matches) {
            const key = getOrComputeMatchKey(match)
            if (!key) continue
            if (seen.has(key) || existingKeys.has(key)) continue
            seen.add(key)
            summary.coverage.totalUnique++
            srcStat.new++
            if (this.isMena(match)) summary.coverage.menaUnique.add(key)
            if (this.store && this.store.persist) {
              try {
                await this.store.persist(match, key)
              } catch (e) {
                logger.warn(`[ORCHESTRATOR] persist failed (${provider.name}): ${e.message}`)
              }
            }
          }
        } catch (e) {
          const type = /timeout/i.test(e.message)
            ? 'timeout'
            : /network|ECONN|ENOTFOUND/i.test(e.message)
              ? 'network'
              : /403|404|5\d\d/i.test(e.message)
                ? 'http'
                : 'error'
          this.health.recordFailure(provider.name, type)
          srcStat.error = `${type}: ${e.message}`
          appendLogLine(
            JSON.stringify({ ts: Date.now(), date: dateStr, source: provider.name, ok: false, error: type })
          )
          // Cooldown transition alert: this failure just disabled the source.
          if (wasUsable && !this.health.isUsable(provider.name) && this._sendAlert) {
            this._sendAlert(
              `[SCRAPER-ALERT] Source ${provider.name} en cooldown (${this.health.getStatus()[provider.name].failures} échecs, dernière: ${type}).`
            )
          }
        }
      }
    }

    summary.coverage.mena = summary.coverage.menaUnique.size
    summary.coverage.menaUnique = [...summary.coverage.menaUnique]

    // MENA alert: if the scan produced 0 MENA fixtures, notify.
    if (summary.coverage.mena === 0) {
      await this._sendAlert(
        `[SCRAPER-ALERT] Aucun fixture MENA détecté pour ${dates.join(', ')}. Vérifier les sources.`
      ).then((sent) => {
        if (sent) summary.alertSent = true
      })
    }

    // Silent-failure alert: primary source returned 0 rows for the last window
    // of scans while producing data before. Throttled to 1 alert/hour.
    const history = this._readHistory()
    const merged = [...history, summary]
    const silent = detectSilentFailure(merged, 'livescore')
    if (silent && Date.now() - this._lastSilentAlertAt > SILENT_ALERT_MIN_MS) {
      const sent = await this._sendAlert(
        `[SCRAPER-ALERT] Source livescore silencieuse: 0 fixture sur les ${this.maxHistory >= 3 ? 3 : this.maxHistory} derniers scans. Vérifier l'API.`
      )
      if (sent) this._lastSilentAlertAt = Date.now()
    }
    summary.silentFailure = silent

    summary.finishedAt = new Date().toISOString()
    this.writeLog(summary)
    this.writeState(summary)
    this.writeHistory(summary)
    return summary
  }

  // Results pass: fetches finished events (type:'results' providers expose
  // fetchResults) and updates stored fixtures' scores by match_key. Never
  // inserts new rows and never triggers the MENA/silent-failure alerts (those
  // are fixtures-only concerns).
  async runResultsScan({ dates = [] } = {}) {
    const providers = this._orderedProviders()
    const results = { fetched: 0, updated: 0, bySource: {}, dates }
    for (const dateStr of dates) {
      for (const provider of providers) {
        if (typeof provider.fetchResults !== 'function') continue
        if (!this.health.isUsable(provider.name)) continue
        const stat = (results.bySource[provider.name] =
          results.bySource[provider.name] || { fetched: 0, updated: 0, error: null })
        const timeoutMs = provider.timeoutMs || this.fetchTimeoutMs
        try {
          const rows =
            (await this._withTimeout(
              this.rateLimiter.schedule(provider.name, provider.rate, () =>
                provider.fetchResults(dateStr)
              ),
              timeoutMs
            )) || []
          this.health.recordSuccess(provider.name)
          results.fetched += rows.length
          stat.fetched += rows.length
          for (const row of rows) {
            const key = getOrComputeMatchKey(row)
            if (!key) continue
            if (!this.store || typeof this.store.updateResult !== 'function') continue
            try {
              const n = await this.store.updateResult(key, {
                scoreHome: row.scoreHome,
                scoreAway: row.scoreAway,
                scoreHalfHome: row.scoreHalfHome,
                scoreHalfAway: row.scoreHalfAway,
                status: row.status || 'finished',
              })
              if (n > 0) {
                results.updated += n
                stat.updated += n
              }
            } catch (e) {
              logger.warn(`[ORCHESTRATOR] updateResult failed (${provider.name}): ${e.message}`)
            }
          }
        } catch (e) {
          const type = /timeout/i.test(e.message) ? 'timeout' : 'error'
          this.health.recordFailure(provider.name, type)
          stat.error = `${type}: ${e.message}`
          appendLogLine(
            JSON.stringify({ ts: Date.now(), date: dateStr, source: provider.name, ok: false, results: true, error: type })
          )
        }
      }
    }
    results.finishedAt = new Date().toISOString()
    return results
  }

  // Best-effort Telegram alert; returns true if actually sent. No-op when no
  // telegram transport is configured (see runResilientScan env guard).
  async _sendAlert(msg) {
    if (!this.telegram || typeof this.telegram.sendAlert !== 'function') return false
    try {
      await this.telegram.sendAlert(msg)
      return true
    } catch (e) {
      logger.warn(`[ORCHESTRATOR] Telegram alert failed: ${e.message}`)
      return false
    }
  }

  isMena(match) {
    const haystack = [
      match.league,
      match.category_name,
      match.country,
      match.tournament_name,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return this.menaKeywords.some((k) => haystack.includes(k))
  }

  writeLog(summary) {
    try {
      fs.appendFileSync(this.logPath, `${JSON.stringify(summary)}\n`)
    } catch (e) {
      logger.warn(`[ORCHESTRATOR] Could not write log: ${e.message}`)
    }
  }

  writeState(summary) {
    const state = {
      lastScanAt: summary.finishedAt,
      dates: summary.dates,
      sources: this.health.getStatus(),
      coverage: summary.coverage,
      silentFailure: !!summary.silentFailure,
    }
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2))
    } catch (e) {
      logger.warn(`[ORCHESTRATOR] Could not write state: ${e.message}`)
    }
  }

  _readHistory() {
    try {
      if (!fs.existsSync(this.historyPath)) return []
      const raw = fs.readFileSync(this.historyPath, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch (_) {
      return []
    }
  }

  writeHistory(summary) {
    try {
      const history = this._readHistory()
      history.push(summary)
      const trimmed = history.slice(-this.maxHistory)
      fs.writeFileSync(this.historyPath, JSON.stringify(trimmed))
    } catch (e) {
      logger.warn(`[ORCHESTRATOR] Could not write history: ${e.message}`)
    }
  }
}

// Default store backed by the active DB (SQLite in dev/test, pgDb when
// DATABASE_URL is set). Persistence errors are tolerated: dedup correctness is
// guaranteed by the in-memory existing-keys map, not by persistence.
function createDefaultStore() {
  return {
    async updateResult(matchKey, patch) {
      if (!matchKey) return 0
      const db = require('../core/database')
      if (typeof db.updateMatchResult === 'function') {
        return db.updateMatchResult(matchKey, patch)
      }
      // Fallback (DB without updateMatchResult): direct UPDATE by match_key.
      try {
        const r = db
          .prepare(
            'UPDATE matches SET "scoreHome"=?, "scoreAway"=?, status=?, last_updated=? WHERE "match_key"=?'
          )
          .run(
            patch.scoreHome ?? 0,
            patch.scoreAway ?? 0,
            patch.status || 'finished',
            Date.now(),
            matchKey
          )
        return r.changes || 0
      } catch (e) {
        return 0
      }
    },
    async getExistingKeys() {
      const db = require('../core/database')
      const rows = db.prepare(
        'SELECT id, homeTeam, awayTeam, startTimestamp, match_key FROM matches'
      ).all()
      const map = new Map()
      for (const r of rows) {
        const k = getOrComputeMatchKey(r)
        if (k) map.set(k, r)
      }
      return map
    },
    async persist(match, key) {
      const db = require('../core/database')
      // Full upsert path: inserts/updates every column (so fixtures flow into
      // the analysis pipeline) and persists match_key via COALESCE.
      if (typeof db.insertMatch === 'function') {
        await db.insertMatch({ ...match, match_key: key })
        return true
      }
      // Fallback (DB without insertMatch): minimal row + match_key.
      const existing = db.prepare('SELECT id FROM matches WHERE id = ?').get(match.id)
      if (existing) {
        db.prepare(
          'UPDATE matches SET match_key = COALESCE(match_key, ?) WHERE id = ?'
        ).run(key, match.id)
      } else {
        db.prepare(
          'INSERT OR IGNORE INTO matches (id, homeTeam, awayTeam, league, startTimestamp, source, status, last_updated, match_key) VALUES (?,?,?,?,?,?,?,?,?)'
        ).run(
          match.id,
          match.homeTeam,
          match.awayTeam,
          match.league,
          match.startTimestamp,
          match.source,
          'scheduled',
          Date.now(),
          key
        )
      }
      return true
    },
    async setMatchKey(id, key) {
      const db = require('../core/database')
      db.prepare(
        'UPDATE matches SET match_key = ? WHERE id = ? AND (match_key IS NULL OR match_key = ?)'
      ).run(key, id, '')
    },
  }
}

// Idempotent backfill: computes match_key for rows where it is still NULL.
function backfillMatchKeys(store) {
  if (!store || !store.getExistingKeys || !store.setMatchKey) return Promise.resolve(0)
  return store.getExistingKeys().then((map) => {
    let updated = 0
    for (const [key, row] of map) {
      if (!row.match_key && row.id) {
        store.setMatchKey(row.id, key)
        updated++
      }
    }
    return updated
  })
}

// Default real providers come from the declarative plugin registry
// (config/sources/*.js). Lazy require keeps unit tests network-free.
function createDefaultProviders() {
  const { buildProviders } = require('./sourceRegistry')
  return buildProviders()
}

module.exports = {
  SourceOrchestrator,
  createDefaultProviders,
  createDefaultStore,
  backfillMatchKeys,
  isMena,
  MENA_KEYWORDS,
}
