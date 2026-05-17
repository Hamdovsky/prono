// TN-INTEL Logging Service - Production Grade
const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        this.errorLog = path.join(this.logDir, 'error.log');
        this.infoLog = path.join(this.logDir, 'info.log');
        this.currentDate = new Date().toISOString().split('T')[0];
        
        // 🛡️ [RECURSION GUARD] 
        this.isProcessingError = false;
        this.logBurstCount = 0;
        this.lastBurstReset = Date.now();
        this.MAX_BURST = 20; // Reduced from 50 to further mitigate IO pressure
    }

    _getTimestamp() {
        return new Date().toISOString();
    }

    _formatMessage(level, message, meta = {}) {
        const safeMeta = {};
        try {
            for (const [key, value] of Object.entries(meta)) {
                if (value instanceof Error) {
                    safeMeta[key] = { message: value.message, stack: value.stack };
                } else if (typeof value === 'object' && value !== null) {
                    try {
                        safeMeta[key] = JSON.stringify(value).substring(0, 500); // Truncate long objects
                    } catch (e) {
                        safeMeta[key] = '[Object]';
                    }
                } else {
                    safeMeta[key] = value;
                }
            }
            return JSON.stringify({
                timestamp: this._getTimestamp(),
                level,
                message,
                ...safeMeta
            }) + '\n';
        } catch (e) {
            return `${this._getTimestamp()} [${level}] ${message} (Meta serialization failed)\n`;
        }
    }

    _rotateIfNeeded() {
        const today = new Date().toISOString().split('T')[0];
        if (today !== this.currentDate) {
            // Rotate logs
            const archiveDate = this.currentDate;
            try {
                if (fs.existsSync(this.errorLog)) {
                    const errorArchive = path.join(this.logDir, `error_${archiveDate}.log`);
                    fs.renameSync(this.errorLog, errorArchive);
                }
                if (fs.existsSync(this.infoLog)) {
                    const infoArchive = path.join(this.logDir, `info_${archiveDate}.log`);
                    fs.renameSync(this.infoLog, infoArchive);
                }
            } catch (e) {
                try { console.error('Log rotation failed:', e.message); } catch (_) {}
            }
            this.currentDate = today;

            // Cleanup logs older than 14 days
            this._cleanupOldLogs();
        }
    }

    _cleanupOldLogs() {
        try {
            const files = fs.readdirSync(this.logDir);
            const now = Date.now();
            const maxAge = 14 * 24 * 60 * 60 * 1000; // 14 days

            files.forEach(file => {
                const filePath = path.join(this.logDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                }
            });
        } catch (e) {}
    }

    info(message, meta = {}) {
        try {
            this._rotateIfNeeded();
            const formatted = this._formatMessage('INFO', message, meta);
            fs.appendFileSync(this.infoLog, formatted);
            console.log(`ℹ️  ${message}`, meta);
        } catch (e) {
            // Silently handle EPIPE/FS errors
        }
    }

    warn(message, meta = {}) {
        try {
            this._rotateIfNeeded();
            const formatted = this._formatMessage('WARN', message, meta);
            fs.appendFileSync(this.infoLog, formatted);
            console.warn(`⚠️  ${message}`, meta);
        } catch (e) {
            // Silently handle EPIPE/FS errors
        }
    }

    debug(message, meta = {}) {
        if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
            try {
                console.debug(`🐞 ${message}`, meta);
            } catch (e) {}
        }
    }

    error(message, error = null, meta = {}) {
        if (this.isProcessingError) return; // Prevent recursive log storm
        
        try {
            this.isProcessingError = true;
            this._rotateIfNeeded();
            
            // 🛡️ [BURST PROTECTION]
            const now = Date.now();
            if (now - this.lastBurstReset > 10000) {
                this.logBurstCount = 0;
                this.lastBurstReset = now;
            }
            this.logBurstCount++;
            if (this.logBurstCount > this.MAX_BURST) {
                if (this.logBurstCount === this.MAX_BURST + 1) {
                    try { console.error('🔥 [LOGGER] Error burst detected! Throttling disk writes...'); } catch (_) {}
                }
                return;
            }

            const errorDetails = error ? {
                message: error.message,
                stack: error.stack,
                ...meta
            } : meta;

            const formatted = this._formatMessage('ERROR', message, errorDetails);
            
            // 🛡️ [SIZE PROTECTION] Don't write to disk if log is already massive (>50MB)
            let skipFile = false;
            try {
                if (fs.existsSync(this.errorLog) && fs.statSync(this.errorLog).size > 50 * 1024 * 1024) {
                    skipFile = true;
                }
            } catch (e) {}

            if (!skipFile) {
                try {
                    fs.appendFileSync(this.errorLog, formatted);
                } catch (fsErr) {}
            }

            // 🛡️ [EPIPE PROTECTION] Handle broken stdout/stderr gracefully
            try {
                process.stderr.write(`❌ ${message} ${JSON.stringify(errorDetails)}\n`);
            } catch (epipe) {}
        } catch (fatalErr) {
        } finally {
            this.isProcessingError = false;
        }
    }
}

const logger = new Logger();

// Global error handlers
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error, { critical: true });
    // Give time to write logs before crashing
    // setTimeout(() => process.exit(1), 1000); // Debug: keep alive
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', reason, { promise: promise.toString() });
});

module.exports = logger;
