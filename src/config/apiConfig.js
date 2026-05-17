import { Capacitor } from '@capacitor/core';

// Detect platform and environment
const isNative = Capacitor.isNativePlatform();

// API Base URL Configuration
// IMPORTANT: For mobile testing, update the VITE_API_URL in your .env or replace the string below 
// with your current ngrok/serveo URL.
const API_BASE_URL = isNative || (typeof window !== 'undefined' && window.location.protocol === 'file:')
    ? (import.meta.env.VITE_API_URL || 'http://127.0.0.1:3001') // Fallback for mobile and file:// testing
    : ''; // Empty string allows relative paths (e.g. /api/live) correctly proxied by Vite

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
