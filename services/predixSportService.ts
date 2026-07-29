// @ts-nocheck
import axios from 'axios'
import logger from '../core/logger'

const BASE_URL = 'https://api.predixsport.com'

class PredixSportService {
  constructor() {
    this.apiKey = process.env.PREDIXSPORT_API_KEY || ''
    this.enabled = process.env.PREDIXSPORT_ENABLED !== 'false'
    this._authFailed = false
    this._quotaExhausted = false
    this._resetDate = null

    if (!this.apiKey) {
      logger.warn('[PredixSport] PREDIXSPORT_API_KEY manquant dans .env / Render Environment')
    } else if (!this.enabled) {
      logger.warn('[PredixSport] Service désactivé (PREDIXSPORT_ENABLED=false)')
    } else {
      logger.info(`[PredixSport] Service prêt — clé: ${this.apiKey.substring(0, 6)}...`)
    }
  }

  isAvailable() {
    if (!this.enabled) return false
    if (!this.apiKey) return false
    if (this._authFailed) return false
    if (this._quotaExhausted) return false
    return true
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    }
  }

  async _fetch(endpoint) {
    if (!this.enabled || !this.apiKey) {
      logger.warn('[PredixSport] Appel ignoré — clé absente')
      return null
    }
    if (this._authFailed) {
      logger.warn('[PredixSport] Appel ignoré — clé invalide (401). Vérifiez PREDIXSPORT_API_KEY.')
      return null
    }
    if (this._quotaExhausted) {
      logger.warn(
        `[PredixSport] Appel ignoré — quota épuisé, reset ${this._resetDate || 'inconnu'}`
      )
      return null
    }

    try {
      const { data } = await axios.get(`${BASE_URL}${endpoint}`, {
        headers: this._headers(),
        timeout: 10000,
      })
      return data
    } catch (err) {
      const status = err.response?.status
      const body = JSON.stringify(err.response?.data || {}).substring(0, 200)

      if (status === 401 || status === 403) {
        this._authFailed = true
        logger.error(`[PredixSport] ERREUR ${status} — Clé API invalide ou accès refusé`)
      } else if (status === 429) {
        this._quotaExhausted = true
        this._resetDate = err.response?.headers?.['x-ratelimit-reset-date'] || 'fin du mois'
        logger.warn(`[PredixSport] Quota épuisé (429) — reset ${this._resetDate}`)
      } else if (!err.response) {
        logger.error(`[PredixSport] Erreur réseau (${endpoint}): ${err.message}`)
      } else {
        logger.error(`[PredixSport] Erreur ${status} (${endpoint}): ${err.message} | Body: ${body}`)
      }
      return null
    }
  }

  // ── PUBLIC API ─────────────────────────────────────────────────

  async fetchUpcoming(days = 1) {
    const data = await this._fetch(`/v1/predictions/football/upcoming?days=${days}`)
    return data?.matches || []
  }

  async fetchPrediction(matchId) {
    return await this._fetch(`/v1/predictions/football/${matchId}`)
  }

  // ── MATCH MAPPING ───────────────────────────────────────────────

  _buildMatchId(homeTeam, awayTeam, dateStr) {
    const sanitize = (name) =>
      name
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
    return `${sanitize(homeTeam)}_${sanitize(awayTeam)}_${dateStr}`
  }

  _normalizeDate(ts) {
    if (!ts) return new Date().toISOString().split('T')[0]
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
    return d.toISOString().split('T')[0]
  }

  _mapPrediction(pred, homeTeam, awayTeam) {
    const probs = pred.probabilities || {}
    return {
      home_win: probs.home_win || null,
      draw: probs.draw || null,
      away_win: probs.away_win || null,
      predicted_result: probs.predicted_result || null,
      under_2_5: probs.under_2_5 || null,
      over_2_5: probs.over_2_5 || null,
      btts_yes: probs.btts_yes || null,
      btts_no: probs.btts_no || null,
      expected_corners: pred.expected_corners || null,
      expected_shots: pred.expected_shots || null,
      expected_spread: pred.expected_spread || null,
      league: pred.league || null,
      home_team: pred.home_team || homeTeam,
      away_team: pred.away_team || awayTeam,
      prediction_date: pred.prediction_date || null,
    }
  }

  // ── SYNC ────────────────────────────────────────────────────────

  async syncUpcoming() {
    if (!this.isAvailable()) {
      logger.warn('[PredixSport] Sync skipped — service not available')
      return []
    }

    const matches = await this.fetchUpcoming(2)
    if (!matches || matches.length === 0) {
      logger.info('[PredixSport] Aucun match à venir trouvé')
      return []
    }

    logger.info(`[PredixSport] ${matches.length} matchs récupérés`)
    import database from '../core/database'
    let updated = 0

    for (const m of matches) {
      try {
        const homeTeam = m.home_team || m.homeTeam || ''
        const awayTeam = m.away_team || m.awayTeam || ''
        if (!homeTeam || !awayTeam) continue

        const dateStr = m.prediction_date || this._normalizeDate(Date.now())
        const mapped = this._mapPrediction(m, homeTeam, awayTeam)

        const existing = database.db
          ?.prepare(
            'SELECT id FROM matches WHERE homeTeam = ? AND awayTeam = ? AND DATE(timestamp) = ? LIMIT 1'
          )
          .get(homeTeam, awayTeam, dateStr)

        if (existing) {
          const fd = JSON.parse(
            database.db.prepare('SELECT fullData FROM matches WHERE id = ?').get(existing.id)
              ?.fullData || '{}'
          )
          fd.predixsport = mapped
          database.db
            .prepare('UPDATE matches SET fullData = ? WHERE id = ?')
            .run(JSON.stringify(fd), existing.id)
          updated++
        } else {
          logger.info(
            `[PredixSport] Match non trouvé en DB: ${homeTeam} vs ${awayTeam} (${dateStr})`
          )
        }
      } catch (err) {
        logger.error(`[PredixSport] Erreur sync match: ${err.message}`)
      }
    }

    logger.info(`[PredixSport] Sync terminée: ${updated}/${matches.length} matchs mis à jour`)
    return matches
  }
}

export = new PredixSportService()
