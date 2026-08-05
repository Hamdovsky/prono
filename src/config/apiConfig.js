// Detect if running inside a native mobile app container (Capacitor/Cordova)
const isNative =
  typeof window !== 'undefined' &&
  (!!window.Capacitor ||
    window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'http-extension:')

const PRODUCTION_API_URL = 'https://pronostico.onrender.com'

// API Base URL Configuration
// If running natively (Capacitor), use the production API URL.
// Otherwise use same-origin (empty prefix) for all browser deployments.
const isLocalhost =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
const API_BASE_URL = isNative
  ? import.meta.env.VITE_API_URL || PRODUCTION_API_URL
  : import.meta.env.VITE_API_URL || ''

export const getApiUrl = (endpoint) => {
  return `${API_BASE_URL}${endpoint}`
}

export const config = {
  apiBaseUrl: API_BASE_URL,
  isNative,
  endpoints: {
    live: '/api/live',
    combos: '/api/combos',
    config: '/api/config',
    patterns: '/api/patterns',
    health: '/api/health',
    stats: (matchId) => `/api/stats/${matchId}`,
    backtest: (strategy) => `/api/backtest?strategy=${strategy}`,
  },
}

export default config
