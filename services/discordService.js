const axios = require('axios')
const logger = require('../core/logger')

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
const COOLDOWN_MS = 300000 // 5 min between dispatches to avoid rate-limit
let lastDispatch = 0
let pendingBatch = []

function formatEmbed(match) {
  const pick = (match.prediction || match.quant?.main_pick || '').toString().toUpperCase()
  const hWP = parseFloat(match.home_win_probability || 0)
  const dWP = parseFloat(match.draw_probability || 0)
  const aWP = parseFloat(match.away_win_probability || 0)
  const conf = pick === '1' ? hWP : pick === '2' ? aWP : dWP
  const expectedScore = match.expected_score || match.quant?.expected_score || 'N/A'
  const ou = match.ou_25_prob != null ? parseFloat(match.ou_25_prob).toFixed(1) : 'N/A'
  const btts = match.btts_prob != null ? parseFloat(match.btts_prob).toFixed(1) : 'N/A'
  const ev = parseFloat(match.ev_score || match.quant?.ev_score || 0).toFixed(2)

  const pickEmoji = pick === '1' ? '🔴' : pick === '2' ? '🔵' : '⚪'
  const confidenceStars = conf >= 90 ? '🌟🌟🌟' : conf >= 80 ? '🌟🌟' : conf >= 70 ? '🌟' : '💫'

  return {
    title: `${match.homeTeam} vs ${match.awayTeam}`,
    description: [
      `**League:** ${match.league || 'Unknown'}`,
      `**Kick-off:** ${match.time || match.startTimestamp ? new Date((match.startTimestamp > 1e11 ? match.startTimestamp : match.startTimestamp * 1000)).toUTCString() : 'TBD'}`,
      '',
      `**AI Pick:** ${pickEmoji} **${pick}** ${confidenceStars}`,
      `**Confidence:** ${conf.toFixed(1)}%`,
      `**Expected Score:** ${expectedScore}`,
      '',
      '```\n📊 6-Component Breakdown',
      `🔴🔵⚪ 1X2 Probs:  ${hWP.toFixed(1)}% / ${dWP.toFixed(1)}% / ${aWP.toFixed(1)}%`,
      `🎯 Confidence:    ${conf.toFixed(1)}%`,
      `⚽ Expected Score: ${expectedScore}`,
      `📈 O/U 2.5:       ${ou}%`,
      `🤝 BTTS:          ${btts}%`,
      `💰 EV:            ${ev}%`,
      '```'
    ].join('\n'),
    color: pick === '1' ? 0xE74C3C : pick === '2' ? 0x3498DB : 0x95A5A6,
    footer: { text: `Titanium AI • Match ID: ${match.id}` },
    timestamp: new Date().toISOString()
  }
}

async function dispatch(payload) {
  if (!WEBHOOK_URL) return false
  try {
    await axios.post(WEBHOOK_URL, payload, { timeout: 10000 })
    logger.info(`[DISCORD] Dispatched ${payload.embeds?.length || 0} prediction(s)`)
    return true
  } catch (e) {
    logger.warn(`[DISCORD] Dispatch failed: ${e.message}`)
    return false
  }
}

async function sendComboTicket(matches) {
  if (!WEBHOOK_URL) {
    logger.debug('[DISCORD] No DISCORD_WEBHOOK_URL set — skipping')
    return
  }
  if (!matches || matches.length === 0) return

  const now = Date.now()
  if (now - lastDispatch < COOLDOWN_MS) {
    logger.debug('[DISCORD] Cooldown active — batching for next window')
    pendingBatch.push(...matches)
    return
  }

  const batch = pendingBatch.length > 0 ? [...pendingBatch, ...matches] : matches
  pendingBatch = []

  const embeds = batch.slice(0, 10).map(formatEmbed)
  const payload = {
    username: 'Titanium AI',
    avatar_url: 'https://i.imgur.com/QqEEcZ3.png',
    embeds: [
      {
        title: '🎯 Combo Ticket — Top AI Predictions',
        description: `**${batch.length} high-confidence picks** (confidence > 75%)`,
        color: 0x9B59B6,
        fields: batch.slice(0, 10).map((m, i) => ({
          name: `${i + 1}. ${m.homeTeam} vs ${m.awayTeam}`,
          value: [
            `**Pick:** ${m.prediction || 'N/A'} | **Conf:** ${parseFloat(m.home_win_probability || m.draw_probability || m.away_win_probability || 0).toFixed(0)}%`,
            `**EV:** ${parseFloat(m.ev_score || 0).toFixed(2)} | **Score:** ${m.expected_score || 'N/A'}`
          ].join('\n'),
          inline: true
        })),
        footer: { text: `Titanium AI • ${batch.length} picks • ${new Date().toISOString()}` },
        timestamp: new Date().toISOString()
      }
    ]
  }

  if (batch.length > 10) {
    payload.embeds[0].description += `\n*(+${batch.length - 10} more in next dispatch)*`
  }

  await dispatch(payload)
  lastDispatch = now
}

async function sendDetailedPrediction(match) {
  if (!WEBHOOK_URL) return
  const embed = formatEmbed(match)
  const payload = {
    username: 'Titanium AI',
    avatar_url: 'https://i.imgur.com/QqEEcZ3.png',
    embeds: [embed]
  }
  await dispatch(payload)
}

async function flushPending() {
  if (pendingBatch.length === 0) return
  await sendComboTicket([])
}

setInterval(() => {
  if (pendingBatch.length > 0) {
    logger.debug(`[DISCORD] Flushing ${pendingBatch.length} pending predictions`)
    sendComboTicket([]).catch(() => {})
  }
}, 60000)

module.exports = { sendComboTicket, sendDetailedPrediction, flushPending }
