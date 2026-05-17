const http = require('http');
const https = require('https');

/**
 * [STITCH NETWORK INFRASTRUCTURE]
 * Centralized agent pooling to prevent WinError 10055 (Socket Exhaustion).
 * 
 * Performance Tuning for Windows:
 * - keepAlive: true (reuse sockets)
 * - maxSockets: 64 (limited to prevent saturating proxy/system)
 * - maxFreeSockets: 16
 * - timeout: 30000
 */

const options = {
    keepAlive: true,
    maxSockets: 64,
    maxFreeSockets: 16,
    timeout: 30000,
    scheduling: 'fifo'
};

const httpAgent = new http.Agent(options);
const httpsAgent = new https.Agent(options);

/**
 * --- Undici Support (High Performance Fetch) ---
 * Note: undici is required for modern fetch dispatchers.
 * We'll lazy-load it to avoid breaking processes that don't have it.
 */
let undiciAgent = null;

function getUndiciAgent() {
    if (undiciAgent) return undiciAgent;
    try {
        const { Agent } = require('undici');
        undiciAgent = new Agent({
            keepAliveTimeout: 10000,
            keepAliveMaxTimeout: 30000,
            connections: 64,
            pipelining: 1
        });
        return undiciAgent;
    } catch (e) {
        return null;
    }
}

/**
 * Returns the correct agent based on the URL protocol
 */
function getAgent(url) {
    if (!url) return httpsAgent;
    return url.startsWith('https') ? httpsAgent : httpAgent;
}

/**
 * Base Axios config using pooled agents
 */
const pooledConfig = {
    httpAgent,
    httpsAgent,
    timeout: 10000,
    maxSockets: 64,
    maxFreeSockets: 16,
    retries: 3,
    retryDelay: 1000,
    keepAlive: true,
    scheduling: 'fifo'
};

module.exports = {
    httpAgent,
    httpsAgent,
    getUndiciAgent,
    getAgent,
    pooledConfig
};
