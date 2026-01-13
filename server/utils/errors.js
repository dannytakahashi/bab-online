/**
 * Custom error classes for structured error handling
 * All operational errors extend GameError with isOperational flag
 */

/**
 * Base error class for all game-related errors
 * @property {boolean} isOperational - True for expected errors (validation, auth, etc.)
 */
class GameError extends Error {
    constructor(message, code = 'GAME_ERROR', context = {}) {
        super(message);
        this.name = 'GameError';
        this.code = code;
        this.context = context;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            context: this.context
        };
    }
}

/**
 * Input validation errors
 */
class ValidationError extends GameError {
    constructor(message, context = {}) {
        super(message, 'VALIDATION_ERROR', context);
        this.name = 'ValidationError';
    }
}

/**
 * Game state errors (illegal moves, wrong turn, etc.)
 */
class GameStateError extends GameError {
    constructor(message, context = {}) {
        super(message, 'GAME_STATE_ERROR', context);
        this.name = 'GameStateError';
    }
}

/**
 * Authentication errors
 */
class AuthError extends GameError {
    constructor(message, context = {}) {
        super(message, 'AUTH_ERROR', context);
        this.name = 'AuthError';
    }
}

/**
 * Rate limiting errors
 */
class RateLimitError extends GameError {
    constructor(message = 'Too many requests', context = {}) {
        super(message, 'RATE_LIMIT_ERROR', context);
        this.name = 'RateLimitError';
    }
}

/**
 * Not found errors (game not found, player not found, etc.)
 */
class NotFoundError extends GameError {
    constructor(message, context = {}) {
        super(message, 'NOT_FOUND_ERROR', context);
        this.name = 'NotFoundError';
    }
}

module.exports = {
    GameError,
    ValidationError,
    GameStateError,
    AuthError,
    RateLimitError,
    NotFoundError
};
