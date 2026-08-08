const { execSync } = require('child_process')
const fs = require('fs')

let _cache = null

function resolvePython() {
  if (_cache) return _cache
  if (process.env.PYTHON_PATH) {
    _cache = process.env.PYTHON_PATH
    return _cache
  }
  if (process.platform === 'win32') {
    try {
      const result = execSync('where python', { encoding: 'utf8', timeout: 3000, windowsHide: true })
        .split(/\r?\n/)[0]
        .trim()
      if (result) {
        _cache = result
        return _cache
      }
    } catch (_) {}
    const candidates = [
      'C:\\Users\\HAMDI\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      'C:\\Users\\HAMDI\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python313\\python.exe',
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        _cache = p
        return _cache
      }
    }
  }
  try {
    execSync('python3 --version', { stdio: 'ignore', timeout: 3000 })
    _cache = 'python3'
    return _cache
  } catch (_) {
    try {
      const whichResult = execSync('which python3', { encoding: 'utf8', timeout: 5000 })
        .trim()
        .split(/\r?\n/)[0]
        .trim()
      if (whichResult) {
        _cache = whichResult
        return _cache
      }
    } catch (_) {}
    try {
      const whichResult = execSync('which python', { encoding: 'utf8', timeout: 5000 })
        .trim()
        .split(/\r?\n/)[0]
        .trim()
      if (whichResult) {
        _cache = whichResult
        return _cache
      }
    } catch (_) {}
    try {
      execSync('python --version', { stdio: 'ignore', timeout: 3000 })
      _cache = 'python'
      return _cache
    } catch (_) {}
  }
  _cache = 'python'
  return _cache
}

module.exports = {
  resolvePython,
  get python() {
    return resolvePython()
  },
}
