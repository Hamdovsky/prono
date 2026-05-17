const logger = require('./logger');

class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'circuit';
    this.timeout = options.timeout || 10000;
    this.errorThreshold = options.errorThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.successThreshold = options.successThreshold || 2;
    
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    this.lastFailureTime = null;
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        const err = new Error(`Circuit breaker "${this.name}" is OPEN`);
        err.circuitBreaker = true;
        throw err;
      }
      this.state = 'HALF_OPEN';
      logger.warn(`[CIRCUIT] ${this.name} -> HALF_OPEN (testing)`);
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Circuit breaker "${this.name}" timeout after ${this.timeout}ms`)), this.timeout)
        )
      ]);
      return this.success(result);
    } catch (err) {
      return this.fail(err);
    }
  }

  success(result) {
    this.failures = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.close();
      }
    }
    
    return result;
  }

  fail(err) {
    this.failures++;
    this.successes = 0;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.errorThreshold) {
      this.open();
    }

    const error = new Error(`Circuit breaker "${this.name}" failed: ${err.message}`);
    error.circuitBreaker = true;
    error.originalError = err;
    throw error;
  }

  open() {
    this.state = 'OPEN';
    this.nextAttempt = Date.now() + this.resetTimeout;
    logger.error(`[CIRCUIT] ${this.name} -> OPEN (failures: ${this.failures}, reset in ${this.resetTimeout}ms)`);
  }

  close() {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    logger.info(`[CIRCUIT] ${this.name} -> CLOSED`);
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      nextAttempt: this.nextAttempt,
      lastFailureTime: this.lastFailureTime
    };
  }
}

module.exports = CircuitBreaker;

// Create named breakers for critical services
const sofacoreBreaker = new CircuitBreaker({
  name: 'sofacore-api',
  timeout: 10000,
  errorThreshold: 5,
  resetTimeout: 30000
});

const redisBreaker = new CircuitBreaker({
  name: 'redis',
  timeout: 5000,
  errorThreshold: 5,
  resetTimeout: 15000
});

const telegramBreaker = new CircuitBreaker({
  name: 'telegram-bot',
  timeout: 5000,
  errorThreshold: 10,
  resetTimeout: 60000
});

const dbBreaker = new CircuitBreaker({
  name: 'database',
  timeout: 5000,
  errorThreshold: 5,
  resetTimeout: 10000
});

module.exports.breakers = {
  sofacore: sofacoreBreaker,
  redis: redisBreaker,
  telegram: telegramBreaker,
  database: dbBreaker
};