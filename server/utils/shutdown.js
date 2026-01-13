/**
 * Graceful shutdown handler
 * Ensures clean shutdown on SIGTERM/SIGINT signals
 */

const { logger } = require('./logger');

let isShuttingDown = false;

/**
 * Setup graceful shutdown handlers
 * @param {http.Server} server - HTTP server instance
 * @param {SocketIO.Server} io - Socket.IO server instance
 */
function setupGracefulShutdown(server, io) {
    const shutdown = async (signal) => {
        if (isShuttingDown) {
            logger.warn('Shutdown already in progress, forcing exit');
            process.exit(1);
        }

        isShuttingDown = true;
        logger.info(`Received ${signal}, starting graceful shutdown`);

        // Stop accepting new connections
        server.close(() => {
            logger.info('HTTP server closed');
        });

        // Notify connected clients
        if (io) {
            io.emit('serverShutdown', {
                message: 'Server is restarting, please reconnect shortly'
            });

            // Give clients time to receive the message
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Close socket connections
            io.close(() => {
                logger.info('Socket.IO server closed');
            });
        }

        // Allow remaining operations to complete
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info('Graceful shutdown complete');
        process.exit(0);
    };

    // Handle termination signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception', {
            error: error.message,
            stack: error.stack
        });
        shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled rejection', {
            reason: reason?.message || String(reason),
            stack: reason?.stack
        });
        // Log but don't shutdown for unhandled rejections
    });

    logger.debug('Graceful shutdown handlers registered');
}

module.exports = { setupGracefulShutdown };
