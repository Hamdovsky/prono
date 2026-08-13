// Jest setupFiles entry — MUST run before any test file is required.
// Sets SQLITE_DB_PATH so core/database.js opens an isolated temp DB instead of
// the production data/tactical.db. Registered in jest.config.js `setupFiles`
// (NOT setupFilesAfterEnv, which would run too late for top-of-file requires).
const os = require('os')
const path = require('path')
const fs = require('fs')

// NOTE on ordering: this module runs via jest.config `setupFiles`, i.e. BEFORE
// __tests__/setup.js (setupFilesAfterEnv) installs the global `fs` mock. So the
// real `fs` is available here to physically create the temp directory.
//
// The directory name intentionally contains "data" so that setup.js's mocked
// `fs.existsSync` returns true for it. If it didn't, better-sqlite3's own JS
// wrapper (which requires the mocked `fs`) would see the parent as missing and
// throw "Cannot open database because the directory does not exist".
const dbDir = path.join(os.tmpdir(), 'stitch-test-data')
fs.mkdirSync(dbDir, { recursive: true })

// Unique per worker process to avoid cross-worker file contention.
process.env.SQLITE_DB_PATH = path.join(dbDir, `tactical-${process.pid}.db`)
