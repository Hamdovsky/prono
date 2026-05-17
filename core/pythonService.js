const axios = require('axios');
const logger = require('./logger');

const FASTAPI_URL = process.env.INFERENCE_URL || 'http://127.0.0.1:8000';

class PythonService {
    constructor() {
        this.isReady = false;
        // Try to establish connection on startup
        this.checkHealth();
    }

    async checkHealth() {
        try {
            await axios.get(`${FASTAPI_URL}/health`, { timeout: 2000 });
            if (!this.isReady) {
                logger.info(`✅ [PythonService] FastAPI Inference Engine connected at ${FASTAPI_URL}`);
                this.isReady = true;
            }
            return true;
        } catch (e) {
            if (this.isReady) {
                logger.warn(`⚠️ [PythonService] FastAPI Inference Engine disconnected.`);
                this.isReady = false;
            }
            return false;
        }
    }

    async predict(matchData, timeoutMs = 180000) {
        try {
            const response = await axios.post(`${FASTAPI_URL}/predict`, matchData, { 
                timeout: timeoutMs,
                maxContentLength: Infinity,
                maxBodyLength: Infinity 
            });
            return response.data;
        } catch (error) {
            logger.error(`❌ [PythonService] Inference Error: ${error.message}`);
            // Fallback for compatibility with existing prediction parsing
            if (error.response && error.response.data) {
                return { success: false, error: error.response.data.detail || error.message };
            }
            return { success: false, error: error.message };
        }
    }

    getPoolStatus() {
        return {
            status: this.isReady ? 'ONLINE' : 'OFFLINE',
            type: 'FastAPI_Microservice',
            url: FASTAPI_URL
        };
    }

    restartPool() {
        logger.info('🔄 [PythonService] Restart requested, but FastAPI is managed externally now.');
    }

    async waitForReady(timeoutMs = 60000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const isUp = await this.checkHealth();
            if (isUp) return true;
            await new Promise(r => setTimeout(r, 1000));
        }
        logger.warn('⚠️ [PythonService] Timeout waiting for FastAPI, continuing anyway.');
        return false;
    }
}

module.exports = new PythonService();
