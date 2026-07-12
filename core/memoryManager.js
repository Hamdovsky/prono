const logger = require('./logger')

let memoryPressureLevel = 0
const THRESHOLD_WARNING = 0.75
const THRESHOLD_CRITICAL = 0.90

function getHeapStats() {
  const v8 = require('v8')
  const stats = v8.getHeapStatistics()
  const usedMB = stats.used_heap_size / 1024 / 1024
  const limitMB = stats.heap_size_limit / 1024 / 1024
  const ratio = stats.used_heap_size / stats.heap_size_limit
  return { usedMB, limitMB, ratio, stats }
}

function logMemory() {
  const { usedMB, limitMB, ratio } = getHeapStats()
  const level = ratio > THRESHOLD_CRITICAL ? '🔴' : ratio > THRESHOLD_WARNING ? '🟡' : '🟢'
  logger.info(`[MEM] ${level} Heap: ${usedMB.toFixed(1)} MB / ${limitMB.toFixed(1)} MB (${(ratio * 100).toFixed(1)}%)`)
  return ratio
}

function maybeGC() {
  if (typeof global.gc !== 'function') return false
  const ratio = getHeapStats().ratio
  if (ratio > THRESHOLD_WARNING) {
    memoryPressureLevel++
    if (memoryPressureLevel % 5 === 0) {
      logger.info(`[MEM] High memory pressure (level ${memoryPressureLevel}) — forcing GC`)
    }
    try { global.gc() } catch (_) {}
    return true
  }
  memoryPressureLevel = 0
  return false
}

function startPeriodicCheck(intervalMs = 60000) {
  const timer = setInterval(() => {
    const ratio = logMemory()
    if (ratio > THRESHOLD_CRITICAL) {
      logger.warn(`[MEM] CRITICAL memory usage — forcing GC`)
      try { if (typeof global.gc === 'function') global.gc() } catch (_) {}
    }
  }, intervalMs)
  timer.unref()
  return timer
}

module.exports = { getHeapStats, logMemory, maybeGC, startPeriodicCheck }
