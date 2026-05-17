/**
 * Bot Service Unit Tests
 * Tests for services/botService.js - Telegram bot commands and alerts
 */

const botService = require('../services/botService');
const https = require('https');

describe('BotService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('startPolling()', () => {
    it('should not start polling if token is missing', () => {
      const originalToken = process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;

      botService.startPolling();
      // Should log warning and return, no polling started
      expect(botService.isPolling).toBeUndefined();

      process.env.TELEGRAM_BOT_TOKEN = originalToken;
    });

    it('should not start polling if chatId is missing', () => {
      const originalToken = process.env.TELEGRAM_BOT_TOKEN;
      const originalChatId = process.env.TELEGRAM_CHAT_ID;
      process.env.TELEGRAM_BOT_TOKEN = 'token';
      delete process.env.TELEGRAM_CHAT_ID;

      botService.startPolling();
      expect(botService.isPolling).toBeUndefined();

      process.env.TELEGRAM_BOT_TOKEN = originalToken;
      process.env.TELEGRAM_CHAT_ID = originalChatId;
    });

    it('should start polling with valid credentials', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = 'test-chat';

      botService.startPolling();
      
      expect(botService.isPolling).toBe(true);
      expect(botService.lastUpdateId).toBe(0);
    });

    it('should not start multiple polling instances', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = 'test-chat';

      botService.startPolling();
      const firstId = botService.lastUpdateId;
      
      // Call startPolling again - should not reset
      botService.startPolling();
      expect(botService.lastUpdateId).toBe(firstId);
    });
  });

  describe('_executeSend()', () => {
    it('should send message to Telegram API', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = 'test-chat';

      const originalRequest = https.request;
      const mockRequest = jest.fn().mockImplementation((url, options, callback) => {
        const res = { statusCode: 200, on: (event, handler) => {
          if (event === 'data') handler(Buffer.from('{"ok":true}'));
        }};
        setTimeout(() => callback(res), 0);
        return { write: jest.fn(), end: jest.fn(), on: jest.fn() };
      });

      https.request = mockRequest;

      botService._executeSend('Test message', 'test-chat-id');

      expect(mockRequest).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' })
        }),
        expect.any(Function)
      );

      https.request = originalRequest;
    });

    it('should handle keyboard markup', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = 'test-chat';

      const originalRequest = https.request;
      const mockRequest = jest.fn().mockImplementation(() => ({
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn()
      }));

      https.request = mockRequest;

      const keyboard = { inline_keyboard: [[{ text: 'Test', url: 'https://test.com' }]] };
      botService._executeSend('Test', 'chat-id', keyboard);

      expect(mockRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' })
        }),
        expect.any(Function)
      );

      const callArgs = mockRequest.mock.calls[0];
      const parsedBody = JSON.parse(callArgs[0].write.mock.calls[0][0]);
      expect(parsedBody.reply_markup).toEqual(keyboard);

      https.request = originalRequest;
    });

    it('should log errors on failed Telegram request', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = 'test-chat';

      const originalRequest = https.request;
      const mockRequest = jest.fn().mockImplementation(() => ({
        write: jest.fn(),
        end: jest.fn(),
        on: (event, handler) => {
          if (event === 'error') handler(new Error('Network error'));
        }
      }));

      https.request = mockRequest;
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      botService._executeSend('Test message');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Telegram Alert Failed:', expect.any(String));

      consoleErrorSpy.mockRestore();
      https.request = originalRequest;
    });
  });

  describe('sendAlert()', () => {
    it('should send system alert with proper formatting', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = 'test-chat';

      const originalRequest = https.request;
      const mockRequest = jest.fn().mockImplementation(() => ({
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn()
      }));

      https.request = mockRequest;

      botService.sendAlert('Server overload detected');

      const callArgs = mockRequest.mock.calls[0];
      const parsedBody = JSON.parse(callArgs[0].write.mock.calls[0][0]);
      expect(parsedBody.text).toContain('SYSTEM ALERT');
      expect(parsedBody.text).toContain('Server overload detected');

      https.request = originalRequest;
    });
  });

  describe('broadcastMatch()', () => {
    it('should broadcast high-value matches', () => {
      botService.alertedMatchIds.clear();

      const match = {
        id: 'high-value-match',
        enriched: { winnerProbability: 0.75 },
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        league: 'Test League',
        time: '20:00'
      };

      botService.broadcastMatch(match);

      expect(botService.alertedMatchIds.has(match.id)).toBe(true);
    });

    it('should not broadcast low-value matches', () => {
      botService.alertedMatchIds.clear();

      const match = {
        id: 'low-value-match',
        enriched: { winnerProbability: 0.55 }, // Below threshold
        homeTeam: 'Team C',
        awayTeam: 'Team D'
      };

      botService.broadcastMatch(match);

      expect(botService.alertedMatchIds.has(match.id)).toBe(false);
    });

    it('should not re-broadcast already alerted matches', () => {
      botService.alertedMatchIds.clear();
      const matchId = 'already-alerted';

      botService.broadcastMatch({ id: matchId, enriched: { winnerProbability: 0.8 } });
      botService.broadcastMatch({ id: matchId, enriched: { winnerProbability: 0.9 } }); // Second call

      expect(botService.alertedMatchIds.size).toBe(1);
    });
  });

  describe('reset()', () => {
    it('should clear alerted match IDs', () => {
      botService.alertedMatchIds.add('match-1');
      botService.alertedMatchIds.add('match-2');
      botService.alertedComboIds.add('combo-1');

      botService.reset();

      expect(botService.alertedMatchIds.size).toBe(0);
      expect(botService.alertedComboIds.size).toBe(0);
    });
  });

  describe('Command handlers', () => {
    it('_handleGoldenCoupon should send formatted message', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = 'test-chat';

      const originalRequest = https.request;
      const mockRequest = jest.fn().mockImplementation(() => ({
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn()
      }));

      https.request = mockRequest;

      await botService._handleGoldenCoupon('test-chat-id');

      expect(mockRequest).toHaveBeenCalled();
      const callArgs = mockRequest.mock.calls[0];
      const parsedBody = JSON.parse(callArgs[0].write.mock.calls[0][0]);
      expect(parsedBody.text).toContain('GOLDEN COUPON');

      https.request = originalRequest;
    });

    // Additional command handler tests can be added similarly
  });
});
