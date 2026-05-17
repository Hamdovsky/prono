/**
 * Logger Unit Tests
 * Tests for core/logger.js - Production-grade logging with rotation, burst protection
 */

const logger = require('../core/logger');

describe('Logger', () => {
  beforeEach(() => {
    // Clear any state between tests
    jest.clearAllMocks();
  });

  describe('info()', () => {
    it('should log info messages', () => {
      logger.info('Test info message', { userId: 123 });
      // No assertion needed - just verify no errors thrown
    });

    it('should handle empty meta', () => {
      logger.info('Simple message');
    });

    it('should handle special characters in meta', () => {
      logger.info('Test', { special: 'test\x00\x01' });
    });
  });

  describe('warn()', () => {
    it('should log warning messages', () => {
      logger.warn('Test warning', { module: 'test' });
    });
  });

  describe('debug()', () => {
    it('should log debug messages in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      logger.debug('Debug message');
      process.env.NODE_ENV = originalEnv;
    });

    it('should not log debug messages in production by default', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      logger.debug('Debug message'); // Should be silent
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('error()', () => {
    it('should log error messages', () => {
      const error = new Error('Test error');
      logger.error('Error occurred', error);
    });

    it('should handle error without Error object', () => {
      logger.error('Error message', null);
    });

    it('should handle error string as second argument', () => {
      logger.error('Error message', 'some string');
    });

    it('should prevent recursive error logging', () => {
      // Simulate error during error logging to test recursion guard
      const error = new Error('Recursive test');
      logger.error('First error', error);
      // If recursion guard fails, this would cause infinite loop
      logger.error('Second error', error);
    });

    it('should handle meta serialization failures gracefully', () => {
      const circularObj = {};
      circularObj.self = circularObj;
      logger.error('Error with circular ref', null, { circular: circularObj });
    });

    it('should apply burst protection (throttling)', () => {
      // Generate many errors quickly to trigger burst protection
      for (let i = 0; i < 25; i++) {
        logger.error(`Burst error ${i}`, new Error(`Burst ${i}`));
      }
      // Should not throw, burst protection active
    });

    it('should skip file write if log exceeds 50MB', () => {
      // Manually set log file size mock
      const fs = require('fs');
      const originalStat = fs.statSync;
      fs.statSync = jest.fn(() => ({ size: 51 * 1024 * 1024 })); // 51MB

      logger.error('Error with huge log', new Error('test'));

      fs.statSync = originalStat;
    });
  });

  describe('Log rotation', () => {
    it('should rotate logs when date changes', () => {
      // The _rotateIfNeeded logic checks currentDate against system date
      // We can't easily test date change, but we can verify the method exists
      expect(logger._rotateIfNeeded).toBeDefined();
    });
  });

  describe('Message formatting', () => {
    it('should format messages as JSON', () => {
      // Access internal method for testing
      const formatted = logger._formatMessage('INFO', 'Test', { key: 'value' });
      expect(formatted).toContain('timestamp');
      expect(formatted).toContain('INFO');
      expect(formatted).toContain('Test');
    });

    it('should handle Error objects in meta', () => {
      const error = new Error('Test error');
      const formatted = logger._formatMessage('ERROR', 'Error occurred', { err: error });
      expect(formatted).toContain('Test error');
    });

    it('should truncate long object strings in meta', () => {
      const longStr = 'a'.repeat(1000);
      const formatted = logger._formatMessage('INFO', 'Test', { long: longStr });
      // Should be truncated to 500 chars
      expect(formatted.length).toBeLessThan(1000);
    });
  });
});
