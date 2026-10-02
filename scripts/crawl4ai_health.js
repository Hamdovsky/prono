/**
 * crawl4ai_health.js — Sonde CLI du service Crawl4AI (:11235)
 * Usage: node scripts/crawl4ai_health.js
 *        node scripts/crawl4ai_health.js --json
 * Exit: 0 si /health 200, 1 sinon
 */
const resolver = require('../core/utils/crawl4aiResolver')

async function main() {
  const jsonMode = process.argv.includes('--json')
  const url = resolver.getCrawl4aiUrl()
  const enabled = resolver.isCrawl4aiEnabled()
  const timeoutMs = parseInt(process.env.CRAWL4AI_HEALTH_TIMEOUT_MS || '3000', 10)

  const started = Date.now()
  const res = await resolver.getHealth({ timeoutMs })
  const elapsed = Date.now() - started

  const out = {
    enabled,
    url,
    ok: res.ok,
    status: res.status,
    elapsed_ms: elapsed,
    payload: res.payload,
  }

  if (jsonMode) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    if (!enabled) console.log('[CRAWL4AI] CRAWL4AI_ENABLED=off (service non interroge en prod sans flag)')
    console.log('[CRAWL4AI] URL: ' + url)
    console.log('[CRAWL4AI] Health: ' + (res.ok ? 'OK' : 'DOWN') + ' status=' + res.status + ' ' + elapsed + 'ms')
    if (res.payload) console.log('[CRAWL4AI] Payload: ' + JSON.stringify(res.payload))
    if (!res.ok) console.log('[CRAWL4AI] Astuce: lance .venv-crawl4ai\\Scripts\\python scripts/crawl4ai_service.py')
  }

  process.exit(res.ok ? 0 : 1)
}

main().catch((e) => {
  console.error('[CRAWL4AI] health error: ' + (e && e.message ? e.message : String(e)))
  process.exit(1)
})
