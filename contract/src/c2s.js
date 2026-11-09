/**
 * Client -> server events, from server/socket/index.js registrations.
 *
 * Per event:
 *   payload          JSON Schema of what a client may send (open objects:
 *                    Joi stripUnknown drops extras, and the clients send some)
 *   optionalPayload  true when the client may send no payload at all
 *   status           active | unsent (handled, no client sends it) | deprecated
 *   joi              validators.schemas key the handler is wrapped with, or null
 *   rateLimit        rateLimiter.limits key that applies, or null
 *   sentBy           which shipped clients emit it
 *   examples         payloads real clients send (validated by contract.test.js)
 *   invalid          payloads the server rejects: each must fail BOTH this
 *                    schema and Joi (so a client built from the schema never
 *                    sends something Joi refuses)
 */

'use strict';

const { str, int, bool, enm, ref, anyOf, obj, arr } = require('./defs');

const open = (props, o = {}) => obj(props, { ...o, open: true });
const none = open({});
const noPayload = { payload: none, optionalPayload: true };
const both = { web: true, ios: true };
const webOnly = { web: true, ios: false };
const iosOnly = { web: false, ios: true };
const nobody = { web: false, ios: false };
// Bounds mirror server/socket/validators.js (Joi); a payload valid here is
// valid for Joi (contract.test.js checks negative examples against both)
const uname = () => str({ minLength: 1, maxLength: 50 });
const password = () => str({ minLength: 1, maxLength: 100 });
const message = () => str({ minLength: 1, maxLength: 500 });
// Joi .uuid(): versions 1-8, RFC variant (a subset of what Joi accepts)
const uuid = () => str({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' });
const bidIn = anyOf(int({ minimum: 0, maximum: 12 }), enm('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'B', '2B', '3B', '4B'));

const c2s = {
    // Auth
    signIn: { payload: open({ username: uname(), password: password() }), status: 'active', joi: 'signIn', rateLimit: 'signIn', sentBy: both, examples: [{ username: 'alan', password: 'pw' }], invalid: [{ username: '', password: 'pw' }, { username: 'a'.repeat(51), password: 'pw' }, { username: 'alan' }] },
    signUp: { payload: open({ username: uname(), password: password() }), status: 'active', joi: 'signUp', rateLimit: 'signUp', sentBy: both, examples: [{ username: 'alan', password: 'pw' }], invalid: [{ username: 'alan', password: '' }, { username: 'alan', password: 'p'.repeat(101) }] },
    restoreSession: { payload: open({ username: uname(), sessionToken: uuid() }), status: 'active', joi: 'restoreSession', rateLimit: null, sentBy: both, examples: [{ username: 'alan', sessionToken: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ username: 'alan', sessionToken: 'not-a-uuid' }, { username: 'alan' }] },
    clientHello: {
        payload: open({
            client: str({ minLength: 1, maxLength: 16, pattern: '^[a-z0-9-]+$' }),
            version: str({ minLength: 1, maxLength: 32 }),
            build: str({ maxLength: 64 }),
            caps: arr(str({ minLength: 1, maxLength: 32 }), { maxItems: 16 }),
        }, { optional: ['build'] }),
        status: 'active', joi: 'clientHello', rateLimit: 'clientHello', sentBy: { web: false, ios: false },
        examples: [{ client: 'web', version: '1.0.0', build: 'abc1234', caps: ['avatarUrl'] }, { client: 'ios', version: '1.1.0', caps: [] }],
        invalid: [{ client: 'web', version: '1.0.0' }, { client: 'web', version: '1', caps: 'avatarUrl' }, { client: '', version: '1', caps: [] }, { client: 'Web!', version: '1', caps: [] }],
        notes: 'Sent on every connect by clients that read avatarUrl / avatarUrls ($defs.clientCap). No reply. Absent = legacy shape (the App Store iOS build, cached old web bundles). Unknown caps are ignored; the last hello wins (one without avatarUrl downgrades the socket). Over the rate limit it is dropped silently. Logged with the client version (telemetry for V1_REMOVALS).',
    },
    deleteAccount: { payload: open({ password: password() }), status: 'active', joi: 'deleteAccount', rateLimit: 'deleteAccount', sentBy: both, examples: [{ password: 'pw' }], invalid: [{ password: '' }, {}] },

    // Queue (no client sends these)
    joinQueue: { ...noPayload, status: 'unsent', joi: null, rateLimit: null, sentBy: nobody, examples: [{}], notes: 'Registered with safeHandler (no Joi, no rate limit). V1_REMOVALS #2.' },
    leaveQueue: { ...noPayload, status: 'unsent', joi: null, rateLimit: null, sentBy: nobody, examples: [{}], notes: 'Emits the deprecated queueUpdate. V1_REMOVALS #2.' },

    // Main room
    joinMainRoom: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    mainRoomChat: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'hi all' }], invalid: [{ message: '' }, { message: 'x'.repeat(501) }] },
    createLobby: { payload: open({ name: { type: ['string', 'null'], maxLength: 50 } }, { optional: ['name'] }), optionalPayload: true, status: 'active', joi: 'createLobby', rateLimit: 'createLobby', sentBy: both, examples: [{ name: 'Family night' }, {}], invalid: [{ name: 'x'.repeat(51) }, { name: 7 }] },
    joinLobby: { payload: open({ lobbyId: str() }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ lobbyId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], notes: 'No Joi schema yet (hardening: V1_REMOVALS #18).' },
    getLobbies: { ...noPayload, status: 'unsent', joi: null, rateLimit: null, sentBy: nobody, examples: [{}] },
    joinAsSpectator: { payload: open({ gameId: uuid() }), status: 'active', joi: 'joinAsSpectator', rateLimit: null, sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ gameId: 'x' }, {}] },

    // Lobby
    playerReady: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    playerUnready: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    lobbyChat: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'ready?' }], invalid: [{ message: '' }] },
    leaveLobby: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    addBot: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { personality: 'mary' }], notes: 'The handler ignores the payload; iOS sends {personality}.' },
    removeBot: { payload: open({ botSocketId: str() }), optionalPayload: true, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ botSocketId: 'bot:Bot:1' }], notes: 'iOS LobbyEmitter.removeBot sends no payload (the server answers error). No Joi schema yet.' },

    // Game
    draw: { payload: open({ num: int({ minimum: 0, maximum: 53 }) }), status: 'active', joi: 'draw', rateLimit: 'draw', sentBy: both, examples: [{ num: 0 }, { num: 53 }], invalid: [{ num: -1 }, { num: 54 }, { num: 99 }, { num: 1.5 }, {}] },
    playerBid: { payload: open({ bid: bidIn, position: ref('position') }), status: 'active', joi: 'playerBid', rateLimit: 'playerBid', sentBy: both, examples: [{ bid: '3', position: 2 }, { bid: 3, position: 2 }, { bid: 'B', position: 2 }], invalid: [{ bid: '3' }, { bid: 13, position: 1 }, { bid: '13', position: 1 }, { bid: '5B', position: 1 }, { bid: '3', position: 5 }, { bid: 2.5, position: 1 }], notes: 'Web sends a string; iOS an Int for numeric bids and a string for bores.' },
    playCard: { payload: open({ card: ref('cardIn'), position: ref('position') }), status: 'active', joi: 'playCard', rateLimit: 'playCard', sentBy: both, examples: [{ card: { suit: 'hearts', rank: 'A' }, position: 1 }, { card: { suit: 'joker', rank: 'HI', id: 'x', selected: true }, position: 3 }], invalid: [{ card: { suit: 'hearts', rank: 'A' } }, { card: { suit: 'hearts' }, position: 1 }, { card: { suit: 'stars', rank: 'A' }, position: 1 }, { card: { suit: 'hearts', rank: 'A' }, position: 0 }] },
    forceResign: { payload: open({ position: ref('position') }), status: 'active', joi: 'forceResign', rateLimit: null, sentBy: both, examples: [{ position: 2 }], invalid: [{ position: 0 }, { position: 5 }, {}] },
    chatMessage: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'nice' }, { message: '/lazy' }, { message: '/active' }, { message: '/leave' }], invalid: [{ message: '' }, { message: 'x'.repeat(501) }, {}], notes: '/lazy, /active and /leave are seat commands.' },
    rejoinGame: { payload: open({ gameId: uuid(), username: uname(), sessionToken: str({ minLength: 1, maxLength: 200 }) }, { optional: ['sessionToken'] }), status: 'active', joi: 'rejoinGame', rateLimit: null, sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: 'tok' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan' }], invalid: [{ gameId: 'x', username: 'alan' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: 't'.repeat(201) }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: '' }] },

    // Snapshot v2
    requestSnapshot: {
        payload: open({ requestId: anyOf(str({ minLength: 1, maxLength: 64 }), int()), customPics: { type: 'boolean' }, log: { type: 'boolean' } }, { optional: ['requestId', 'customPics', 'log'] }),
        optionalPayload: true, status: 'active', joi: 'requestSnapshot', rateLimit: 'requestSnapshot', sentBy: { web: false, ios: false },
        examples: [{}, { requestId: 'r1' }, { requestId: 7, customPics: false, log: false }], invalid: [{ requestId: 'x'.repeat(65) }, { requestId: '' }, { requestId: 1.5 }, { customPics: 'yes' }],
        notes: 'New in snapshot v2 (no shipped client sends it yet). Answered by stateSnapshot to this socket only.',
    },

    // Profile
    getProfile: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{}] },
    updateProfilePic: { payload: open({ profilePic: int({ minimum: 1, maximum: 82 }) }), status: 'active', joi: 'updateProfilePic', rateLimit: null, sentBy: webOnly, examples: [{ profilePic: 12 }], invalid: [{ profilePic: 0 }, { profilePic: 83 }, { profilePic: 500 }, {}] },
    uploadProfilePic: { payload: open({ imageData: str({ minLength: 1, maxLength: 682700 }) }), status: 'active', joi: 'uploadProfilePic', rateLimit: 'uploadProfilePic', notes: 'Pipeline on (docs/avatars.md): decoded and re-encoded server-side; stored as a WebP data URL <= 256 px; undecodable or unsafe images are refused with the usual {success:false, message}.', sentBy: webOnly, examples: [{ imageData: 'data:image/png;base64,iVBORw0KGgo=' }], invalid: [{}, { imageData: 5 }, { imageData: '' }] },
    getLeaderboard: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}], notes: 'Throttled in-handler (rateLimiter key getLeaderboard); over the limit replies leaderboardResponse with the cached (possibly stale) result, else the fill in flight, else the existing {success:false, message} reply; never error. Served from a 60 s cache invalidated on stats/picture/account changes.' },
    getRecords: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{}], notes: 'Throttled in-handler (rateLimiter key getRecords); over the limit replies recordsResponse with the cached (possibly stale) result, else the fill in flight, else the existing {success:false, message} reply; never error. Served from a 60 s cache (per month) invalidated when a game is recorded or an account deleted.' },
    searchPlayers: { payload: open({ query: str() }), status: 'active', joi: null, rateLimit: 'searchPlayers', sentBy: webOnly, examples: [{ query: 'al' }], notes: 'asyncHandler("searchPlayers") but validators has no schema: passes through with a warning. A trimmed query longer than 50 (the username max) short-circuits to an empty list in the handler.' },
    getPlayerProfile: { payload: open({ username: str() }), status: 'active', joi: null, rateLimit: 'getPlayerProfile', sentBy: webOnly, examples: [{ username: 'alan' }], notes: 'No Joi schema yet (passes through with a warning).' },

    // Tournament
    createTournament: { ...noPayload, status: 'active', joi: 'createTournament', rateLimit: 'createTournament', sentBy: both, examples: [{}] },
    joinTournament: { payload: open({ tournamentId: uuid() }), status: 'active', joi: 'joinTournament', rateLimit: 'joinTournament', sentBy: both, examples: [{ tournamentId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ tournamentId: 'x' }, {}] },
    leaveTournament: { ...noPayload, status: 'active', joi: 'leaveTournament', rateLimit: 'leaveTournament', sentBy: both, examples: [{}] },
    tournamentReady: { ...noPayload, status: 'active', joi: 'tournamentReady', rateLimit: 'tournamentReady', sentBy: both, examples: [{}] },
    tournamentUnready: { ...noPayload, status: 'active', joi: 'tournamentUnready', rateLimit: 'tournamentUnready', sentBy: both, examples: [{}] },
    beginTournament: { ...noPayload, status: 'active', joi: 'beginTournament', rateLimit: 'beginTournament', sentBy: both, examples: [{}] },
    beginNextRound: { ...noPayload, status: 'active', joi: 'beginNextRound', rateLimit: 'beginNextRound', sentBy: both, examples: [{}] },
    tournamentChat: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'gl' }], invalid: [{ message: '' }] },
    spectateTournament: { payload: open({ tournamentId: uuid() }), status: 'active', joi: 'spectateTournament', rateLimit: 'spectateTournament', sentBy: both, examples: [{ tournamentId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ tournamentId: 'x' }] },
    spectateTournamentGame: { payload: open({ gameId: uuid() }), status: 'active', joi: 'spectateTournamentGame', rateLimit: 'spectateTournamentGame', sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ gameId: 'x' }] },
    returnToTournament: { ...noPayload, status: 'active', joi: 'returnToTournament', rateLimit: 'returnToTournament', sentBy: both, examples: [{}] },
    cancelTournament: { ...noPayload, status: 'active', joi: 'cancelTournament', rateLimit: 'cancelTournament', sentBy: both, examples: [{}] },

    // Safety
    reportUser: { payload: open({ username: uname(), reason: message(), context: str({ maxLength: 1000 }) }, { optional: ['context'] }), status: 'active', joi: 'reportUser', rateLimit: 'reportUser', sentBy: both, examples: [{ username: 'x', reason: 'spam', context: '' }, { username: 'x', reason: 'spam' }], invalid: [{ username: 'x', reason: '' }, { username: 'x', reason: 'spam', context: 'c'.repeat(1001) }, { reason: 'spam' }] },
    blockUser: { payload: open({ username: uname() }), status: 'active', joi: 'blockUser', rateLimit: 'blockUser', sentBy: both, examples: [{ username: 'x' }], invalid: [{ username: '' }, {}] },
    unblockUser: { payload: open({ username: uname() }), status: 'active', joi: 'unblockUser', rateLimit: 'unblockUser', sentBy: both, examples: [{ username: 'x' }], invalid: [{ username: 'x'.repeat(51) }] },

    // Voice relays (no Joi yet: V1_REMOVALS #18)
    voiceOffer: { payload: open({ targetSocketId: str(), offer: open({}), username: str() }, { optional: ['username'] }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', offer: { type: 'offer', sdp: 'v=0' }, username: 'alan' }] },
    voiceAnswer: { payload: open({ targetSocketId: str(), answer: open({}) }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', answer: { type: 'answer', sdp: 'v=0' } }] },
    voiceIceCandidate: { payload: open({ targetSocketId: str(), candidate: open({}) }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', candidate: { candidate: 'candidate:1', sdpMLineIndex: 0, sdpMid: '0' } }] },
    voiceRelayAudio: { payload: open({ targetSocketId: str(), audio: { type: ['string', 'object', 'array'] } }), status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{ targetSocketId: 's1', audio: 'AAAA' }] },
};

// Silence an unused-import lint in editors
void bool; void iosOnly;

module.exports = { c2s };
