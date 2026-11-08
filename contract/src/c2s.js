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
 */

'use strict';

const { str, int, bool, enm, ref, anyOf, obj } = require('./defs');

const open = (props, o = {}) => obj(props, { ...o, open: true });
const none = open({});
const noPayload = { payload: none, optionalPayload: true };
const both = { web: true, ios: true };
const webOnly = { web: true, ios: false };
const iosOnly = { web: false, ios: true };
const nobody = { web: false, ios: false };
const bidIn = anyOf(int({ minimum: 0, maximum: 12 }), enm('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'B', '2B', '3B', '4B'));

const c2s = {
    // Auth
    signIn: { payload: open({ username: str(), password: str() }), status: 'active', joi: 'signIn', rateLimit: 'signIn', sentBy: both, examples: [{ username: 'alan', password: 'pw' }] },
    signUp: { payload: open({ username: str(), password: str() }), status: 'active', joi: 'signUp', rateLimit: 'signUp', sentBy: both, examples: [{ username: 'alan', password: 'pw' }] },
    restoreSession: { payload: open({ username: str(), sessionToken: str() }), status: 'active', joi: 'restoreSession', rateLimit: null, sentBy: both, examples: [{ username: 'alan', sessionToken: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }] },
    deleteAccount: { payload: open({ password: str() }), status: 'active', joi: 'deleteAccount', rateLimit: 'deleteAccount', sentBy: both, examples: [{ password: 'pw' }] },

    // Queue (no client sends these)
    joinQueue: { ...noPayload, status: 'unsent', joi: null, rateLimit: null, sentBy: nobody, examples: [{}], notes: 'Registered with safeHandler (no Joi, no rate limit). V1_REMOVALS #2.' },
    leaveQueue: { ...noPayload, status: 'unsent', joi: null, rateLimit: null, sentBy: nobody, examples: [{}], notes: 'Emits the deprecated queueUpdate. V1_REMOVALS #2.' },

    // Main room
    joinMainRoom: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    mainRoomChat: { payload: open({ message: str() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'hi all' }] },
    createLobby: { payload: open({ name: { type: ['string', 'null'] } }, { optional: ['name'] }), optionalPayload: true, status: 'active', joi: 'createLobby', rateLimit: 'createLobby', sentBy: both, examples: [{ name: 'Family night' }, {}] },
    joinLobby: { payload: open({ lobbyId: str() }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ lobbyId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], notes: 'No Joi schema yet (hardening: V1_REMOVALS #18).' },
    getLobbies: { ...noPayload, status: 'unsent', joi: null, rateLimit: null, sentBy: nobody, examples: [{}] },
    joinAsSpectator: { payload: open({ gameId: str() }), status: 'active', joi: 'joinAsSpectator', rateLimit: null, sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }] },

    // Lobby
    playerReady: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    playerUnready: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    lobbyChat: { payload: open({ message: str() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'ready?' }] },
    leaveLobby: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    addBot: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { personality: 'mary' }], notes: 'The handler ignores the payload; iOS sends {personality}.' },
    removeBot: { payload: open({ botSocketId: str() }), optionalPayload: true, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ botSocketId: 'bot:Bot:1' }], notes: 'iOS LobbyEmitter.removeBot sends no payload (the server answers error). No Joi schema yet.' },

    // Game
    draw: { payload: open({ num: int() }), status: 'active', joi: 'draw', rateLimit: 'draw', sentBy: both, examples: [{ num: 0 }, { num: 53 }] },
    playerBid: { payload: open({ bid: bidIn, position: ref('position') }, { optional: ['position'] }), status: 'active', joi: 'playerBid', rateLimit: 'playerBid', sentBy: both, examples: [{ bid: '3', position: 2 }, { bid: 3, position: 2 }, { bid: 'B', position: 2 }], notes: 'Web sends a string; iOS an Int for numeric bids and a string for bores.' },
    playCard: { payload: open({ card: ref('cardIn'), position: ref('position') }, { optional: ['position'] }), status: 'active', joi: 'playCard', rateLimit: 'playCard', sentBy: both, examples: [{ card: { suit: 'hearts', rank: 'A' }, position: 1 }, { card: { suit: 'joker', rank: 'HI', id: 'x', selected: true }, position: 3 }] },
    forceResign: { payload: open({ position: ref('position') }), status: 'active', joi: 'forceResign', rateLimit: null, sentBy: both, examples: [{ position: 2 }] },
    chatMessage: { payload: open({ message: str() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'nice' }, { message: '/lazy' }, { message: '/active' }, { message: '/leave' }], notes: '/lazy, /active and /leave are seat commands.' },
    rejoinGame: { payload: open({ gameId: str(), username: str(), sessionToken: str() }, { optional: ['sessionToken'] }), status: 'active', joi: 'rejoinGame', rateLimit: null, sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: 'tok' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan' }] },

    // Snapshot v2
    requestSnapshot: {
        payload: open({ requestId: anyOf(str({ maxLength: 64 }), int()), customPics: { type: 'boolean' }, log: { type: 'boolean' } }, { optional: ['requestId', 'customPics', 'log'] }),
        optionalPayload: true, status: 'active', joi: 'requestSnapshot', rateLimit: 'requestSnapshot', sentBy: { web: false, ios: false },
        examples: [{}, { requestId: 'r1' }, { requestId: 7, customPics: false, log: false }],
        notes: 'New in snapshot v2 (no shipped client sends it yet). Answered by stateSnapshot to this socket only.',
    },

    // Profile
    getProfile: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{}] },
    updateProfilePic: { payload: open({ profilePic: int() }), status: 'active', joi: 'updateProfilePic', rateLimit: null, sentBy: webOnly, examples: [{ profilePic: 12 }] },
    uploadProfilePic: { payload: open({ imageData: str() }), status: 'active', joi: 'uploadProfilePic', rateLimit: null, sentBy: webOnly, examples: [{ imageData: 'data:image/png;base64,iVBORw0KGgo=' }] },
    getLeaderboard: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    getRecords: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{}] },
    searchPlayers: { payload: open({ query: str() }), status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{ query: 'al' }], notes: 'asyncHandler("searchPlayers") but validators has no schema: passes through with a warning.' },
    getPlayerProfile: { payload: open({ username: str() }), status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{ username: 'alan' }], notes: 'No Joi schema yet (passes through with a warning).' },

    // Tournament
    createTournament: { ...noPayload, status: 'active', joi: 'createTournament', rateLimit: 'createTournament', sentBy: both, examples: [{}] },
    joinTournament: { payload: open({ tournamentId: str() }), status: 'active', joi: 'joinTournament', rateLimit: 'joinTournament', sentBy: both, examples: [{ tournamentId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }] },
    leaveTournament: { ...noPayload, status: 'active', joi: 'leaveTournament', rateLimit: 'leaveTournament', sentBy: both, examples: [{}] },
    tournamentReady: { ...noPayload, status: 'active', joi: 'tournamentReady', rateLimit: 'tournamentReady', sentBy: both, examples: [{}] },
    tournamentUnready: { ...noPayload, status: 'active', joi: 'tournamentUnready', rateLimit: 'tournamentUnready', sentBy: both, examples: [{}] },
    beginTournament: { ...noPayload, status: 'active', joi: 'beginTournament', rateLimit: 'beginTournament', sentBy: both, examples: [{}] },
    beginNextRound: { ...noPayload, status: 'active', joi: 'beginNextRound', rateLimit: 'beginNextRound', sentBy: both, examples: [{}] },
    tournamentChat: { payload: open({ message: str() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'gl' }] },
    spectateTournament: { payload: open({ tournamentId: str() }), status: 'active', joi: 'spectateTournament', rateLimit: 'spectateTournament', sentBy: both, examples: [{ tournamentId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }] },
    spectateTournamentGame: { payload: open({ gameId: str() }), status: 'active', joi: 'spectateTournamentGame', rateLimit: 'spectateTournamentGame', sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }] },
    returnToTournament: { ...noPayload, status: 'active', joi: 'returnToTournament', rateLimit: 'returnToTournament', sentBy: both, examples: [{}] },
    cancelTournament: { ...noPayload, status: 'active', joi: 'cancelTournament', rateLimit: 'cancelTournament', sentBy: both, examples: [{}] },

    // Safety
    reportUser: { payload: open({ username: str(), reason: str(), context: str() }, { optional: ['context'] }), status: 'active', joi: 'reportUser', rateLimit: 'reportUser', sentBy: both, examples: [{ username: 'x', reason: 'spam', context: '' }, { username: 'x', reason: 'spam' }] },
    blockUser: { payload: open({ username: str() }), status: 'active', joi: 'blockUser', rateLimit: 'blockUser', sentBy: both, examples: [{ username: 'x' }] },
    unblockUser: { payload: open({ username: str() }), status: 'active', joi: 'unblockUser', rateLimit: 'unblockUser', sentBy: both, examples: [{ username: 'x' }] },

    // Voice relays (no Joi yet: V1_REMOVALS #18)
    voiceOffer: { payload: open({ targetSocketId: str(), offer: open({}), username: str() }, { optional: ['username'] }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', offer: { type: 'offer', sdp: 'v=0' }, username: 'alan' }] },
    voiceAnswer: { payload: open({ targetSocketId: str(), answer: open({}) }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', answer: { type: 'answer', sdp: 'v=0' } }] },
    voiceIceCandidate: { payload: open({ targetSocketId: str(), candidate: open({}) }), status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', candidate: { candidate: 'candidate:1', sdpMLineIndex: 0, sdpMid: '0' } }] },
    voiceRelayAudio: { payload: open({ targetSocketId: str(), audio: { type: ['string', 'object', 'array'] } }), status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{ targetSocketId: 's1', audio: 'AAAA' }] },
};

// Silence an unused-import lint in editors
void bool; void iosOnly;

module.exports = { c2s };
