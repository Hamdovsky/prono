const pythonService = require('../core/pythonService');
const logger = require('../core/logger');

logger.info('🚀 [RELOAD] Triggering worker pool reload...');
pythonService.restartPool();

// Wait a bit to ensure they are killed
setTimeout(() => {
    logger.info('✅ [RELOAD] Workers signal sent. They will restart sequentially.');
    process.exit(0);
}, 2000);
