/**
 * mlPredictionService — forward real_markets vers /predict (Market Engine activation)
 */
const pythonService = require('../core/pythonService')

jest.mock('../core/pythonService', () => ({
  predict: jest.fn(),
}))

const svc = require('../services/mlPredictionService')

beforeEach(() => {
  pythonService.predict.mockReset()
})

test('real_markets est forwarde a /predict quand present sur le match', async () => {
  const rm = [{ market_id: 'btts', selection: 'yes', odds: 1.8, usable: true }]
  pythonService.predict.mockResolvedValue({ success: true })
  await svc.getMLPrediction({ id: 'm1', homeTeam: 'A', awayTeam: 'B', real_markets: rm })
  expect(pythonService.predict).toHaveBeenCalledTimes(1)
  const sent = pythonService.predict.mock.calls[0][0]
  expect(sent.real_markets).toBe(rm)
})

test('real_markets lu depuis fullData si absent du match', async () => {
  const rm = [{ market_id: 'total_goals', selection: 'over', line: 2.5, odds: 1.9, usable: true }]
  pythonService.predict.mockResolvedValue({ success: true })
  await svc.getMLPrediction({
    id: 'm2', homeTeam: 'A', awayTeam: 'B',
    fullData: { real_markets: rm },
  })
  const sent = pythonService.predict.mock.calls[0][0]
  expect(sent.real_markets).toBe(rm)
})

test('pas de real_markets en absence de cotes reelles', async () => {
  pythonService.predict.mockResolvedValue({ success: true })
  await svc.getMLPrediction({ id: 'm3', homeTeam: 'A', awayTeam: 'B' })
  const sent = pythonService.predict.mock.calls[0][0]
  expect(sent.real_markets).toBeNull()
})
