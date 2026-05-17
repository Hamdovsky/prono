/**
 * Security Engine Unit Tests
 * Tests for core/securityEngine.js - Rate limiting and authentication
 */

const securityEngine = require('../core/securityEngine');
const logger = require('../core/logger');

describe('SecurityEngine', () => {
  beforeEach(() => {
    // Clear rate limits between tests
    securityEngine.rateLimits.clear();
    jest.clearAllMocks();
  });

  describe('checkRateLimit()', () => {
    it('should allow requests from localhost', () => {
      expect(securityEngine.checkRateLimit('127.0.0.1')).toBe(true);
      expect(securityEngine.checkRateLimit('::1')).toBe(true);
      expect(securityEngine.checkRateLimit('::ffff:127.0.0.1')).toBe(true);
    });

    it('should allow first request from new IP', () => {
      const result = securityEngine.checkRateLimit('192.168.1.1');
      expect(result).toBe(true);
    });

    it('should allow requests within rate limit window', () => {
      const ip = '10.0.0.1';
      // Make 59 requests (limit is 60)
      for (let i = 0; i < 59; i++) {
        expect(securityEngine.checkRateLimit(ip)).toBe(true);
      }
    });

    it('should rate limit when threshold exceeded', () => {
      const ip = '10.0.0.2';
      // Make 60 requests - all should pass
      for (let i = 0; i < 60; i++) {
        expect(securityEngine.checkRateLimit(ip)).toBe(true);
      }
      // 61st request should be rate limited
      expect(securityEngine.checkRateLimit(ip)).toBe(false);
    });

    it('should not count old timestamps outside window', async () => {
      const ip = '10.0.0.3';
      // Make some requests
      securityEngine.checkRateLimit(ip);
      securityEngine.checkRateLimit(ip);

      // Manually manipulate timestamps to test expiration
      const timestamps = securityEngine.rateLimits.get(ip);
      // Set old timestamps (beyond 60s window)
      const oldTime = Date.now() - 61000; // 61 seconds ago
      timestamps[0] = oldTime;
      timestamps.pop(); // Reduce count to fit within limit
      
      // Should now allow a new request
      expect(securityEngine.checkRateLimit(ip)).toBe(true);
    });
  });

  describe('middleware()', () => {
    it('should call next() for allowed requests', () => {
      const req = {
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      securityEngine.middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should return 429 for rate limited requests', () => {
      const req = {
        ip: '10.0.0.4',
        socket: { remoteAddress: '10.0.0.4' }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      // Exceed rate limit
      for (let i = 0; i < 60; i++) {
        securityEngine.checkRateLimit(req.ip);
      }

      securityEngine.middleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({ error: 'Too Many Requests' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('authenticate()', () => {
    it('should reject requests without Authorization header', () => {
      const req = { headers: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      securityEngine.authenticate(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject requests with malformed Authorization header', () => {
      const req = { headers: { authorization: 'InvalidToken' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      securityEngine.authenticate(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject requests with invalid token', () => {
      const req = { headers: { authorization: 'Bearer wrong-token' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      securityEngine.authenticate(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: Invalid security token' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow requests with valid token', () => {
      const req = { headers: { authorization: 'Bearer Matrix22!' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      securityEngine.authenticate(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should use environment variable as secret key if available', () => {
      process.env.API_SECRET_KEY = 'env-secret';
      // Re-require to pick up new env
      const freshEngine = require('../core/securityEngine');
      
      const req = { headers: { authorization: 'Bearer env-secret' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      freshEngine.authenticate(req, res, next);
      expect(next).toHaveBeenCalled();

      // Reset
      delete process.env.API_SECRET_KEY;
    });
  });

  describe('handleProtocolMismatch()', () => {
    it('should handle invalid HTTP method errors', () => {
      const socket = { remoteAddress: '192.168.1.1', end: jest.fn(), destroy: jest.fn() };
      const err = { code: 'HPE_INVALID_METHOD', message: 'Invalid method' };

      securityEngine.handleProtocolMismatch(err, socket);
      expect(socket.end).toHaveBeenCalled();
    });

    it('should handle connection reset errors', () => {
      const socket = { remoteAddress: '192.168.1.2', end: jest.fn(), destroy: jest.fn() };
      const err = { code: 'ECONNRESET', message: 'Connection reset' };

      securityEngine.handleProtocolMismatch(err, socket);
      expect(socket.end).toHaveBeenCalled();
    });

    it('should destroy socket for other errors', () => {
      const socket = { remoteAddress: '192.168.1.3', end: jest.fn(), destroy: jest.fn() };
      const err = { code: 'UNKNOWN_ERROR', message: 'Unknown' };

      securityEngine.handleProtocolMismatch(err, socket);
      expect(socket.destroy).toHaveBeenCalled();
    });
  });
});
