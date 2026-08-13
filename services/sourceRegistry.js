// sourceRegistry.js — declarative plugin registry for scraper sources.
//
// Any file dropped in config/sources/*.js exporting a plugin is auto-loaded.
// A plugin is:
//   {
//     name: 'mySource',
//     priority: 4,                       // lower = tried first
//     type: 'fixtures',                  // fixtures | results | odds | live
//     enabled: <bool|env-driven>,        // false disables without deleting file
//     fetch: async (dateStr) => [rows],  // returns canonical match rows
//     rate: { max, perMs, minTime, maxConcurrent },  // optional per-source throttling
//   }
//
// Adding a new source = drop one file. No core changes required.

const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')

const SOURCES_DIR = path.join(__dirname, '..', 'config', 'sources')

function loadPlugins(dir = SOURCES_DIR) {
  const plugins = []
  if (!fs.existsSync(dir)) return plugins
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    try {
      const plugin = require(path.join(dir, file))
      if (!plugin || !plugin.name || typeof plugin.fetch !== 'function') {
        logger.warn(`[SOURCE-REGISTRY] Skipping invalid plugin: ${file}`)
        continue
      }
      plugins.push(plugin)
    } catch (e) {
      logger.warn(`[SOURCE-REGISTRY] Failed to load plugin ${file}: ${e.message}`)
    }
  }
  return plugins
}

// Normalizes a plugin into the provider shape the orchestrator expects.
function toProvider(plugin) {
  const enabled = plugin.enabled !== undefined ? plugin.enabled : true
  return {
    name: plugin.name,
    priority: plugin.priority || 99,
    type: plugin.type || 'fixtures',
    enabled,
    rate: plugin.rate || null,
    timeoutMs: plugin.timeoutMs || null,
    async fetch(dateStr) {
      const raw = await plugin.fetch(dateStr)
      return raw || []
    },
    async fetchResults(dateStr) {
      if (typeof plugin.fetchResults !== 'function') return []
      const raw = await plugin.fetchResults(dateStr)
      return raw || []
    },
  }
}

// Pure transform: filter disabled, sort by priority, wrap as providers.
// Kept separate from loadPlugins() so it is fully testable without I/O.
function normalizePlugins(plugins) {
  return plugins
    .filter((p) => p.enabled !== false)
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .map(toProvider)
}

function buildProviders(dir = SOURCES_DIR) {
  return normalizePlugins(loadPlugins(dir))
}

module.exports = {
  SOURCES_DIR,
  loadPlugins,
  toProvider,
  normalizePlugins,
  buildProviders,
}
