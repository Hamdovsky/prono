const path = require('path')
const { toProvider, normalizePlugins, SOURCES_DIR } = require('../services/sourceRegistry')

function rawPlugins() {
  return [
    { name: 'alpha', priority: 2, type: 'fixtures', fetch: async () => [] },
    { name: 'beta', priority: 1, type: 'fixtures', enabled: false, fetch: async () => [] },
    { name: 'gamma', priority: 3, type: 'odds', fetch: async () => [] },
  ]
}

describe('sourceRegistry (pure logic)', () => {
  it('normalizePlugins filters disabled plugins and sorts by priority', () => {
    const providers = normalizePlugins(rawPlugins())
    // beta is disabled (enabled:false) -> filtered out
    expect(providers.map((p) => p.name)).toEqual(['alpha', 'gamma'])
    expect(providers[0].priority).toBe(2)
    expect(providers[1].priority).toBe(3)
  })

  it('normalizePlugins preserves order and includes all when none disabled', () => {
    const providers = normalizePlugins(rawPlugins().filter((p) => p.name !== 'beta'))
    expect(providers.map((p) => p.name)).toEqual(['alpha', 'gamma'])
  })

  it('toProvider shapes a provider with name/priority/type/fetch', () => {
    const provider = toProvider({
      name: 'x',
      priority: 5,
      type: 'live',
      fetch: async () => [1],
    })
    expect(provider.name).toBe('x')
    expect(provider.priority).toBe(5)
    expect(provider.type).toBe('live')
    expect(typeof provider.fetch).toBe('function')
  })

  it('toProvider defaults enabled/type and coerces fetch result to array', async () => {
    const provider = toProvider({ name: 'y', fetch: async () => null })
    expect(provider.enabled).toBe(true)
    expect(provider.type).toBe('fixtures')
    await expect(provider.fetch('2026-08-13')).resolves.toEqual([])
  })
})

describe('sourceRegistry (default dir)', () => {
  it('exposes the default sources directory', () => {
    expect(SOURCES_DIR.endsWith(path.join('config', 'sources'))).toBe(true)
  })
})
