const logger = require('../core/logger')

class ApiFallbackManager {
  constructor() {
    this.sources = []
  }

  registerSource(source) {
    this.sources.push(source)
    logger.info(`✅ [FALLBACK] Registered source: ${source.name} (priority: ${source.priority})`)
    this.sources.sort((a, b) => a.priority - b.priority)
  }

  getAvailableSources() {
    return this.sources.filter(s => {
      try {
        return s.isAvailable()
      } catch (e) {
        return false
      }
    })
  }

  getAllStatus() {
    const status = {}
    for (const s of this.sources) {
      status[s.name] = {
        available: s.isAvailable ? s.isAvailable() : false,
        priority: s.priority,
        status: s.getQuotaStatus ? s.getQuotaStatus() : {}
      }
    }
    return status
  }

  async trySources(fnName, ...args) {
    const available = this.getAvailableSources()
    if (available.length === 0) {
      logger.warn('⚠️ [FALLBACK] No API sources available')
      return null
    }

    const errors = []
    for (const source of available) {
      try {
        const fn = source[fnName]
        if (typeof fn !== 'function') {
          errors.push(`${source.name}: method ${fnName} not found`)
          continue
        }

        const result = await fn.apply(source, args)
        if (result && (Array.isArray(result) ? result.length > 0 : true)) {
          logger.info(`✅ [FALLBACK] ${source.name}.${fnName}() succeeded`)
          return { source: source.name, data: result }
        }
        errors.push(`${source.name}: returned empty`)
      } catch (e) {
        errors.push(`${source.name}: ${e.message}`)
        logger.warn(`⚠️ [FALLBACK] ${source.name}.${fnName}() failed: ${e.message}`)
      }
    }

    logger.warn(`❌ [FALLBACK] All sources failed for ${fnName}: ${errors.join(' | ')}`)
    return null
  }

  async fetchMatches(dateStr) {
    return this.trySources('fetchEvents', dateStr)
  }

  async enrichOdds(matchId) {
    return this.trySources('fetchOdds', matchId)
  }
}

module.exports = new ApiFallbackManager()
