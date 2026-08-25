const logger = require('./logger')

function registerAll(apiFallbackManager, services) {
  const localDataUrl = process.env.LOCAL_DATA_URL || ''
  if (localDataUrl) {
    logger.info('[FALLBACK] LOCAL_DATA_URL detected — external API sources SKIPPED')
    return
  }

  try {
    apiFallbackManager.registerSource({
      name: 'TheRundown',
      priority: 2,
      isAvailable: () => services.therundown.isAvailable(),
      getQuotaStatus: () => services.therundown.getQuotaStatus(),
      fetchEvents: (dateStr) => services.therundown.fetchSoccerEvents(dateStr),
      fetchOdds: (eventId) => services.therundown.fetchOddsForMatch(eventId),
    })
    apiFallbackManager.registerSource({
      name: 'OddsPapi',
      priority: 3,
      isAvailable: () => services.oddspapi.isAvailable(),
      getQuotaStatus: () => services.oddspapi.getQuotaStatus(),
      fetchEvents: (dateStr) => services.oddspapi.fetchEvents(dateStr),
      fetchOdds: (fixtureId) => services.oddspapi.fetchOddsForFixture(fixtureId),
    })
    apiFallbackManager.registerSource({
      name: 'Sportmonks',
      priority: 4,
      isAvailable: () => services.sportmonks.isAvailable(),
      getQuotaStatus: () => services.sportmonks.getQuotaStatus(),
      fetchEvents: (dateStr) => services.sportmonks.fetchEvents(dateStr),
      fetchOdds: (fixtureId) => services.sportmonks.fetchPrematchOdds(fixtureId),
    })
    apiFallbackManager.registerSource({
      name: 'OpenLigaDB',
      priority: 6,
      isAvailable: () => services.openligadb.isAvailable(),
      getQuotaStatus: () => ({ available: services.openligadb.isAvailable() }),
      fetchEvents: (dateStr) => services.openligadb.fetchEvents(dateStr),
    })
    apiFallbackManager.registerSource({
      name: 'OddsAPIio',
      priority: 9,
      isAvailable: () => services.oddsApiIo.isAvailable(),
      getQuotaStatus: () => ({ available: services.oddsApiIo.isAvailable() }),
      fetchEvents: (sport, status, limit) => services.oddsApiIo.getEvents(sport, status, limit),
    })
    apiFallbackManager.registerSource({
      name: 'ClearSports',
      priority: 11,
      isAvailable: () => services.clearSports.isAvailable(),
      getQuotaStatus: () => ({ available: services.clearSports.isAvailable() }),
      fetchEvents: (dateStr) => services.clearSports.fetchEvents(dateStr),
      fetchOdds: (gameKey) => services.clearSports.fetchOdds(gameKey),
      fetchLiveEvents: () => services.clearSports.fetchLiveEvents(),
    })
    apiFallbackManager.registerSource({
      name: 'SportAPI',
      priority: 12,
      isAvailable: () => services.sportApi.isAvailable(),
      getQuotaStatus: () => ({ available: services.sportApi.isAvailable() }),
      fetchEvents: (dateStr) => services.sportApi.fetchEvents(dateStr),
      fetchOdds: (fixtureId) => services.sportApi.fetchOdds(fixtureId),
      fetchLiveEvents: () => services.sportApi.fetchLiveEvents(),
    })
    apiFallbackManager.registerSource({
      name: 'APINinjas',
      priority: 13,
      isAvailable: () => services.apiNinjas.isAvailable(),
      getQuotaStatus: () => ({ available: services.apiNinjas.isAvailable() }),
      fetchEvents: (dateStr) => services.apiNinjas.fetchEvents(dateStr),
      fetchLiveEvents: () => services.apiNinjas.fetchLiveEvents(),
    })
    logger.info('[FALLBACK] 8 API sources registered (TheRundown → APINinjas)')
  } catch (fbErr) {
    logger.warn(`[FALLBACK] Registration error: ${fbErr.message}`)
  }
}

module.exports = { registerAll }
