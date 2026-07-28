const logger = require('./logger')
const database = require('./database')

const API_KEY_DEFINITIONS = [
  ['BSD_API_KEY', 'BSD Bzzoiro', true],
  ['ODDSPAPI_KEY', 'OddsPapi', true],
  ['FOOTBALLDATA_KEY', 'FootballData.io', false],
  ['RAPIDAPI_KEY', 'RapidAPI SportAPI', false],
  ['THERUNDOWN_KEY', 'TheRundown', false],
  ['SPORTMONKS_KEY', 'Sportmonks', false],
  ['APIFOOTBALL_KEY', 'APIFootball', false],
  ['SUPABASE_URL', 'Neon PostgreSQL', true],
  ['INFERENCE_URL', 'Python FastAPI', false],
  ['PREDIXSPORT_API_KEY', 'PredixSport API', false],
  ['BBS_API_KEY', 'Big Balls Data', false],
  ['ODDSAPI_IO_KEY', 'Odds-API.io', false],
  ['GROQ_API_KEY', 'Groq AI', false],
  ['GEMINI_API_KEY', 'Gemini AI', false],
  ['FUTPYTHONTRADER_API_KEY', 'FutPythonTrader', false],
]

function validateKeys() {
  if (process.env.LOCAL_DATA_URL) {
    logger.info('[API-KEYS] LOCAL_DATA_URL active — external API keys skipped, using ngrok tunnel')
    return { allPresent: true, missing: [], critical: [], localMode: true }
  }

  const missing = []
  const critical = []
  const present = []

  for (const [key, name, isCritical] of API_KEY_DEFINITIONS) {
    const val = process.env[key]
    if (!val || val.startsWith('CHANGER_MOI') || val === 'your_key_here') {
      missing.push({ key, name, isCritical })
      if (isCritical) critical.push(name)
    } else {
      present.push(name)
    }
  }

  logger.info('══════════════════════════════════════════')
  logger.info('[API-KEYS] Diagnostic au démarrage:')
  logger.info(`  ✅ Configurées: ${present.length} / ${API_KEY_DEFINITIONS.length}`)
  if (present.length > 0) {
    logger.info(`     ${present.join(', ')}`)
  }
  if (missing.length > 0) {
    logger.warn(`  ❌ Manquantes: ${missing.length}`)
    for (const m of missing) {
      const tag = m.isCritical ? '⚠️  CRITIQUE' : 'optionnel'
      logger.warn(`     ❌ ${m.name} (${m.key}) — ${tag}`)
    }
    logger.info('  → https://dashboard.render.com → Environment → ajoutez ces clés')
  } else {
    logger.info('  ✅ Toutes les clés API sont configurées')
  }
  logger.info('══════════════════════════════════════════')

  return {
    allPresent: missing.length === 0,
    missing,
    critical,
    present,
    localMode: false,
  }
}

async function verifyDatabase() {
  try {
    const count = await database.query('SELECT COUNT(*) as cnt FROM matches')
    const total = parseInt(count?.rows?.[0]?.cnt || count?.[0]?.cnt || 0)

    const scheduled = await database.query(
      "SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','notstarted','NS','not_started')"
    )
    const schedCount = parseInt(scheduled?.rows?.[0]?.c || scheduled?.[0]?.c || 0)

    return { total, scheduled: schedCount, healthy: total > 0 }
  } catch (e) {
    logger.warn(`[API-KEYS] Database check failed: ${e.message}`)
    return { total: 0, scheduled: 0, healthy: false }
  }
}

function logAvailability() {
  const sources = [
    { name: 'SofaScore', check: () => !process.env.DISABLE_SOFASCORE },
    { name: 'BSD', check: () => !!process.env.BSD_API_KEY },
    { name: 'FootballData', check: () => !!process.env.FOOTBALLDATA_KEY },
    { name: 'RapidAPI', check: () => !!process.env.RAPIDAPI_KEY },
    { name: 'Sportmonks', check: () => !!process.env.SPORTMONKS_KEY },
    { name: 'APIFootball', check: () => !!process.env.APIFOOTBALL_KEY },
    { name: 'OddsPapi', check: () => !!process.env.ODDSPAPI_KEY },
    { name: 'TheRundown', check: () => !!process.env.THERUNDOWN_KEY },
    { name: 'PredixSport', check: () => !!process.env.PREDIXSPORT_API_KEY },
    { name: 'GROQ', check: () => !!process.env.GROQ_API_KEY },
    { name: 'DeepSeek', check: () => !!process.env.DEEPSEEK_API_KEY },
    { name: 'OpenLigaDB', check: () => true },
    { name: 'Promosport', check: () => true },
  ]
  const available = sources.filter((s) => s.check()).map((s) => s.name)
  const missing = sources.filter((s) => !s.check()).map((s) => s.name)
  logger.info(`[STARTUP] APIs available: ${available.join(', ')}`)
  if (missing.length) logger.warn(`[STARTUP] APIs missing keys: ${missing.join(', ')}`)
}

module.exports = { validateKeys, verifyDatabase, logAvailability, API_KEY_DEFINITIONS }
