/**
 * 🌐 TITANIUM AI - OPENROUTER INTEGRATION SERVICE
 * -------------------------------------------------------------
 * Unified OpenAI-compatible gateway via OpenRouter.
 * Allows routing any model (default openai/gpt-4o) through a single
 * OpenAI-compatible /chat/completions endpoint.
 */

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const dotenv = require('dotenv')
const logger = require('../core/logger')

dotenv.config()

const USAGE_FILE = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/openrouter_usage.json')
const MAX_MONTHLY_LIMIT = parseInt(process.env.OPENROUTER_MAX_MONTHLY_CALLS || '200')
const SITE_URL = process.env.OPENROUTER_SITE_URL || ''
const SITE_TITLE = process.env.OPENROUTER_SITE_TITLE || 'Titanium AI'

class OpenRouterService {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY || ''
    this.apiUrl = 'https://openrouter.ai/api/v1/chat/completions'
    this.model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o'
  }

  _getUsage() {
    const currentMonth = new Date().toISOString().substring(0, 7)
    const defaultUsage = { current_month: currentMonth, count: 0 }

    try {
      if (!fs.existsSync(USAGE_FILE)) {
        const parentDir = path.dirname(USAGE_FILE)
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true })
        }
        fs.writeFileSync(USAGE_FILE, JSON.stringify(defaultUsage, null, 2), 'utf8')
        return defaultUsage
      }

      const raw = fs.readFileSync(USAGE_FILE, 'utf8')
      const data = JSON.parse(raw)

      if (data.current_month !== currentMonth) {
        logger.info(
          `📅 [OPENROUTER] New month detected (${currentMonth}). Resetting API quota usage from ${data.count} to 0.`
        )
        const resetData = { current_month: currentMonth, count: 0 }
        fs.writeFileSync(USAGE_FILE, JSON.stringify(resetData, null, 2), 'utf8')
        return resetData
      }

      return data
    } catch (e) {
      logger.error(`❌ [OPENROUTER] Failed to load usage file: ${e.message}`)
      return defaultUsage
    }
  }

  _incrementUsage() {
    try {
      const usage = this._getUsage()
      usage.count++
      fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8')
      logger.info(
        `📈 [OPENROUTER] Usage incremented: ${usage.count}/${MAX_MONTHLY_LIMIT} requests used this month.`
      )
      return usage.count
    } catch (e) {
      logger.error(`❌ [OPENROUTER] Failed to increment usage file: ${e.message}`)
      return 0
    }
  }

  isQuotaAvailable() {
    if (!this.apiKey) {
      logger.warn('⚠️ [OPENROUTER] API Key is missing in .env file.')
      return false
    }
    const usage = this._getUsage()
    if (usage.count >= MAX_MONTHLY_LIMIT) {
      logger.warn(
        `🛑 [OPENROUTER] API Call Blocked! Monthly soft-cap of ${MAX_MONTHLY_LIMIT} reached (${usage.count} used).`
      )
      return false
    }
    return true
  }

  getQuotaStatus() {
    const usage = this._getUsage()
    return {
      month: usage.current_month,
      used: usage.count,
      limit: MAX_MONTHLY_LIMIT,
      remaining: Math.max(0, MAX_MONTHLY_LIMIT - usage.count),
      isActive: usage.count < MAX_MONTHLY_LIMIT && !!this.apiKey,
    }
  }

  /**
   * Generic chat completion through OpenRouter.
   * @param {Array} messages - [{ role: 'system'|'user'|'assistant', content: string }]
   * @param {Object} opts - { model, temperature, max_tokens, responseFormat }
   */
  async chat(messages, opts = {}) {
    if (!this.isQuotaAvailable()) {
      return null
    }

    const model = opts.model || this.model
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE_URL,
      'X-Title': SITE_TITLE,
    }

    const payload = {
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens || 1000,
    }

    if (opts.responseFormat) {
      payload.response_format = opts.responseFormat
    }

    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers,
        timeout: opts.timeout || 30000,
      })

      this._incrementUsage()
      return response.data
    } catch (error) {
      logger.error(`❌ [OPENROUTER] API Call Failed: ${error.message}`)
      if (error.response) {
        logger.error(`   Détails API: ${JSON.stringify(error.response.data)}`)
      }
      return null
    }
  }

  /**
   * Convenience helper: single user prompt -> parsed JSON (when responseFormat json_object).
   */
  async queryJson(systemPrompt, userPrompt, opts = {}) {
    const data = await this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { ...opts, responseFormat: { type: 'json_object' } }
    )
    if (!data) return null
    try {
      return JSON.parse(data.choices[0].message.content)
    } catch (e) {
      logger.error(`❌ [OPENROUTER] Failed to parse JSON response: ${e.message}`)
      return null
    }
  }
}

module.exports = new OpenRouterService()
