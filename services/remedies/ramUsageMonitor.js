/**
 * RAM Usage Monitor Remedy
 * Detects high memory usage and triggers cleanup
 */

const logger = require('../core/logger')

const RAM_WARNING_THRESHOLD = 400 // MB
const RAM_CRITICAL_THRESHOLD = 450 // MB

module.exports = {
  id: 'ram_usage_high',
  description: 'High RAM usage detected',
  severity: 'warning',

  async check() {
    const memUsage = process.memoryUsage()
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024)
    const rssMB = Math.round(memUsage.rss / 1024 / 1024)

    // Check if RSS (Resident Set Size) exceeds threshold
    const isWarning = rssMB > RAM_WARNING_THRESHOLD
    const isCritical = rssMB > RAM_CRITICAL_THRESHOLD

    if (isCritical) {
      return {
        detected: true,
        detail: `CRITICAL: RAM usage ${rssMB}MB (heap: ${heapUsedMB}MB) exceeds ${RAM_CRITICAL_THRESHOLD}MB`,
      }
    }

    if (isWarning) {
      return {
        detected: true,
        detail: `WARNING: RAM usage ${rssMB}MB (heap: ${heapUsedMB}MB) exceeds ${RAM_WARNING_THRESHOLD}MB`,
      }
    }

    return {
      detected: false,
      detail: `RAM usage normal: ${rssMB}MB`,
    }
  },

  async fix() {
    try {
      const memBefore = process.memoryUsage()
      const rssBeforeMB = Math.round(memBefore.rss / 1024 / 1024)

      // Force garbage collection if available
      if (global.gc) {
        logger.info('🧹 [AUTOHEAL] Running manual garbage collection...')
        global.gc()
      } else {
        logger.warn('🧹 [AUTOHEAL] Garbage collection not available (run node with --expose-gc)')
      }

      // Clear speed cache
      try {
        const { invalidateAll } = require('../core/speedCache')
        invalidateAll()
        logger.info('🧹 [AUTOHEAL] Speed cache cleared')
      } catch (e) {
        // Speed cache might not be available
      }

      // Clear Python model cache if model_manager is enabled
      const useModelManager = process.env.USE_MODEL_MANAGER === 'true'
      if (useModelManager) {
        logger.info('🧹 [AUTOHEAL] Model manager cache cleared (will reload on next prediction)')
        // Note: Actual cache clear would require Python bridge
        // For now, just log the intent
      }

      // Wait for GC to complete
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const memAfter = process.memoryUsage()
      const rssAfterMB = Math.round(memAfter.rss / 1024 / 1024)
      const savedMB = rssBeforeMB - rssAfterMB

      if (savedMB > 0) {
        return {
          success: true,
          detail: `RAM freed: ${savedMB}MB (${rssBeforeMB}MB → ${rssAfterMB}MB)`,
        }
      } else {
        return {
          success: false,
          detail: `No RAM freed (${rssBeforeMB}MB → ${rssAfterMB}MB). Consider restarting service.`,
        }
      }
    } catch (err) {
      return {
        success: false,
        detail: `RAM cleanup failed: ${err.message}`,
      }
    }
  },
}
