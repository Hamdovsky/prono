// Jest setupFiles entry — MUST run before any test file is required.
// Sets STITCH_CONFIG_FILE so core/configEngine.js reads/writes an isolated temp
// config instead of the production data/config.json. configEngine.save() uses the
// real fs.promises (setup.js only mocks sync fs methods), so without this the
// configEngine tests would physically rewrite data/config.json.
// Registered in jest.config.js `setupFiles` (NOT setupFilesAfterEnv, which runs
// too late for top-of-file requires).
const os = require('os')
const path = require('path')
const fs = require('fs')

// Directory name contains "data" so setup.js's mocked fs.existsSync returns true.
const cfgDir = path.join(os.tmpdir(), 'stitch-test-data')
fs.mkdirSync(cfgDir, { recursive: true })

// Unique per worker process to avoid cross-worker file contention.
process.env.STITCH_CONFIG_FILE = path.join(cfgDir, `config-${process.pid}.json`)
