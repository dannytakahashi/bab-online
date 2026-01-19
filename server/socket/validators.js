/**
 * Socket event validation schemas using Joi
 * Ensures all incoming data is properly validated before processing
 */

const Joi = require('joi');

// Card schema - validates card objects
const cardSchema = Joi.object({
    suit: Joi.string().valid('spades', 'hearts', 'diamonds', 'clubs', 'joker').required(),
    rank: Joi.string().valid(
        '2', '3', '4', '5', '6', '7', '8', '9', '10',
        'J', 'Q', 'K', 'A', 'HI', 'LO'
    ).required()
});

// Validation schemas for each socket event
const schemas = {
    // Authentication
    signIn: Joi.object({
        username: Joi.string().min(1).max(50).required(),
        password: Joi.string().min(1).max(100).required()
    }),

    signUp: Joi.object({
        username: Joi.string().min(1).max(50).required(),
        password: Joi.string().min(1).max(100).required()
    }),

    restoreSession: Joi.object({
        username: Joi.string().min(1).max(50).required(),
        sessionToken: Joi.string().uuid().required()
    }),

    // Game actions
    playCard: Joi.object({
        card: cardSchema.required(),
        position: Joi.number().integer().min(1).max(4).required()
    }),

    playerBid: Joi.object({
        bid: Joi.alternatives().try(
            Joi.number().integer().min(0).max(12),
            Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'B', '2B', '3B', '4B')
        ).required(),
        position: Joi.number().integer().min(1).max(4).required()
    }),

    draw: Joi.object({
        num: Joi.number().integer().min(0).max(53).required()
    }),

    // Chat
    chatMessage: Joi.object({
        message: Joi.string().min(1).max(500).required()
    }),

    // Queue (no data needed, but validate anyway)
    joinQueue: Joi.object({}).unknown(true),
    leaveQueue: Joi.object({}).unknown(true),

    // Reconnection
    rejoinGame: Joi.object({
        gameId: Joi.string().uuid().required(),
        username: Joi.string().min(1).max(50).required()
    })
};

/**
 * Custom validation error class
 */
class ValidationError extends Error {
    constructor(message, details = []) {
        super(message);
        this.name = 'ValidationError';
        this.isValidation = true;
        this.details = details;
    }
}

/**
 * Validate data against a schema
 * @param {string} schemaName - Name of the schema to use
 * @param {*} data - Data to validate
 * @returns {Object} - Validated and sanitized data
 * @throws {ValidationError} - If validation fails
 */
function validate(schemaName, data) {
    const schema = schemas[schemaName];

    if (!schema) {
        // No schema defined - allow but log warning
        console.warn(`No validation schema for event: ${schemaName}`);
        return data;
    }

    const { error, value } = schema.validate(data, {
        stripUnknown: true,  // Remove extra fields for security
        abortEarly: false    // Return all errors, not just first
    });

    if (error) {
        const messages = error.details.map(d => d.message);
        throw new ValidationError(
            `Validation failed: ${messages.join(', ')}`,
            error.details
        );
    }

    return value;
}

/**
 * Create a validated handler wrapper
 * Validates input before passing to the actual handler
 * @param {string} schemaName - Name of the validation schema
 * @param {Function} handler - The actual event handler
 * @returns {Function} - Wrapped handler with validation
 */
function withValidation(schemaName, handler) {
    return async (socket, io, data) => {
        try {
            const validatedData = validate(schemaName, data);
            return await handler(socket, io, validatedData);
        } catch (error) {
            if (error.isValidation) {
                console.warn(`Validation error for ${schemaName}:`, error.message);
                socket.emit('error', {
                    type: 'validation',
                    message: error.message
                });
                return;
            }
            // Re-throw non-validation errors
            throw error;
        }
    };
}

module.exports = {
    validate,
    withValidation,
    ValidationError,
    schemas,
    cardSchema
};
