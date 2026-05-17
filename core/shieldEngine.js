const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const PROXY_FILE = path.join(__dirname, '../data/proxies.txt');

class ShieldEngine {
    constructor() {
        this.proxies = ['DIRECT'];
        this.healthyProxies = ['DIRECT'];
        this.currentIndex = 0;
        this.lastRotation = Date.now();
        this.systemHealth = {
            latency: 45,
            shieldActive: false,
            activeProxy: 'DIRECT',
            proxyCount: 1
        };

        this.init();
    }

    init() {
        this.loadProxies();
        // Watch for changes in proxies.txt
        if (fs.existsSync(PROXY_FILE)) {
            fs.watchFile(PROXY_FILE, () => {
                logger.info('🔄 [SHIELD] Proxies file changed. Reloading...');
                this.loadProxies();
            });
        }
        
        // Start background health checks every 15 minutes
        setInterval(() => this.checkProxyHealth(), 15 * 60 * 1000);
    }

    loadProxies() {
        try {
            const list = ['DIRECT'];
            if (fs.existsSync(PROXY_FILE)) {
                const content = fs.readFileSync(PROXY_FILE, 'utf8');
                const lines = content.split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !l.startsWith('#'));
                list.push(...lines);
            }
            this.proxies = list;
            this.healthyProxies = [...list]; // Initially assume all are healthy
            this.systemHealth.proxyCount = this.proxies.length;
            logger.info(`🛡️ [SHIELD] Loaded ${this.proxies.length} proxies (including DIRECT).`);
        } catch (e) {
            logger.error('❌ [SHIELD] Failed to load proxies:', e.message);
        }
    }

    async checkProxyHealth() {
        const axios = require('axios');
        const healthy = ['DIRECT'];
        
        for (const proxy of this.proxies) {
            if (proxy === 'DIRECT') continue;
            try {
                const config = { timeout: 5000 };
                if (proxy.startsWith('http')) {
                    const url = new URL(proxy);
                    config.proxy = {
                        host: url.hostname,
                        port: url.port,
                        auth: url.username ? { username: url.username, password: url.password } : undefined
                    };
                }

                await axios.get('https://www.google.com', config);
                healthy.push(proxy);
            } catch (e) {
                logger.warn(`⚠️ [SHIELD] Proxy ${proxy} failed health check. Removing from active rotation.`);
            }
        }
        
        this.healthyProxies = healthy;
        logger.info(`🛡️ [SHIELD] Health check complete. ${this.healthyProxies.length}/${this.proxies.length} proxies available.`);
    }

    updateStatus(latency) {
        this.systemHealth.latency = latency;
        
        // If latency is high (> 2000ms), force immediate rotation
        if (latency > 2000 && this.healthyProxies.length > 1) {
            this.rotateProxy('High Latency');
        } else if (latency < 500 && this.systemHealth.activeProxy !== 'DIRECT') {
            // Optional: revert to DIRECT if things are super fast
            // this.systemHealth.activeProxy = 'DIRECT';
        }
        return this.systemHealth;
    }

    rotateProxy(reason = 'Routine') {
        if (this.healthyProxies.length <= 1) return;
        
        this.currentIndex = (this.currentIndex + 1) % this.healthyProxies.length;
        this.systemHealth.activeProxy = this.healthyProxies[this.currentIndex];
        this.systemHealth.shieldActive = this.systemHealth.activeProxy !== 'DIRECT';
        this.lastRotation = Date.now();
        
        logger.info(`🔄 [SHIELD] Rotating Proxy (${reason}): Now using ${this.systemHealth.activeProxy}`);
    }

    getProxy() {
        // Automatic rotation every 50 requests if not DIRECT
        if (this.systemHealth.activeProxy !== 'DIRECT' && Date.now() - this.lastRotation > 300000) {
            this.rotateProxy('Timeout');
        }
        return this.systemHealth.activeProxy;
    }

    getStatus() {
        return {
            ...this.systemHealth,
            healthyCount: this.healthyProxies.length,
            totalCount: this.proxies.length
        };
    }
}

module.exports = new ShieldEngine();
