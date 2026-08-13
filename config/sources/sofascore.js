// Source plugin: Sofascore (fallback, tournament coverage ~ all leagues).
// OPT-IN by default: on 403/429 its apiClient enters a global 480s cooldown
// sleep, which can hang a scan. Keep disabled until that 403 is resolved;
// enable explicitly with SOFASCORE_ENABLED=true once fixed.

module.exports = {
  name: 'sofascore',
  priority: 2,
  type: 'fixtures',
  enabled: process.env.SOFASCORE_ENABLED === 'true',
  async fetch(dateStr) {
    const { SofaAPI } = require('../../SofascoreScraping/src/apiClient')
    return SofaAPI.getEvents(dateStr)
  },
}
