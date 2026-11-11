/**
 * Socket event validation schemas using Joi
 * Ensures all incoming data is properly validated before processing
 */

const Joi = require('joi');
const { BID_VALUES, MAX_HAND_SIZE } = require('../game/rules');
const { ADMIN_ACTIONS } = require('../admin/actions');

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

    // Client capabilities (socket/clientInfo.js); mirrors contract c2s.clientHello
    clientHello: Joi.object({
        client: Joi.string().min(1).max(16).pattern(/^[a-z0-9-]+$/).required(),
        version: Joi.string().min(1).max(32).required(),
        build: Joi.string().max(64).allow('').optional(),
        caps: Joi.array().items(Joi.string().min(1).max(32)).max(16).required()
    }),

    // Game actions
    playCard: Joi.object({
        card: cardSchema.required(),
        position: Joi.number().integer().min(1).max(4).required()
    }),

    playerBid: Joi.object({
        // Any value some hand accepts; whether it fits THIS hand (13 only on
        // the 13-card hand, bore levels in order) is isValidBid's call
        bid: Joi.alternatives().try(
            Joi.number().integer().min(0).max(MAX_HAND_SIZE),
            Joi.string().valid(...BID_VALUES)
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

    // Lobby creation — the name is run through the profanity filter, so it
    // must be length-capped here
    createLobby: Joi.object({
        name: Joi.string().max(50).allow('', null).optional()
    }),

    // Queue (no data needed, but validate anyway)
    joinQueue: Joi.object({}).unknown(true),
    leaveQueue: Joi.object({}).unknown(true),

    // Reconnection
    rejoinGame: Joi.object({
        gameId: Joi.string().uuid().required(),
        username: Joi.string().min(1).max(50).required(),
        sessionToken: Joi.string().max(200).optional()
    }),

    // Snapshot v2 (all optional; no payload at all is fine too)
    requestSnapshot: Joi.object({
        requestId: Joi.alternatives().try(Joi.string().max(64), Joi.number().integer()).optional(),
        customPics: Joi.boolean().optional(),
        log: Joi.boolean().optional()
    }),

    // Voice ICE servers (no payload at all is fine too; socket.io sends an
    // explicit undefined argument as null)
    getVoiceIceServers: Joi.object({
        requestId: Joi.string().min(1).max(64).optional()
    }).allow(null),

    // Resignation
    forceResign: Joi.object({
        position: Joi.number().integer().min(1).max(4).required()
    }),

    // Spectator
    joinAsSpectator: Joi.object({
        gameId: Joi.string().uuid().required()
    }),

    // Profile
    updateProfilePic: Joi.object({
        profilePic: Joi.number().integer().min(1).max(82).required()
    }),

    // The handler refuses anything over ~682,666 chars (500 KB decoded)
    // anyway; the cap stops Joi from walking a huge string first
    uploadProfilePic: Joi.object({
        imageData: Joi.string().max(682700).required()
    }),

    // Tournament
    joinTournament: Joi.object({
        tournamentId: Joi.string().uuid().required()
    }),

    spectateTournament: Joi.object({
        tournamentId: Joi.string().uuid().required()
    }),

    spectateTournamentGame: Joi.object({
        gameId: Joi.string().uuid().required()
    }),

    // No-payload tournament events (schemas exist so rate limiting applies)
    createTournament: Joi.object({}).unknown(true),
    leaveTournament: Joi.object({}).unknown(true),
    tournamentReady: Joi.object({}).unknown(true),
    tournamentUnready: Joi.object({}).unknown(true),
    beginTournament: Joi.object({}).unknown(true),
    beginNextRound: Joi.object({}).unknown(true),
    returnToTournament: Joi.object({}).unknown(true),
    cancelTournament: Joi.object({}).unknown(true),

    // Account management
    deleteAccount: Joi.object({
        password: Joi.string().min(1).max(100).required()
    }),

    // Safety / moderation
    reportUser: Joi.object({
        username: Joi.string().min(1).max(50).required(),
        reason: Joi.string().min(1).max(500).required(),
        context: Joi.string().max(1000).allow('').optional()
    }),

    blockUser: Joi.object({
        username: Joi.string().min(1).max(50).required()
    }),

    unblockUser: Joi.object({
        username: Joi.string().min(1).max(50).required()
    }),

    // Admin panel (socket/adminHandlers.js): the envelope only. The
    // handler checks the admin first and validates `args` per action after
    // that, so a non-admin gets the one uniform refusal whatever it sends
    adminRequest: Joi.object({
        requestId: Joi.string().min(1).max(64).required(),
        action: Joi.string().valid(...ADMIN_ACTIONS).required(),
        args: Joi.object().unknown(true).optional()
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
