const { Server: SocketIOServer } = require('socket.io')
const logger = require('../core/logger')
const ComboService = require('./comboService')

class SocketService {
  constructor() {
    this.io = null
    this.pgListener = null
    this._prevLiveScores = new Map()
  }

  init(server) {
    try {
      this.io = new SocketIOServer(server, {
        cors: {
          origin: (origin, callback) => callback(null, true),
          methods: ['GET', 'POST'],
        },
        transports: ['websocket', 'polling'],
        allowRequest: (req, callback) => {
          // Upcoming/live match broadcasts are public — allow connections.
          callback(null, true)
        },
      })

      this.io.use((socket, next) => {
        if (process.env.NODE_ENV === 'development') return next()
        const secretKey = process.env.API_SECRET_KEY
        if (!secretKey) return next()
        const token = socket.handshake.auth?.token
        if (token === secretKey) return next()
        next(new Error('Authentication required'))
      })

      this.io.on('connection', (socket) => {
        const token = socket.handshake.auth?.token
        logger.info(`📡 [SOCKET] Client connected: ${socket.id} (Auth provided: ${!!token})`)

        socket.on('error', (err) => {
          logger.error(`❌ [SOCKET] Request Error from ${socket.id}:`, err.message)
        })

        socket.on('disconnect', (reason) => {
          logger.info(`📡 [SOCKET] Client disconnected: ${socket.id} (Reason: ${reason})`)
        })
      })

      this._initPgListener()
      logger.info('✅ [SOCKET] Real-time engine ready')
    } catch (err) {
      logger.error('❌ [SOCKET] Initialization failed:', err.message)
    }
  }

  _initPgListener() {
    if (process.env.SOCKET_LIVE_DISABLED === 'true') {
      logger.info('⚡ [SOCKET] Live listener disabled via SOCKET_LIVE_DISABLED env var.')
      return
    }
    const POLL_INTERVAL = parseInt(process.env.SOCKET_LIVE_INTERVAL || '30') * 1000
    logger.info(`⚡ [SOCKET] Live listener active (polling every ${POLL_INTERVAL / 1000}s)`)

    const poll = async () => {
      try {
        // Poll only if clients are connected
        if (!this.io || this.io.engine?.clientsCount === 0) return

        const liveStatuses = [
          'live',
          'inprogress',
          'IN_PLAY',
          'LIVE',
          'playing',
          '1H',
          '2H',
          'HT',
          'ET',
          'PEN',
        ]
        const database = require('../core/database')
        const liveMatches = await database.getMatchesByStatuses(liveStatuses)

        if (!Array.isArray(liveMatches) || liveMatches.length === 0) {
          this._prevLiveScores.clear()
          return
        }

        let hasChanges = false
        const patches = []

        for (const m of liveMatches) {
          const prev = this._prevLiveScores.get(m.id)
          const scoreKey = `${m.scoreHome ?? ''}-${m.scoreAway ?? ''}-${m.minute ?? ''}`

          if (!prev) {
            hasChanges = true
          } else if (prev.score !== scoreKey) {
            patches.push({
              id: m.id,
              patch: [
                { op: 'replace', path: '/scoreHome', value: m.scoreHome },
                { op: 'replace', path: '/scoreAway', value: m.scoreAway },
                { op: 'replace', path: '/minute', value: m.minute },
              ],
            })
          }
          this._prevLiveScores.set(m.id, { score: scoreKey })
        }

        // Clean up stale entries
        for (const [id] of this._prevLiveScores) {
          if (!liveMatches.find((m) => m.id === id)) {
            this._prevLiveScores.delete(id)
            hasChanges = true
          }
        }

        if (hasChanges) {
          this.io.emit('matches_update', liveMatches)
        }
        for (const p of patches) {
          this.io.emit('match_patch_update', p)
        }
      } catch (err) {
        // Silently ignore polling errors — live scoring is best-effort
      }
    }

    // Start polling interval
    this._liveInterval = setInterval(poll, POLL_INTERVAL)
    this._liveInterval.unref()
    // Immediate first poll
    poll()
  }

  async refreshCombos() {
    logger.info('🧠 [AI] Triggering combination refresh...')
    try {
      const newCombos = await ComboService.refreshCombos()
      if (newCombos && newCombos.length > 0 && this.io) {
        this.io.emit('combos_update', newCombos)
        logger.info(`📡 [SOCKET] Emitted ${newCombos.length} new combos to clients.`)
      }
    } catch (e) {
      logger.error(`❌ [AI] Combination refresh failed: ${e.message}`)
    }
  }

  broadcast(event, data) {
    if (this.io) {
      this.io.emit(event, data)
    }
  }
}

module.exports = new SocketService()
