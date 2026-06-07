const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')
const remedies = require('./autoHealRemedies')
const notificationService = require('./notificationService')

const STATE_FILE = path.join(__dirname, '..', 'data', 'autoheal_state.json')

class AutoHealAgent {
  constructor() {
    this.enabled = process.env.AUTOHEAL_ENABLED !== 'false'
    this.active = false
    this.lastCheck = null
    this.consecutiveFailures = {}
    this.escalationThreshold = 3
    this.cooldowns = {}
    this.defaultCooldown = 10 * 60 * 1000
    this.criticalCooldown = 5 * 60 * 1000
    this._loadState()
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
        this.consecutiveFailures = data.consecutiveFailures || {}
        this.lastCheck = data.lastCheck || null
      }
    } catch (e) {
      logger.warn('🤖 [AUTOHEAL] Could not load state file')
    }
  }

  _saveState() {
    try {
      const dir = path.dirname(STATE_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        consecutiveFailures: this.consecutiveFailures,
        lastCheck: this.lastCheck
      }, null, 2))
    } catch (e) {
      // silent
    }
  }

  _canRun(remedyId) {
    const last = this.cooldowns[remedyId]
    if (!last) return true
    const remedy = remedies.getRegistry().find(r => r.id === remedyId)
    const cooldown = remedy && remedy.severity === 'critical' ? this.criticalCooldown : this.defaultCooldown
    return Date.now() - last > cooldown
  }

  async patrol() {
    if (!this.enabled) return
    if (this.active) {
      logger.info('🤖 [AUTOHEAL] Previous patrol still running, skipping')
      return
    }

    this.active = true
    this.lastCheck = new Date().toISOString()
    logger.info('🤖 [AUTOHEAL] Starting system patrol...')

    const issues = []
    const fixes = []

    for (const remedy of remedies.getRegistry()) {
      try {
        const result = await remedy.check()
        if (result.detected) {
          issues.push({ id: remedy.id, severity: remedy.severity, detail: result.detail, description: remedy.description })

          this.consecutiveFailures[remedy.id] = (this.consecutiveFailures[remedy.id] || 0) + 1
          const count = this.consecutiveFailures[remedy.id]

          if (count >= this.escalationThreshold && this._canRun(remedy.id)) {
            logger.warn(`🤖 [AUTOHEAL] ⚠️ ${remedy.id} detected ${count}x — applying fix: ${remedy.description}`)
            this.cooldowns[remedy.id] = Date.now()
            try {
              const fixResult = await remedy.fix()
              fixes.push({ id: remedy.id, success: fixResult.success, detail: fixResult.detail })
              if (fixResult.success) {
                this.consecutiveFailures[remedy.id] = 0
                logger.info(`🤖 [AUTOHEAL] ✅ Fix applied for ${remedy.id}: ${fixResult.detail}`)
              } else {
                logger.error(`🤖 [AUTOHEAL] ❌ Fix failed for ${remedy.id}: ${fixResult.detail}`)
              }
            } catch (fixErr) {
              fixes.push({ id: remedy.id, success: false, detail: fixErr.message })
              logger.error(`🤖 [AUTOHEAL] ❌ Fix error for ${remedy.id}: ${fixErr.message}`)
            }
          } else if (count < this.escalationThreshold) {
            logger.info(`🤖 [AUTOHEAL] 👀 ${remedy.id} (${count}/${this.escalationThreshold} detections) — monitoring before fix`)
          }
        } else {
          if (this.consecutiveFailures[remedy.id] && this.consecutiveFailures[remedy.id] > 0) {
            logger.info(`🤖 [AUTOHEAL] ✅ ${remedy.id} — system recovered`)
            notificationService.sendTelegramNotification(`✅ AUTOHEAL : ${remedy.description} — système rétabli`)
          }
          this.consecutiveFailures[remedy.id] = 0
        }
      } catch (checkErr) {
        logger.error(`🤖 [AUTOHEAL] Check error for ${remedy.id}: ${checkErr.message}`)
      }
    }

    this._saveState()

    const criticalCount = issues.filter(i => i.severity === 'critical').length
    const warningCount = issues.filter(i => i.severity === 'warning').length

    if (fixes.length > 0) {
      const successCount = fixes.filter(f => f.success).length
      const summary = fixes.map(f => `${f.success ? '✅' : '❌'} ${f.id}: ${f.detail}`).join('\n')
      notificationService.sendTelegramNotification(
        `🤖 AUTOHEAL PATROL\n` +
        `🔴 ${criticalCount} critique(s) | 🟡 ${warningCount} avertissement(s)\n` +
        `🛠️ ${successCount}/${fixes.length} fixes appliqués\n\n${summary}`
      )
    } else if (criticalCount > 0 || warningCount > 0) {
      logger.info(`🤖 [AUTOHEAL] ${criticalCount} critical, ${warningCount} warning — monitoring only (threshold ${this.escalationThreshold})`)
    } else {
      logger.info('🤖 [AUTOHEAL] ✅ All systems healthy')
    }

    this.active = false
  }

  getStatus() {
    return {
      enabled: this.enabled,
      active: this.active,
      lastCheck: this.lastCheck,
      consecutiveFailures: { ...this.consecutiveFailures },
      history: remedies.getHistory().slice(-20)
    }
  }

  async triggerPatrol() {
    await this.patrol()
    return this.getStatus()
  }
}

module.exports = new AutoHealAgent()
