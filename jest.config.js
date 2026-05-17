module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'core/**/*.js',
    'services/**/*.js',
    'routes/**/*.js',
    '!**/*.test.js',
    '!**/node_modules/**',
    '!**/SofascoreScraping/**'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },
  testMatch: [
    '**/__tests__/**/*.test.js'
  ],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  testTimeout: 30000,
  maxWorkers: 2,
  modulePathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/SofascoreScraping/'],
  verbose: true
};
