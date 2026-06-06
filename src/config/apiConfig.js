import { Capacitor } from '@capacitor/core';

// Detect platform and environment
const isNative = Capacitor.isNativePlatform();

const PRODUCTION_API_URL = 'https://prono-k6gc.onrender.com';

// API Base URL Configuration
// Detect local dev: if serving from localhost, use same-origin (no prefix)
// Otherwise use Render API unless VITE_API_URL is explicitly set.
const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const API_BASE_URL = isLocalhost ? '' : (import.meta.env.VITE_API_URL || PRODUCTION_API_URL);

export const getApiUrl = (endpoint) => {
    return `${API_BASE_URL}${endpoint}`;
};

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
        backtest: (strategy) => `/api/backtest?strategy=${strategy}`
    }
};

export default config;
