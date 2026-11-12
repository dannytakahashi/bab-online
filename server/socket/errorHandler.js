/**
 * Error handling utilities for socket event handlers
 * Wraps handlers to catch and properly handle errors
 * Includes rate limiting and validation
 */

const { validate, ValidationError } = require('./validators');
const rateLimiter = require('./rateLimiter');
const { socketLogger } = require('../utils/logger');
const { emitError } = require('./serverError');

/**
 * The c2s event an error of this wrapper answers (error.handler and
 * serverError.handler, the same on every path: rate limit, validation,
 * exception): options.event, else the schema name, else the handler's
 * function name (safeHandler, no schema), else 'unknown'.
 */
function eventOf(schemaName, handler, options) {
    return options.event || schemaName || (handler && handler.name) || 'unknown';
}

/**
 * Wrap an async socket handler with rate limiting, validation, and error handling
 * @param {string} schemaName - Name of validation schema (or null to skip validation)
 * @param {Function} handler - Async handler function (socket, io, data) => Promise
 * @param {Object} options - { rateLimit = true, event }: event is the c2s
 *   event name reported as the error's handler, when it is not schemaName
 *   (the chat events share the chatMessage schema and rate-limit key)
 * @returns {Function} - Wrapped handler
 */
function asyncHandler(schemaName, handler, options = {}) {
    const { rateLimit = true } = options;
    const event = eventOf(schemaName, handler, options);
    return async (socket, io, data) => {
        try {
            // Check rate limit first
            if (rateLimit && schemaName && !rateLimiter.check(socket.id, schemaName)) {
                emitError(socket, {
                    type: 'rateLimit',
                    message: 'Too many requests, please slow down',
                    handler: event
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
            handleError(socket, event, error);
        }
    };
}

/**
 * Wrap a sync socket handler with rate limiting, validation, and error handling
 * @param {string} schemaName - Name of validation schema (or null to skip validation)
 * @param {Function} handler - Sync handler function (socket, io, data) => void
 * @param {Object} options - { rateLimit = true, event }: event is the c2s
 *   event name reported as the error's handler, when it is not schemaName
 *   (the chat events share the chatMessage schema and rate-limit key)
 * @returns {Function} - Wrapped handler
 */
function syncHandler(schemaName, handler, options = {}) {
    const { rateLimit = true } = options;
    const event = eventOf(schemaName, handler, options);
    return (socket, io, data) => {
        try {
            // Check rate limit first
            if (rateLimit && schemaName && !rateLimiter.check(socket.id, schemaName)) {
                emitError(socket, {
                    type: 'rateLimit',
                    message: 'Too many requests, please slow down',
                    handler: event
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
            handleError(socket, event, error);
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
        emitError(socket, {
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
        emitError(socket, {
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
