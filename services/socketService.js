const { Server: SocketIOServer } = require('socket.io');
const { Client: PGClient } = require('pg');
const logger = require('../core/logger');
const ComboService = require('./comboService');

class SocketService {
    constructor() {
        this.io = null;
        this.pgListener = null;
    }

    init(server) {
        try {
            this.io = new SocketIOServer(server, {
                cors: { origin: '*', methods: ['GET', 'POST'] },
                transports: ['websocket', 'polling'],
                allowRequest: (req, callback) => {
                    // Always allow requests for now, but log potential auth issues
                    const isAuthorized = true; 
                    callback(null, isAuthorized);
                }
            });

            this.io.on('connection', (socket) => {
                const token = socket.handshake.auth?.token;
                logger.info(`📡 [SOCKET] Client connected: ${socket.id} (Auth provided: ${!!token})`);
                
                socket.on('error', (err) => {
                    logger.error(`❌ [SOCKET] Request Error from ${socket.id}:`, err.message);
                });

                socket.on('disconnect', (reason) => {
                    logger.info(`📡 [SOCKET] Client disconnected: ${socket.id} (Reason: ${reason})`);
                });
            });

            this._initPgListener();
            logger.info('✅ [SOCKET] Real-time engine ready');
        } catch (err) {
            logger.error('❌ [SOCKET] Initialization failed:', err.message);
        }
    }

    _initPgListener() {
        // [PREMATCH ONLY] PG Listener for live updates disabled.
        logger.info('⚡ [SOCKET] Real-time live listener disabled (Prematch Mode).');
    }

    async refreshCombos() {
        logger.info('🧠 [AI] Triggering combination refresh...');
        try {
            const newCombos = await ComboService.refreshCombos();
            if (newCombos && newCombos.length > 0 && this.io) {
                this.io.emit('combos_update', newCombos);
                logger.info(`📡 [SOCKET] Emitted ${newCombos.length} new combos to clients.`);
            }
        } catch (e) {
            logger.error(`❌ [AI] Combination refresh failed: ${e.message}`);
        }
    }

    broadcast(event, data) {
        if (this.io) {
            this.io.emit(event, data);
        }
    }
}

module.exports = new SocketService();
