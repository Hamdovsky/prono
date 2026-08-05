/**
 * Bot Service Unit Tests
 * Tests for services/botService.js - Telegram bot commands and alerts
 */

const botService = require('../services/botService')
const https = require('https')

jest.mock('../core/database', () => ({
  getMatchesByStatuses: jest.fn().mockResolvedValue([
    {
      id: 'm1',
      homeTeam: 'Team A',
      awayTeam: 'Team B',
      startTimestamp: Date.now() + 3600000,
      home_win_probability: 60,
      away_win_probability: 25,
      draw_probability: 15,
      expected_score: '2-0',
      ou_25_prob: 70,
      enriched: { confidence: 80 },
    },
  ]),
}))

jest.mock('../core/enriched_predictions', () => ({
  fastEnrichMatch: jest.fn((m) =>
    Promise.resolve({
      ...m,
      home_win_probability: m.home_win_probability || 60,
      away_win_probability: m.away_win_probability || 25,
      draw_probability: m.draw_probability || 15,
      ou_25_prob: m.ou_25_prob || 70,
      expected_score: m.expected_score || '2-0',
      enriched: { confidence: m.enriched?.confidence || 80 },
    })
  ),
  enrichMatch: jest.fn(),
}))

describe('BotService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    botService.isPolling = false
    delete botService.lastUpdateId
  })

  describe('startPolling()', () => {
    it('should not start polling if token is missing', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = null
      botService.chatId = 'test-chat'

      botService.startPolling()
      expect(botService.isPolling).toBeFalsy()

      botService.token = origToken
      botService.chatId = origChatId
    })

    it('should not start polling if chatId is missing', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = null

      botService.startPolling()
      expect(botService.isPolling).toBeFalsy()

      botService.token = origToken
      botService.chatId = origChatId
    })

    it('should start polling with valid credentials', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = 'test-chat'

      botService.startPolling()

      expect(botService.isPolling).toBe(true)
      expect(botService.lastUpdateId).toBe(0)

      botService.token = origToken
      botService.chatId = origChatId
    })

    it('should not start multiple polling instances', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = 'test-chat'

      botService.startPolling()
      const firstId = botService.lastUpdateId

      botService.startPolling()
      expect(botService.lastUpdateId).toBe(firstId)

      botService.token = origToken
      botService.chatId = origChatId
    })
  })

  describe('_executeSend()', () => {
    it('should send message to Telegram API', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = 'test-chat'

      const originalRequest = https.request
      let mockReq
      const mockRequest = jest.fn().mockImplementation((url, options, callback) => {
        const res = {
          statusCode: 200,
          on: (event, handler) => {
            if (event === 'data') handler(Buffer.from('{"ok":true}'))
          },
        }
        setTimeout(() => callback(res), 0)
        mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() }
        return mockReq
      })

      https.request = mockRequest

      botService._executeSend('Test message', 'test-chat-id')

      expect(mockRequest).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
        expect.any(Function)
      )

      https.request = originalRequest
      botService.token = origToken
      botService.chatId = origChatId
    })

    it('should handle keyboard markup', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = 'test-chat'

      const originalRequest = https.request
      let mockReq
      const mockRequest = jest.fn().mockImplementation(() => {
        mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() }
        return mockReq
      })

      https.request = mockRequest

      const keyboard = { inline_keyboard: [[{ text: 'Test', url: 'https://test.com' }]] }
      botService._executeSend('Test', 'chat-id', keyboard)

      expect(mockRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
        expect.any(Function)
      )

      const parsedBody = JSON.parse(mockReq.write.mock.calls[0][0])
      expect(parsedBody.reply_markup).toEqual(keyboard)

      https.request = originalRequest
      botService.token = origToken
      botService.chatId = origChatId
    })

    it('should log errors on failed Telegram request', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = 'test-chat'

      const originalRequest = https.request
      const mockRequest = jest.fn().mockImplementation(() => ({
        write: jest.fn(),
        end: jest.fn(),
        on: (event, handler) => {
          if (event === 'error') handler(new Error('Network error'))
        },
      }))

      https.request = mockRequest
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      botService._executeSend('Test message')

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Telegram Alert Failed:')
      )

      consoleErrorSpy.mockRestore()
      https.request = originalRequest
      botService.token = origToken
      botService.chatId = origChatId
    })
  })

  describe('sendAlert()', () => {
    it('should send system alert with proper formatting', () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = 'test-chat'

      const originalRequest = https.request
      let mockReq
      const mockRequest = jest.fn().mockImplementation(() => {
        mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() }
        return mockReq
      })

      https.request = mockRequest

      botService.sendAlert('Server overload detected')

      const parsedBody = JSON.parse(mockReq.write.mock.calls[0][0])
      expect(parsedBody.text).toContain('SYSTEM ALERT')
      expect(parsedBody.text).toContain('Server overload detected')

      https.request = originalRequest
      botService.token = origToken
      botService.chatId = origChatId
    })
  })

  describe('broadcastMatch()', () => {
    it('should broadcast high-value matches', () => {
      botService.alertedMatchIds.clear()

      const match = {
        id: 'high-value-match',
        enriched: { winnerProbability: 0.75 },
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        league: 'Test League',
        time: '20:00',
      }

      botService.broadcastMatch(match)

      expect(botService.alertedMatchIds.has(match.id)).toBe(true)
    })

    it('should not broadcast low-value matches', () => {
      botService.alertedMatchIds.clear()

      const match = {
        id: 'low-value-match',
        enriched: { winnerProbability: 0.55 }, // Below threshold
        homeTeam: 'Team C',
        awayTeam: 'Team D',
      }

      botService.broadcastMatch(match)

      expect(botService.alertedMatchIds.has(match.id)).toBe(false)
    })

    it('should not re-broadcast already alerted matches', () => {
      botService.alertedMatchIds.clear()
      const matchId = 'already-alerted'

      botService.broadcastMatch({ id: matchId, enriched: { winnerProbability: 0.8 } })
      botService.broadcastMatch({ id: matchId, enriched: { winnerProbability: 0.9 } }) // Second call

      expect(botService.alertedMatchIds.size).toBe(1)
    })
  })

  describe('reset()', () => {
    it('should clear alerted match IDs', () => {
      botService.alertedMatchIds.add('match-1')
      botService.alertedMatchIds.add('match-2')
      botService.alertedComboIds.add('combo-1')

      botService.reset()

      expect(botService.alertedMatchIds.size).toBe(0)
      expect(botService.alertedComboIds.size).toBe(0)
    })
  })

  describe('Command handlers', () => {
    it('_handleGoldenCoupon should send formatted message', async () => {
      const origToken = botService.token
      const origChatId = botService.chatId
      botService.token = 'test-token'
      botService.chatId = 'test-chat'

      const originalRequest = https.request
      let mockReq
      const mockRequest = jest.fn().mockImplementation(() => {
        mockReq = { write: jest.fn(), end: jest.fn(), on: jest.fn() }
        return mockReq
      })

      https.request = mockRequest

      await botService._handleGoldenCoupon('test-chat-id')

      expect(mockRequest).toHaveBeenCalled()
      const parsedBody = JSON.parse(mockReq.write.mock.calls[0][0])
      expect(parsedBody.text).toContain('GOLDEN COUPON')

      https.request = originalRequest
      botService.token = origToken
      botService.chatId = origChatId
    })
  })
})
