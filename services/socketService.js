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
                cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'] },
                transports: ['websocket', 'polling'],
                allowRequest: (req, callback) => {
                    const secretKey = process.env.API_SECRET_KEY
                    const authHeader = req.headers?.authorization || ''
                    const token = authHeader.replace('Bearer ', '')
                    const isAuthorized = !secretKey || token === secretKey
                    callback(null, isAuthorized)
                }
            })

            this.io.use((socket, next) => {
                const secretKey = process.env.API_SECRET_KEY
                if (!secretKey) return next()
                const token = socket.handshake.auth?.token
                if (token === secretKey) return next()
                next(new Error('Authentication required'))
            })

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
