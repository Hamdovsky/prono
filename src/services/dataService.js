/**
 * Data Service for Titanium Live Radar v3.0
 * Adaptive polling: 10s when live matches active, 60s when idle.
 * Handles fetching, normalization, and distribution of live match data.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getApiUrl } from '../config/apiConfig.js';
import { io } from 'socket.io-client';
import { normalizeTeamName, isReserveTeam, deduplicateMatches } from '../utils/teamNameNormalizer.js';

class DataService {
    _handleUpcomingUpdate(data) {
        if (Array.isArray(data)) {
            this.upcomingPredictions = data.map(m => this._normalizeMatch(m, 'upcoming')).filter(m => m !== null);
            this.upcomingSubscribers.forEach(cb => cb(this.upcomingPredictions));
        } else if (data && typeof data === 'object') {
            this.fetchUpcomingPredictions();
        }
    }

    constructor() {
        this.subscribers = [];
        this.comboSubscribers = [];
        this.healthSubscribers = [];
        this.upcomingSubscribers = [];
        this.statusSubscribers = []; // V33 Status Observer
        this.scraperStatusCache = null; // Cache for scraper progress
        this.healthCache = null; // Cache for health data


        this.matches = [];
        this.combos = [];
        this.upcomingPredictions = null;
        this.currentStatus = 'idle'; // 'idle' | 'loading' | 'error' | 'success'

        this.intervalId = null;
        this.apiEndpoint = getApiUrl('/api/live');
        this.comboApiEndpoint = getApiUrl('/api/combos');
        this.upcomingApiEndpoint = getApiUrl('/api/upcoming');
        this.promosportApiEndpoint = getApiUrl('/api/promosport');

        // Rate Limit State
        this.isRateLimited = false;
        this._notifiedMatches = new Set();
        this._requestNotificationPermission();

        // Adaptive polling state
        this._hasLiveMatches = false;
        // 🧠 [THROTTLING] Prevent request spamming (Point 4)
        this._lastFetch = new Map(); // Store last fetch times for each endpoint
        this._pendingRequests = new Map(); // Store active Promises for deduplication
        this._fetchCooldown = 10000; // 10s cooldown

        // 🔌 WebSocket Integration (ENABLED V3.0)
        this.socket = null;
        this._initSocket();

        // Method-level deduplication promises
        this._liveFetchPromise = null;
        this._upcomingFetchPromise = null;
    }

    _initSocket() {
        if (typeof window === 'undefined') return;

        try {
            this.socket = io(getApiUrl(''), {
                auth: { token: localStorage.getItem('admin_token') || '' },
                reconnection: true,
                reconnectionAttempts: 5
            });

            this.socket.on('connect', () => {
                console.log('🔌 [WS] Connected to Titanium Server');
                this.isRateLimited = false;
            });

            this.socket.on('matches_update', (data) => {
                this._handleMatchesUpdate(data);
            });

            this.socket.on('upcoming_update', (data) => {
                this._handleUpcomingUpdate(data);
            });

            this.socket.on('combos_update', (data) => {
                this.combos = data;
                this.comboSubscribers.forEach(cb => cb(this.combos));
            });

            this.socket.on('match_full_update', (data) => {
                this._handleMatchFullUpdate(data);
            });

            this.socket.on('match_patch_update', (data) => {
                this._handleMatchPatchUpdate(data);
            });

            this.socket.on('system_status', (data) => {
                this.healthSubscribers.forEach(cb => cb(data));
            });

            this.socket.on('connect_error', (err) => {
                console.warn('🔌 [WS] Connection Error:', err.message);
                // Fallback will continue via polling
            });

        } catch (e) {
            console.warn('Socket.io not available or failed to init. Using polling only.');
        }
    }

    _handleMatchesUpdate(raw) {
        if (Array.isArray(raw)) {
            const validMatches = raw
                .map(m => this._normalizeMatch(m, 'live'))
                .filter(m => m !== null);

            const uniqueMap = new Map();
            validMatches.forEach(m => uniqueMap.set(m.id, m));
            this.matches = Array.from(uniqueMap.values());

            this._hasLiveMatches = this.matches.some(m =>
                m.isLive || m.status === 'live' || (m.minute && m.minute.includes("'"))
            );

            this._checkEliteNotifications();
            this.subscribers.forEach(cb => cb(this.matches));
        }
    }

    _handleMatchFullUpdate(match) {
        const normalized = this._normalizeMatch(match);
        if (!normalized) return;

        const index = this.matches.findIndex(m => m.id === normalized.id);
        if (index !== -1) {
            this.matches[index] = normalized;
        } else {
            this.matches.push(normalized);
        }
        this._hasLiveMatches = this.matches.some(m => m.isLive || m.status === 'live');
        this.subscribers.forEach(cb => cb(this.matches));
    }

    _handleMatchPatchUpdate({ id, patch }) {
        const match = this.matches.find(m => m.id === id);
        if (!match) {
            // If we don't have the match locally, the patch is useless until the next full update
            return;
        }

        try {
            // 📉 Apply JSON Patch (Minimal naive implementation for speed)
            // In a pro app, we'd use fast-json-patch, but a flat merge is often safer for soccer stats
            patch.forEach(op => {
                if (op.op === 'replace' || op.op === 'add') {
                    const path = op.path.split('/').filter(Boolean);
                    let current = match;
                    for (let i = 0; i < path.length - 1; i++) {
                        if (!current[path[i]]) current[path[i]] = {};
                        current = current[path[i]];
                    }
                    current[path[path.length - 1]] = op.value;
                }
            });

            // Re-normalize after patch to refresh winProb etc.
            const updated = this._normalizeMatch(match);
            const index = this.matches.findIndex(m => m.id === id);
            this.matches[index] = updated;

            this._checkEliteNotifications();
            this.subscribers.forEach(cb => cb(this.matches));
        } catch (e) {
            console.warn('❌ [WS] Failed to apply patch:', e);
        }
    }

    async _get(url) {
        // [THROTTLING] logic (Point 4)
        const now = Date.now();
        const lastFetchTime = this._lastFetch.get(url) || 0;
        
        if (now - lastFetchTime < this._fetchCooldown) {
            // console.log(`🛡️ [THROTTLER] Suppressing redundant fetch for: ${url} (Cooldown active)`);
            // Attempt to return currently held data based on URL
            if (url.includes('/api/upcoming')) return this.upcomingPredictions || [];
            if (url.includes('/api/combos')) return this.combos;
            if (url.includes('/api/live')) return this.matches;
            if (url.includes('/api/health')) return this.healthCache;
            if (url.includes('/api/scraper/status')) return this.scraperStatusCache;
        }

        // 🚀 [DEDUPLICATION] Return existing promise if request is already in flight
        if (this._pendingRequests.has(url)) {
            console.log(`🚀 [DEDUPLICATOR] Joining existing request for: ${url}`);
            return this._pendingRequests.get(url);
        }

        const fetchPromise = (async () => {
            try {
                if (Capacitor.isNativePlatform()) {
                    const options = { url };
                    const response = await CapacitorHttp.get(options);
                    if (response.status === 429) {
                        this._handleRateLimit();
                        throw new Error('Rate Limit Active');
                    }
                    this.isRateLimited = false;
                    return response.data;
                } else {
                    const startTime = Date.now();
                    // console.log(`⏱️ [FETCHER] Starting fetch: ${url}`);
                    const response = await fetch(url);
                    const fetchTime = Date.now() - startTime;
                    
                    if (response.status === 429) {
                        this._handleRateLimit();
                        throw new Error('Rate Limit Active');
                    }
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    
                    this.isRateLimited = false;
                    const data = await response.json();
                    this._lastFetch.set(url, Date.now());
                    
                    // Update specific caches
                    if (url.includes('/api/scraper/status')) this.scraperStatusCache = data;
                    if (url.includes('/api/health')) this.healthCache = data;

                    console.log(`✅ [FETCHER] Parse complete for ${url} (${Date.now() - (startTime + fetchTime)}ms)`);
                    return data;
                }
            } finally {
                this._pendingRequests.delete(url);
            }
        })();

        this._pendingRequests.set(url, fetchPromise);
        return fetchPromise;
    }

    _handleRateLimit() {
        if (!this.isRateLimited) {
            this.isRateLimited = true;
            console.warn('⚠️ API Rate Limit Triggered. Pausing updates...');
            this.subscribers.forEach(cb => cb({ error: 'RATE_LIMIT', message: 'Rate Limit Active. Retrying...' }));
        }
    }

    // Helper to handle both Web and Native HTTP (POST)
    async _post(url, body) {
        const token = localStorage.getItem('admin_token') || 'Matrix22!';
        if (Capacitor.isNativePlatform()) {
            const options = {
                url,
                data: body,
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            };
            const response = await CapacitorHttp.post(options);
            return response.data;
        } else {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(body)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        }
    }

    // Proactive normalization to ensure UI stability
    // mode: 'live' (strict 7-day window) | 'upcoming' (60-day future window)
    _normalizeMatch(match, mode = 'live') {
        if (!match) return null;

        // 1. Filter Debug Data
        if (this._isDebugMatch(match)) return null;
        
        // ✅ FILTRE EQUIPES RESERVES / JEUNES
        const home = match.homeTeam || '';
        const away = match.awayTeam || '';
        if (isReserveTeam(home) || isReserveTeam(away)) return null;

        // 2. Filter Invalid Date
        if (match.time === 'Invalid Date' || match.startTime === 'Invalid Date') return null;

        // 3. SANITY CHECK: Timestamp Age
        let rawTs = match.startTimestamp || match.timestamp || match.startTime;
        let tsMs = 0;
        if (typeof rawTs === 'string' && rawTs.includes('T')) {
            tsMs = new Date(rawTs).getTime();
        } else {
            tsMs = parseInt(rawTs) > 1e11 ? parseInt(rawTs) : (parseInt(rawTs) * 1000);
        }

        const now = Date.now();
        const sevenDays  = 7  * 24 * 60 * 60 * 1000;
        const sixtyDays  = 60 * 24 * 60 * 60 * 1000;
        // Live feed: reject anything outside ±7 days (likely stale/fake).
        // Upcoming feed: allow up to 60 days in the future (scheduled predictions).
        const futureWindow = mode === 'upcoming' ? sixtyDays : sevenDays;
        const pastWindow = 100 * 24 * 60 * 60 * 1000; // 100 Days

        if (tsMs && (tsMs < now - pastWindow || tsMs > now + futureWindow)) {
            console.warn(`🚫 [SANITY] Rejecting match with invalid date range: ${match.homeTeam} vs ${match.awayTeam} (${new Date(tsMs).toLocaleDateString()})`);
            return null;
        }

        // 🧠 [TIMESTAMP FIX] Handle UNIX seconds or ISO strings
        let ts = tsMs ? Math.floor(tsMs / 1000) : 0;

        return {
            ...match,
            // Ensure unique ID is used
            id: match.id || match.matchId || `temp_${Date.now()}_${Math.random()}`,

            // Normalize Timestamp to UNIX Seconds
            startTimestamp: ts || 0,

            // Normalize Names
            // Normalize Names (Support camelCase, lowercase, and snake_case)
            league: this._normalizeName(match.league || match.league_name || match.leagueName || (typeof match.league === 'object' ? match.league.name : 'Unknown')),
            homeTeam: normalizeTeamName(match.homeTeam || match.hometeam || match.home_team || (typeof match.homeTeam === 'object' ? match.homeTeam.name : 'Home')),
            awayTeam: normalizeTeamName(match.awayTeam || match.awayteam || match.away_team || (typeof match.awayTeam === 'object' ? match.awayTeam.name : 'Away')),
            homeTeamNormalized: normalizeTeamName(match.homeTeam || match.hometeam || match.home_team),
            awayTeamNormalized: normalizeTeamName(match.awayTeam || match.awayteam || match.away_team),

            // Guard against null/array/object prediction values
            prediction: (() => {
                const p = match.prediction;
                if (!p) return null;
                if (typeof p === 'string') return p;
                if (Array.isArray(p)) return p.length > 0 ? (p[0]?.label || p[0]?.name || JSON.stringify(p[0])) : null;
                if (typeof p === 'object') return p.label || p.name || JSON.stringify(p);
                return String(p);
            })(),

            // Ensure stats is always an array (scraper sometimes returns an object)
            stats: Array.isArray(match.stats) ? match.stats : (match.stats ? [match.stats] : []),

            // 🧠 [NORMALIZATION] Ensure winProb exists for Dashboard filtering
            winProb: parseFloat(match.winProb || (match.enriched ? match.enriched.winnerProbability * 100 : match.confidence) || 0) || 0,
            confidence: parseFloat(match.confidence || (match.enriched ? match.enriched.winnerProbability * 100 : match.winProb) || 50) || 50,
            isVVIP: match.isVVIP || false,
            isStale: match.isStale || false,
            tacticalLabels: match.tacticalLabels || [],

            // Preserve Metadata for strict grouping
            tournament_id: match.tournament_id,
            category_name: match.category_name,
            category_id: match.category_id,
            country_iso: match.category_flag || match.country_iso,
            category_flag: match.category_flag,

            // 🌍 Country — derive from multiple sources for wide compatibility
            country: match.country || match.category || match.category_name || null,

            // DEBUG: Log if enrichment data exists
            _hasEnrichment: !!(match.home_win_probability || match.enriched || match.verdict)
        };
    }

    _normalizeName(name) {
        if (!name) return '';
        
        let n = String(name).trim();

        // 1. Remove common sponsors/prefixes
        const sponsorRegex = /(Barclays|McDonald's|McDonald’s|Enilive|Betclic|EA Sports|Bwin|Sky Bet)\s+/gi;
        n = n.replace(sponsorRegex, '');

        // 2. Map known variations to clean names
        const NORMALIZATION_MAP = {
            'England - Premier League': 'Premier League',
            'English Premier League': 'Premier League',
            'Egypt - Premier League': 'Egypt Premier',
            'South Africa - Premier': 'SA Premier',
            'Ligue 1': 'Ligue 1',
            'Ligue 2': 'Ligue 2',
            'Championship': 'Championship',
            'Serie A': 'Serie A',
            'Serie B': 'Serie B',
            'LaLiga': 'LaLiga',
            'La Liga': 'LaLiga',
            'Bundesliga': 'Bundesliga',
            '2. Bundesliga': '2. Bundesliga',
            'Süper Lig': 'Süper Lig',
            'Eredivisie': 'Eredivisie',
            'Liga Portugal': 'Liga Portugal',
            'Saudi Pro League': 'Saudi Pro League',
            'Botola Pro': 'Botola Pro',
            'A-League': 'A-League',
            'Brasileirao': 'Brasileirao',
            'MLS': 'MLS',
            'Champions League': 'Champions League',
            'Europa League': 'Europa League',
        };

        const lowerN = n.toLowerCase();
        // 🚀 [STRICT MATCH] Check for exact or very specific matches first
        for (const [key, val] of Object.entries(NORMALIZATION_MAP)) {
            if (lowerN === key.toLowerCase() || (lowerN.startsWith(key.toLowerCase()) && n.length < key.length + 5)) {
                return val;
            }
        }

        // 3. Fallback: Safety clean but PRESERVE international characters (Arabic, accents, etc.)
        // We only remove control characters and excessive whitespace.
        return n
            .replace(/[\x00-\x1F\x7F-\x9F]/g, "") // Remove control characters
            .replace(/\s+/g, ' ')                // Normalize whitespace
            .trim();
    }

    _isDebugMatch(match) {
        const home = match.homeTeam || '';
        const away = match.awayTeam || '';
        const league = match.league || '';
        const combined = `${home} ${away} ${league}`.toLowerCase();

        // STRICT FILTERING: Exclude garbage data
        const keywords = [
            'debug', 'minor home', 'minor away', 'titanium debug',
            'test team', 'simulated', 'placeholder', 'fake match',
            'test match'
        ];

        // Also filter if names are just "Home" or "Away" (too generic)
        const lowerHome = home.toLowerCase();
        const lowerAway = away.toLowerCase();
        if (lowerHome === 'home' || lowerAway === 'away' || lowerHome === 'test' || lowerAway === 'test') return true;

        if (keywords.some(kw => combined.includes(kw))) return true;

        // Check for specific legacy/test patterns (e.g. Bayern vs Nürnberg appearing as "Today")
        if (lowerHome.includes('bayern') && lowerAway.includes('nürnberg')) return true;

        return false;
    }

    // --- Subscriptions ---
    subscribe(callback) {
        this.subscribers.push(callback);
        this.fetchLiveUpdates();
        return () => this.subscribers = this.subscribers.filter(sub => sub !== callback);
    }

    subscribeCombos(callback) {
        this.comboSubscribers.push(callback);
        this.fetchCombos();
        return () => this.comboSubscribers = this.comboSubscribers.filter(sub => sub !== callback);
    }

    subscribeUpcoming(callback) {
        this.upcomingSubscribers.push(callback);
        this.fetchUpcomingPredictions();
        return () => this.upcomingSubscribers = this.upcomingSubscribers.filter(sub => sub !== callback);
    }

    subscribeHealth(callback) {
        this.healthSubscribers.push(callback);
        this.fetchHealth();
        return () => this.healthSubscribers = this.healthSubscribers.filter(sub => sub !== callback);
    }

    // --- V33 Status Subscription ---
    subscribeStatus(callback) {
        this.statusSubscribers.push(callback);
        callback(this.currentStatus);
        return () => this.statusSubscribers = this.statusSubscribers.filter(sub => sub !== callback);
    }

    _notifyStatus(status) {
        this.currentStatus = status;
        this.statusSubscribers.forEach(cb => cb(status));
    }

    // --- Fetchers ---
    async fetchLiveUpdates() {
        if (this._liveFetchPromise) return this._liveFetchPromise;

        this._liveFetchPromise = (async () => {
            try {
                const raw = await this._get(this.apiEndpoint);
                // ... rest of logic moved into this async block ...


            if (Array.isArray(raw)) {
                // 1. Normalize & Filter (SAFE WRAPPER)
                const validMatches = raw
                    .map(m => {
                        try {
                            return this._normalizeMatch(m);
                        } catch (e) {
                            console.warn('❌ [NORMALIZER] Failed to normalize match:', m?.id || 'unknown', e);
                            return null;
                        }
                    })
                    .filter(m => m !== null);

                // 2. Visual Deduplication (Map by ID + Dédoublonnage par noms normalisés)
                const finalMatches = deduplicateMatches(validMatches);

                this.matches = finalMatches;

                // Track live match state for adaptive polling
                this._hasLiveMatches = this.matches.some(m =>
                    m.isLive || m.status === 'live' || (m.minute && m.minute.includes("'"))
                );

                // 🔔 Desktop notifications for 90%+ Elite Targets
                this._checkEliteNotifications();
            } else {
                this.matches = [];
                this._hasLiveMatches = false;
            }

            this.subscribers.forEach(cb => cb(this.matches));
        } catch (error) {
            console.error('Failed to fetch live updates:', error);
        } finally {
            this._liveFetchPromise = null;
        }
    })();
    return this._liveFetchPromise;
}


    async fetchCombos() {
        try {
            this.combos = await this._get(this.comboApiEndpoint);
            this.comboSubscribers.forEach(cb => cb(this.combos));
        } catch (error) {
            console.error('Failed to fetch combos:', error);
        }
    }

    async fetchUpcomingPredictions(force = false) {
        if (this._upcomingFetchPromise && !force) return this._upcomingFetchPromise;

        this._upcomingFetchPromise = (async () => {
            try {
                const endpoint = force ? `${this.upcomingApiEndpoint}?force=true` : this.upcomingApiEndpoint;
                console.log('📡 [DATA] Fetching upcoming matches from:', endpoint);
                const raw = await this._get(endpoint);

            console.log(`📊 [DATA] Received ${Array.isArray(raw) ? raw.length : 'non-array'} raw matches.`);
            
            this.upcomingPredictions = Array.isArray(raw)
                ? raw.map(m => {
                    try {
                        // Use 'upcoming' mode: allows matches up to 60 days in the future
                        return this._normalizeMatch(m, 'upcoming');
                    } catch (e) {
                        return null;
                    }
                }).filter(m => m !== null)
                : [];
            
            // ✅ Dédoublonnage aussi sur les matchs à venir
            this.upcomingPredictions = deduplicateMatches(this.upcomingPredictions);
            
            console.log(`✅ [DATA] Normalized ${this.upcomingPredictions.length} matches.`);
            
            this.upcomingSubscribers.forEach(cb => cb(this.upcomingPredictions));
        } catch (error) {
            console.error('❌ [DATA] Failed to fetch upcoming predictions:', error.message);
        } finally {
            this._upcomingFetchPromise = null;
        }
    })();
    return this._upcomingFetchPromise;
}


    async fetchPromosport() {
        try {
            return await this._get(this.promosportApiEndpoint);
        } catch (error) {
            console.error('❌ [DATA] Failed to fetch Promosport grid:', error.message);
            return null;
        }
    }

    async fetchHealth() {
        try {
            const health = await this._get(getApiUrl('/api/health'));
            this.healthSubscribers.forEach(sub => sub(health));
        } catch (error) {
            console.error('Failed to fetch health updates:', error);
        }
    }


    // --- Direct Calls ---
    async fetchMatchStats(id) {
        try {
            return await this._get(getApiUrl(`/api/stats/${id}`));
        } catch (error) {
            console.error('Failed to fetch match stats:', error);
            return null;
        }
    }

    async fetchPatterns() {
        try {
            return await this._get(getApiUrl('/api/patterns'));
        } catch (error) {
            console.error('Failed to fetch patterns:', error);
            return [];
        }
    }

    async runBacktest(strategy) {
        try {
            return await this._get(getApiUrl(`/api/backtest?strategy=${strategy}`));
        } catch (error) {
            console.error('Backtest failed:', error);
            return null;
        }
    }

    async deployConfig(config) {
        try {
            return await this._post(getApiUrl('/api/config'), config);
        } catch (error) {
            console.error('Config deployment failed:', error);
            throw error;
        }
    }

    async forceRefresh() {
        try {
            console.log('🔄 Triggering Manual Refresh (Live)...');
            return await this._post(getApiUrl('/api/refresh'), {});
        } catch (error) {
            console.error('Manual refresh failed:', error);
            throw error;
        }
    }

    async forceRefreshUpcoming() {
        try {
            await this.fetchUpcomingPredictions(true);
        } catch (error) {
            console.error('Upcoming refresh failed:', error);
            throw error;
        }
    }

    async triggerScanToday() {
        try {
            console.log('⚡ Triggering Sofascore Scan (Today)...');
            return await this._post(getApiUrl('/api/scan-today'), {});
        } catch (error) {
            console.error('Scan trigger failed:', error);
            throw error;
        }
    }

    async getScraperProgress() {
        try {
            return await this._get(getApiUrl('/api/scraper/status'));
        } catch (error) {
            console.error('Failed to fetch scraper progress:', error);
            return null;
        }
    }

    // ============================
    // 🔔 DESKTOP NOTIFICATION SYSTEM
    // ============================

    _requestNotificationPermission() {
        if (typeof window === 'undefined') return;
        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') {
            Notification.requestPermission().then(perm => {
                console.log(`🔔 Notification permission: ${perm}`);
            });
        }
    }

    _checkEliteNotifications() {
        const eliteTargets = this.matches.filter(m =>
            (m.winProb || 0) >= 90 && !this._notifiedMatches.has(m.id)
        );

        for (const target of eliteTargets) {
            this._notifiedMatches.add(target.id);
            this._fireNotification(target);
        }

        // Clean old entries (keep max 100)
        if (this._notifiedMatches.size > 100) {
            const arr = Array.from(this._notifiedMatches);
            this._notifiedMatches = new Set(arr.slice(-50));
        }
    }

    _fireNotification(match) {
        if (typeof window === 'undefined') return;
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;

        const homeTeam = typeof match.homeTeam === 'object' ? match.homeTeam.name : match.homeTeam;
        const awayTeam = typeof match.awayTeam === 'object' ? match.awayTeam.name : match.awayTeam;

        try {
            new Notification(`🔥 ELITE TARGET: ${match.winProb}%`, {
                body: `${homeTeam} vs ${awayTeam}\n${match.prediction || 'High Confidence'}`,
                icon: '/favicon.ico',
                tag: match.id,
                requireInteraction: true
            });
        } catch (e) { /* notification blocked */ }

        // 🔊 Optional audio alert
        try {
            const audio = new Audio('/alert.mp3');
            audio.volume = 0.3;
            audio.play().catch(() => { });
        } catch (e) { /* audio blocked */ }

        console.log(`🔔 [NOTIFICATION] Elite Target: ${homeTeam} vs ${awayTeam} @ ${match.winProb}%`);
    }

    // 10s when live matches are active, 60s when idle/scheduled only
    async refreshAllData() {
        this._notifyStatus('loading');
        try {
            await Promise.allSettled([
                this.fetchLiveUpdates(),
                this.fetchCombos(),
                this.fetchHealth(),
                this.fetchUpcomingPredictions()
            ]);
            this._notifyStatus('success');
        } catch (e) {
            this._notifyStatus('error');
        }
    }

    startAutoUpdate() {
        if (this.intervalId) return;

        // Initial fetch
        this.refreshAllData();

        const adaptivePoll = () => {
            // Don't poll if tab is hidden to save resources
            if (document.hidden) {
                this.intervalId = setTimeout(adaptivePoll, 30000);
                return;
            }

            this.refreshAllData();

            // 🎯 Adaptive: 10s for live action, 60s for idle/scheduled
            const nextInterval = this._hasLiveMatches ? 10000 : 60000;
            this.intervalId = setTimeout(adaptivePoll, nextInterval);
        };

        // Start adaptive loop after initial fetch
        this.intervalId = setTimeout(adaptivePoll, 10000);
    }

    stopAutoUpdate() {
        clearTimeout(this.intervalId);
        this.intervalId = null;
    }
}

const dataService = new DataService();
dataService.startAutoUpdate();

export default dataService;
