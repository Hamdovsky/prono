const { SourceRateLimiter } = require('../services/sourceRateLimiter')

describe('SourceRateLimiter', () => {
  it('passes through when no rate is configured', async () => {
    const limiter = new SourceRateLimiter()
    const fn = jest.fn(async () => 'ok')
    expect(await limiter.schedule('nosource', null, fn)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('creates one limiter per source', async () => {
    const limiter = new SourceRateLimiter()
    await limiter.schedule('a', { max: 10, perMs: 60000 }, async () => 1)
    await limiter.schedule('b', { max: 10, perMs: 60000 }, async () => 2)
    expect(limiter.limiters.size).toBe(2)
  })

  it('reuses the same limiter for the same source', async () => {
    const limiter = new SourceRateLimiter()
    const rate = { max: 10, perMs: 60000 }
    const l1 = limiter._get('x', rate)
    const l2 = limiter._get('x', rate)
    expect(l1).toBe(l2)
  })

  it('serializes calls when maxConcurrent = 1', async () => {
    const limiter = new SourceRateLimiter()
    const order = []
    const fn = async () => {
      order.push('start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('end')
    }
    await Promise.all([
      limiter.schedule('a', { max: 10, perMs: 60000, maxConcurrent: 1 }, fn),
      limiter.schedule('a', { max: 10, perMs: 60000, maxConcurrent: 1 }, fn),
    ])
    expect(order).toEqual(['start', 'end', 'start', 'end'])
  })

  it('reports null status for an unknown source', () => {
    const limiter = new SourceRateLimiter()
    expect(limiter.status('nope')).toBeNull()
  })
})
