// @ts-nocheck
import botService from '../services/botService'
import logger from './logger'
import database from './database'
import enrichedPredictions from './enriched_predictions'
import {  invalidateCache  } from './speedCache'

const SITE_URL = 'https://pronostico.onrender.com'

class TelegramBroadcaster {
  constructor() {
    this.sentIds = new Set()
  }

  isVip(match) {
    const quant = match.quant || {}
    const pick = (quant.main_pick || '').toString().trim().toUpperCase()
    const hWP = parseFloat(match.home_win_probability || 0)
    const aWP = parseFloat(match.away_win_probability || 0)
    const dvb =
      match.draw_value_bet === true || match.draw_value_bet === 'True' || match.draw_value_bet === 1
    const isSolidPick = (pick === '1' && hWP >= 75) || (pick === '2' && aWP >= 75)
    return isSolidPick || dvb
  }

  broadcastEliteSignals(matches) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      return
    }
    if (!matches || matches.length === 0) return

    let sentCount = 0

    for (const m of matches) {
      const sentKey = m.id || `${m.homeTeam}_${m.awayTeam}_${m.startTimestamp}`
      if (this.sentIds.has(sentKey)) continue

      const isVip = this.isVip(m)
      const msg = isVip ? this._buildVipMsg(m) : this._buildFreeMsg(m)
      if (!msg) continue

      try {
        botService._executeSend(msg)
        this.sentIds.add(sentKey)
        sentCount++
      } catch (e) {
        logger.error(`[TELEGRAM] Send failed for ${m.homeTeam} vs ${m.awayTeam}: ${e.message}`)
      }

      if (sentCount >= 5) break
    }

    if (sentCount > 0) {
      logger.info(`[TELEGRAM] Broadcast ${sentCount} elite signals to Telegram`)
    }
  }

  _buildFreeMsg(m) {
    const quant = m.quant || {}
    const pick = quant.main_pick || m.main_pick || m.pick || '—'
    const hWP = parseFloat(m.home_win_probability || 0)
    const dWP = parseFloat(m.draw_probability || 0)
    const aWP = parseFloat(m.away_win_probability || 0)
    const ev = parseFloat(quant.ev_score || m.ev_score || 0).toFixed(2)
    const league = m.league || m.tournament_name || 'International'

    const hStr = Number.isFinite(hWP) ? Math.round(hWP) : '?'
    const dStr = Number.isFinite(dWP) ? Math.round(dWP) : '?'
    const aStr = Number.isFinite(aWP) ? Math.round(aWP) : '?'

    return (
      `🚨 <b>SIGNAL DIRECT (Gratuit)</b>\n\n` +
      `🏆 <b>${escapeHtml(league)}</b>\n` +
      `⚽ ${escapeHtml(m.homeTeam)} vs ${escapeHtml(m.awayTeam)}\n\n` +
      `🎯 <b>Tendance:</b> ${pick}\n` +
      `📊 <b>Probabilités:</b> ${hStr}% / ${dStr}% / ${aStr}%\n` +
      `💵 <b>EV:</b> ${ev}\n\n` +
      `🔗 <a href="${SITE_URL}">Voir tous les pronostics du jour</a>`
    )
  }

  _buildVipMsg(m) {
    const quant = m.quant || {}
    const league = m.league || m.tournament_name || 'International'
    const bsm = parseFloat(m.base_solid_margin || 0)
    const dvb = m.draw_value_bet === true || m.draw_value_bet === 'True' || m.draw_value_bet === 1
    const pick = quant.main_pick || m.main_pick || m.pick || '—'
    const hWP = parseFloat(m.home_win_probability || 0)
    const aWP = parseFloat(m.away_win_probability || 0)

    let safetyIndicator = ''
    if (bsm > 0 && bsm >= 25) {
      safetyIndicator = `⚡ <b>BSM:</b> ${Math.round(bsm)}% (Base Solide)`
    } else if (dvb) {
      safetyIndicator = `🎯 <b>Draw Sniffer:</b> Valeur détectée (cote > 3.20)`
    }

    let probDisplay = ''
    if ((pick === '1' || pick === 'HOME') && Number.isFinite(hWP)) {
      probDisplay = `🎯 Probabilité domicile: ${Math.round(hWP)}% 🔒`
    } else if ((pick === '2' || pick === 'AWAY') && Number.isFinite(aWP)) {
      probDisplay = `🎯 Probabilité extérieur: ${Math.round(aWP)}% 🔒`
    } else {
      probDisplay = `📊 Probabilités: [Flouté 🔒]`
    }

    return (
      `👑 <b>PRONOSTIC VIP DÉTECTÉ (🔒 Verrouillé)</b>\n\n` +
      `🏆 <b>${escapeHtml(league)}</b>\n` +
      `⚽ ${escapeHtml(m.homeTeam)} vs ${escapeHtml(m.awayTeam)}\n\n` +
      `🎯 <b>Tendance:</b> 🔒 <i>Membre VIP uniquement</i>\n` +
      `${probDisplay}\n` +
      (safetyIndicator ? `${safetyIndicator}\n` : '') +
      `💰 Ce pronostic offre une <b>valeur certaine</b> avec un indice de confiance élevé.\n\n` +
      `🔓 <a href="${SITE_URL}">Débloquer gratuitement → regarder une pub</a>\n` +
      `💎 Ou <a href="${SITE_URL}">s'abonner au VIP</a> pour un accès illimité`
    )
  }

  /** Intégration cron: enrichit + invalide + broadcast */
  async runEnrichmentAndBroadcast() {
    try {
      const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
      const stale = matches
        .filter((m) => {
          const hasProbs = parseFloat(m.home_win_probability) > 0
          const hasPick = m.quant?.main_pick || m.main_pick
          return !hasProbs || !hasPick
        })
        .slice(0, 100)

      if (stale.length > 0) {
        logger.info(`⏰ [TELEGRAM] Enriching ${stale.length} stale matches before broadcast...`)
        const enriched = await enrichedPredictions.enrichMatches(stale, { fastMode: true })
        for (const m of enriched) {
          try {
            await database.updatePredictions(m.id, m)
          } catch (_) {}
        }
      }

      invalidateCache('upcoming')

      const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
      const withProbs = allMatches.filter((m) => parseFloat(m.home_win_probability) > 0)
      this.broadcastEliteSignals(withProbs)

      logger.info(`✅ [TELEGRAM] Enrichment + broadcast cycle complete`)
    } catch (e) {
      logger.error(`❌ [TELEGRAM] Cycle error: ${e.message}`)
    }
  }
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '')
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export = new TelegramBroadcaster()
