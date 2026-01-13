/**
 * Error handling utilities for socket event handlers
 * Wraps handlers to catch and properly handle errors
 * Includes rate limiting and validation
 */

const { validate, ValidationError } = require('./validators');
const rateLimiter = require('./rateLimiter');
const { socketLogger } = require('../utils/logger');

/**
 * Wrap an async socket handler with rate limiting, validation, and error handling
 * @param {string} schemaName - Name of validation schema (or null to skip validation)
 * @param {Function} handler - Async handler function (socket, io, data) => Promise
 * @param {Object} options - Options { rateLimit: boolean }
 * @returns {Function} - Wrapped handler
 */
function asyncHandler(schemaName, handler, options = { rateLimit: true }) {
    return async (socket, io, data) => {
        try {
            // Check rate limit first
            if (options.rateLimit && schemaName && !rateLimiter.check(socket.id, schemaName)) {
                socket.emit('error', {
                    type: 'rateLimit',
                    message: 'Too many requests, please slow down',
                    handler: schemaName
                });
                return;
            }

            // Validate input if schema provided
            let validatedData = data;
            if (schemaName) {
                validatedData = validate(schemaName, data);
            }

            // Execute handler
            await handler(socket, io, validatedData);

        } catch (error) {
            handleError(socket, handler.name || schemaName || 'unknown', error);
        }
    };
}

/**
 * Wrap a sync socket handler with rate limiting, validation, and error handling
 * @param {string} schemaName - Name of validation schema (or null to skip validation)
 * @param {Function} handler - Sync handler function (socket, io, data) => void
 * @param {Object} options - Options { rateLimit: boolean }
 * @returns {Function} - Wrapped handler
 */
function syncHandler(schemaName, handler, options = { rateLimit: true }) {
    return (socket, io, data) => {
        try {
            // Check rate limit first
            if (options.rateLimit && schemaName && !rateLimiter.check(socket.id, schemaName)) {
                socket.emit('error', {
                    type: 'rateLimit',
                    message: 'Too many requests, please slow down',
                    handler: schemaName
                });
                return;
            }

            // Validate input if schema provided
            let validatedData = data;
            if (schemaName) {
                validatedData = validate(schemaName, data);
            }

            // Execute handler
            handler(socket, io, validatedData);

        } catch (error) {
            handleError(socket, handler.name || schemaName || 'unknown', error);
        }
    };
}

/**
 * Handle error from socket handler
 * @param {Socket} socket - Socket instance
 * @param {string} handlerName - Name of the handler for logging
 * @param {Error} error - The error that occurred
 */
function handleError(socket, handlerName, error) {
    const errorContext = {
        socketId: socket.id,
        handler: handlerName,
        errorCode: error.code,
        context: error.context
    };

    // Log based on error type
    if (error.isValidation || error.isOperational) {
        // Expected errors - log as warning
        socketLogger.warn(error.message, errorContext);
        socket.emit('error', {
            type: error.code || 'validation',
            message: error.message,
            handler: handlerName
        });
    } else {
        // Unexpected errors - log full stack as error
        socketLogger.error(error.message, {
            ...errorContext,
            stack: error.stack
        });
        // Don't expose internal error details to client
        socket.emit('error', {
            type: 'server',
            message: 'An error occurred processing your request',
            handler: handlerName
        });
    }
}

/**
 * Create a simple wrapper that just adds error handling (no validation or rate limiting)
 * Useful for handlers that don't need input validation
 * @param {Function} handler - Handler function
 * @returns {Function} - Wrapped handler
 */
function safeHandler(handler) {
    return asyncHandler(null, handler, { rateLimit: false });
}

module.exports = {
    asyncHandler,
    syncHandler,
    safeHandler,
    handleError,
    rateLimiter
};
