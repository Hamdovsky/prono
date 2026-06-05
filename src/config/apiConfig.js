import { Capacitor } from '@capacitor/core';

// Detect platform and environment
const isNative = Capacitor.isNativePlatform();

const PRODUCTION_API_URL = 'https://prono-l5e3.onrender.com';

// API Base URL Configuration
// Keep every client on the Render API unless VITE_API_URL is explicitly set.
const API_BASE_URL = import.meta.env.VITE_API_URL || PRODUCTION_API_URL;

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
