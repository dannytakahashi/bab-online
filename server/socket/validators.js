/**
 * Socket event validation schemas using Joi
 * Ensures all incoming data is properly validated before processing
 */

const Joi = require('joi');
const { BID_VALUES, MAX_HAND_SIZE } = require('../game/rules');
const { STOCK_AVATAR_COUNT } = require('../avatar/stockAvatars');
const { ADMIN_ACTIONS } = require('../admin/actions');

// Card schema - validates card objects
const cardSchema = Joi.object({
    suit: Joi.string().valid('spades', 'hearts', 'diamonds', 'clubs', 'joker').required(),
    rank: Joi.string().valid(
        '2', '3', '4', '5', '6', '7', '8', '9', '10',
        'J', 'Q', 'K', 'A', 'HI', 'LO'
    ).required()
});

// Voice signaling (V1_REMOVALS #18). Bounds sized well above what the
// clients send (web: RTCSessionDescription / RTCIceCandidate toJSON; iOS
// 1.1.0: VoiceEmitter, username "" when unknown, sdpMid "" when nil)
const MAX_SDP_LENGTH = 64 * 1024;
const voiceTarget = Joi.string().min(1).max(64);
const sessionDescription = Joi.object({
    type: Joi.string().valid('offer', 'pranswer', 'answer', 'rollback').required(),
    sdp: Joi.string().allow('').max(MAX_SDP_LENGTH).required()
}).unknown(true);

// Cloudflare SFU voice (server/socket/sfuHandlers.js; checked in the
// handler: a bad one is answered sfuReply {error: invalid} when it carries a
// requestId, else dropped). An SFU session description grows with the
// tracks on the session (one m-section per pulled track: ~660 bytes of offer and ~570 of answer each,
// measured 2026-11-26: docs/claude/voice.md "SFU voice (server)"), so it may
// be far longer than a mesh call's: 256 KB holds well over the room's
// ceiling of tracks (100 tracks: ~66 KB). Ids are what Cloudflare hands out (session ids 64 hex
// chars, mids decimal) with room to spare.
const MAX_SFU_SDP_LENGTH = 256 * 1024;
const MAX_SFU_TRACKS = 64; // Cloudflare: at most 64 tracks per tracks/new request
const sfuRequestId = Joi.string().min(1).max(64).required();
const sfuSessionId = Joi.string().pattern(/^[A-Za-z0-9_-]{1,128}$/);
const sfuMid = Joi.string().pattern(/^[A-Za-z0-9_-]{1,32}$/);
const sfuTrackName = Joi.string().pattern(/^[A-Za-z0-9_.:-]{1,64}$/);
const sfuSdp = (type) => Joi.object({
    type: Joi.string().valid(type).required(),
    sdp: Joi.string().min(1).max(MAX_SFU_SDP_LENGTH).required()
}).unknown(true);
const sfuTrackRef = Joi.object({ sessionId: sfuSessionId.required(), trackName: sfuTrackName.required() });

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

    // Client error reports (socket/clientErrorHandlers.js, checked in the
    // handler: a bad one is dropped silently); mirrors contract c2s.clientError.
    // Strings only, each capped: no free-form object reaches the log
    clientError: Joi.object({
        kind: Joi.string().pattern(/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/).required(),
        message: Joi.string().min(1).max(500).required(),
        stack: Joi.string().max(4000).allow('').optional(),
        where: Joi.string().max(200).allow('').optional(),
        build: Joi.string().max(64).allow('').optional(),
        page: Joi.string().max(32).pattern(/^[A-Za-z0-9_.:-]*$/).allow('').optional()
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
        name: Joi.string().max(50).allow('', null).optional(),
        // The game mode (server/game/gameMode.js): 'gyb' is Get Your Bid;
        // absent or 'classic' the base game
        mode: Joi.string().valid('classic', 'gyb').optional()
    }),

    // Hardening (V1_REMOVALS #18): both clients send these shapes (web on
    // main; iOS 1.1.0 LobbyEmitter.joinLobby / removeBot)
    joinLobby: Joi.object({
        lobbyId: Joi.string().uuid().required()
    }).required(),
    // Only a bot can be removed (a lobby lists every member's socket id)
    removeBot: Joi.object({
        botSocketId: Joi.string().min(5).max(200).pattern(/^bot:/).required()
    }).required(),

    // Profile lookups (web and iOS). The handler answers a blank query and a
    // query longer than any username itself; these only bound the input
    searchPlayers: Joi.object({
        query: Joi.string().allow('').max(500).required()
    }).required(),
    // The Players page's online list pictures (2026-11-27): up to 100
    // usernames (profileHandlers PLAYER_CARDS_MAX), each a username's length
    // (sign-in's bounds); repeats are allowed and answered once
    playerCards: Joi.object({
        usernames: Joi.array().items(Joi.string().min(1).max(50)).min(1).max(100).required()
    }).required(),
    getPlayerProfile: Joi.object({
        username: Joi.string().min(1).max(100).required(),
        // Stats scope (server/utils/statsScope.js). Lenient on purpose: any
        // value (a non-string, null, a long string) is accepted here and
        // normalized to 'human' by the handler, never refused (before the
        // key existed, stripUnknown dropped it and the request succeeded)
        scope: Joi.any().optional()
    }).required(),

    // Voice relays: checked inside voiceHandlers (a bad one is dropped
    // silently, never answered with error), not by the socket wrapper
    sfuSession: Joi.object({ requestId: sfuRequestId }).required(),
    sfuPush: Joi.object({
        requestId: sfuRequestId,
        sessionId: sfuSessionId.required(),
        offer: sfuSdp('offer').required(),
        mid: sfuMid.required(),
        trackName: sfuTrackName.required()
    }).required(),
    sfuPull: Joi.object({
        requestId: sfuRequestId,
        sessionId: sfuSessionId.required(),
        tracks: Joi.array().items(sfuTrackRef).min(1).max(MAX_SFU_TRACKS).required()
    }).required(),
    sfuRenegotiate: Joi.object({
        requestId: sfuRequestId,
        sessionId: sfuSessionId.required(),
        answer: sfuSdp('answer').required()
    }).required(),
    sfuClose: Joi.object({
        requestId: sfuRequestId,
        sessionId: sfuSessionId.required(),
        mids: Joi.array().items(sfuMid).min(1).max(MAX_SFU_TRACKS).unique().required(),
        force: Joi.boolean().optional(),
        // negotiated (force false or absent): our offer is required
        offer: Joi.when('force', { is: true, then: Joi.any().strip(), otherwise: sfuSdp('offer').required() })
    }).required(),
    sfuIceRestart: Joi.object({
        requestId: sfuRequestId,
        sessionId: sfuSessionId.required(),
        offer: sfuSdp('offer').required()
    }).required(),
    sfuResume: Joi.object({
        requestId: sfuRequestId,
        sessionId: sfuSessionId.required(),
        sessionToken: Joi.string().pattern(/^[A-Za-z0-9_-]{43}$/).required(),
        // the published track: both or neither (null, null); checked in the handler
        trackName: sfuTrackName.allow(null).required(),
        mid: sfuMid.allow(null).required(),
        pulls: Joi.array().items(Joi.object({ mid: sfuMid.required(), sessionId: sfuSessionId.required(), trackName: sfuTrackName.required() })).max(512).optional()
    }).required(),
    sfuLeave: Joi.object({
        requestId: sfuRequestId,
        sessionId: sfuSessionId.allow(null).optional()
    }).required(),

    voiceOffer: Joi.object({
        targetSocketId: voiceTarget.required(),
        offer: sessionDescription.required(),
        username: Joi.string().allow('', null).max(100).optional()
    }).required(),
    voiceAnswer: Joi.object({
        targetSocketId: voiceTarget.required(),
        answer: sessionDescription.required()
    }).required(),
    voiceIceCandidate: Joi.object({
        targetSocketId: voiceTarget.required(),
        candidate: Joi.object({
            candidate: Joi.string().allow('').max(4096).required(),
            sdpMLineIndex: Joi.number().integer().min(0).max(1024).allow(null).optional(),
            sdpMid: Joi.string().allow('', null).max(256).optional(),
            usernameFragment: Joi.string().allow('', null).max(256).optional()
        }).unknown(true).required()
    }).required(),

    // Reconnection
    rejoinGame: Joi.object({
        gameId: Joi.string().uuid().required(),
        username: Joi.string().min(1).max(50).required(),
        sessionToken: Joi.string().max(200).optional()
    }),

    // Snapshot v2 (all optional; no payload at all is fine too)
    requestSnapshot: Joi.object({
        requestId: Joi.alternatives().try(Joi.string().max(64), Joi.number().integer()).optional(),
        customPics: Joi.boolean().optional(), // accepted and ignored since V1_REMOVALS #19 C (web and iOS 1.2.0 send false)
        log: Joi.boolean().optional()
    }),

    // Voice ICE servers (no payload at all is fine too; socket.io sends an
    // explicit undefined argument as null)
    getVoiceIceServers: Joi.object({
        requestId: Joi.string().min(1).max(64).optional()
    }).allow(null),
    // "Spectators can talk" (voiceHandlers.setSpectatorsCanTalk); mirrors
    // contract c2s.setSpectatorsCanTalk
    setSpectatorsCanTalk: Joi.object({
        spectatorsCanTalk: Joi.boolean().strict().required()
    }).required(),
    // "Don't wait for <name>" (playAgain.releaseLobbyHold); mirrors
    // contract c2s.releaseLobbyHold
    releaseLobbyHold: Joi.object({
        username: Joi.string().min(1).max(32).required()
    }).required(),

    // Resignation
    forceResign: Joi.object({
        position: Joi.number().integer().min(1).max(4).required()
    }),

    // Spectator
    joinAsSpectator: Joi.object({
        gameId: Joi.string().uuid().required()
    }),
    // Over-the-shoulder view (socket/shoulderView.js); mirrors contract
    // c2s.watchHand. position null = stop watching
    watchHand: Joi.object({
        gameId: Joi.string().uuid().required(),
        position: Joi.number().integer().strict().min(1).max(4).allow(null).required(),
        requestId: Joi.alternatives().try(Joi.string().min(1).max(64), Joi.number().integer()).optional()
    }).required(),

    // Profile
    updateProfilePic: Joi.object({
        profilePic: Joi.number().integer().min(1).max(STOCK_AVATAR_COUNT).required()
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

    // The host's round count, lobby only (2026-11-25)
    setTournamentRounds: Joi.object({
        totalRounds: Joi.number().integer().strict().min(1).max(5).required()
    }),

    // Cut for a buck (2026-11-25): a draw for the open round; slot null
    // (or absent) draws a random free slot
    cutForABuckDraw: Joi.object({
        round: Joi.number().integer().strict().min(1).max(10000).required(),
        slot: Joi.number().integer().strict().min(0).max(107).allow(null).optional()
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
    // next: 1-100 like signUp, so a short one gets the 8-character rule's
    // message from the handler (setPassword.checkPasswordRule)
    changePassword: Joi.object({
        current: Joi.string().min(1).max(100).required(),
        next: Joi.string().min(1).max(100).required()
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

module.exports = {
    validate,
    ValidationError,
    schemas,
    cardSchema
};
