const axios = require('axios')
const database = require('../core/database')

;(async () => {
  console.log('Fetching insufficient_data matches...')
  const matches = await database.getInsufficientDataMatches()
  console.log(`Found ${matches.length} matches to enrich.`)

  if (matches.length === 0) {
    console.log('No matches to enrich. Exiting.')
    return
  }

  const payload = {
    matches: matches.map((m) => ({
      id: m.id,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      league: m.league || m.tournament_name || '',
    })),
  }

  console.log(`Sending ${payload.matches.length} matches to /fallback/enrich-batch...`)
  try {
    const response = await axios.post('http://127.0.0.1:8000/fallback/enrich-batch', payload, {
      timeout: 300000,
      headers: { 'Content-Type': 'application/json' },
    })
    console.log('Response:', JSON.stringify(response.data, null, 2))
  } catch (err) {
    console.error('Request failed:', err.message)
    if (err.response)
      console.error('Status:', err.response.status, 'Data:', JSON.stringify(err.response.data))
  }
})().catch((e) => console.error(e))
