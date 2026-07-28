const logger = require('./logger')

let lastResult = null

async function run(force = false, limit = 20) {
  logger.info(`[_enrich_news] Run called (force=${force}, limit=${limit}) - stub`)
  lastResult = { status: 'stub', processed: 0, timestamp: Date.now() }
  return lastResult
}

function getLastRunResult() {
  return lastResult || { status: 'never_run', processed: 0 }
}

module.exports = { run, getLastRunResult }
