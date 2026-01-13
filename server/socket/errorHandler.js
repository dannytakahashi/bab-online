/**
 * Error handling utilities for socket event handlers
 * Wraps handlers to catch and properly handle errors
 */

const { validate, ValidationError } = require('./validators');

/**
 * Wrap an async socket handler with error handling and validation
 * @param {string} schemaName - Name of validation schema (or null to skip validation)
 * @param {Function} handler - Async handler function (socket, io, data) => Promise
 * @returns {Function} - Wrapped handler
 */
function asyncHandler(schemaName, handler) {
    return async (socket, io, data) => {
        try {
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
 * Wrap a sync socket handler with error handling and validation
 * @param {string} schemaName - Name of validation schema (or null to skip validation)
 * @param {Function} handler - Sync handler function (socket, io, data) => void
 * @returns {Function} - Wrapped handler
 */
function syncHandler(schemaName, handler) {
    return (socket, io, data) => {
        try {
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
    // Log error details
    console.error(`Socket handler error [${handlerName}]:`, {
        socketId: socket.id,
        error: error.message,
        stack: error.stack,
        isValidation: error.isValidation || false
    });

    // Send appropriate error to client
    if (error.isValidation) {
        socket.emit('error', {
            type: 'validation',
            message: error.message,
            handler: handlerName
        });
    } else {
        // Don't expose internal error details to client
        socket.emit('error', {
            type: 'server',
            message: 'An error occurred processing your request',
            handler: handlerName
        });
    }
}

/**
 * Create a simple wrapper that just adds error handling (no validation)
 * Useful for handlers that don't need input validation
 * @param {Function} handler - Handler function
 * @returns {Function} - Wrapped handler
 */
function safeHandler(handler) {
    return asyncHandler(null, handler);
}

module.exports = {
    asyncHandler,
    syncHandler,
    safeHandler,
    handleError
};
