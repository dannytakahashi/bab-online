/**
 * Client -> server events, from server/socket/index.js registrations.
 *
 * Per event:
 *   payload          JSON Schema of what a client may send (open objects:
 *                    Joi stripUnknown drops extras, and the clients send some)
 *   optionalPayload  true when the client may send no payload at all
 *   status           active | unsent (handled, no client sends it) | deprecated
 *   joi              validators.schemas key the handler is wrapped with, or null
 *   joiInHandler     validators.schemas key the handler checks itself (voice
 *                    relays: a bad payload is dropped silently, never answered
 *                    with error), when `joi` is null
 *   rateLimit        rateLimiter.limits key that applies, or null
 *   sentBy           which shipped clients emit it
 *   examples         payloads real clients send (validated by contract.test.js)
 *   invalid          payloads the server rejects: each must fail BOTH this
 *                    schema and Joi (`joi` or `joiInHandler`), so a client
 *                    built from the schema never sends something Joi refuses
 */

'use strict';

const { str, int, bool, nul, enm, ref, anyOf, obj, arr } = require('./defs');
const { ADMIN_ACTIONS } = require('../../server/admin/actions');

const open = (props, o = {}) => obj(props, { ...o, open: true });
const none = open({});
const noPayload = { payload: none, optionalPayload: true };
// Stats scope (server/utils/statsScope.js, owner 2026-11-13): optional on the
// stats readers; missing, non-object or unknown = 'human' (today's reply)
const statsScope = () => enm('human', 'bots', 'all');
// getProfile / getLeaderboard / getRecords keep the open, property-less
// payload (like addBot): they have no Joi schema (joi null is frozen by the
// baseline, and every c2s payload WITH properties must have one: V1_REMOVALS
// #18), and the handler normalizes whatever comes, so `scope` is documented
// by the examples and notes rather than as a schema property
const scopePayload = noPayload;
const SCOPE_NOTE = 'Optional {scope: human | bots | all} (additive 2026-11-13): human = games with no bot or resign-bot seat at the end (users.stats, today\'s reply), bots = games with one (users.botStats, gameRecords withBots), all = both summed field by field. Missing, non-object or unknown = human, never refused. The reply echoes `scope` only when the request carried the key. iOS sends no payload (human).';
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
// '13' / 13 is legal on the 13-card hand only: Joi takes it, the handler's
// rules.isValidBid refuses it on a smaller hand (actionRejected invalid_bid)
const bidIn = anyOf(int({ minimum: 0, maximum: 13 }), enm('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', 'B', '2B', '3B', '4B'));

const c2s = {
    // Auth
    signIn: { payload: open({ username: uname(), password: password() }), status: 'active', joi: 'signIn', rateLimit: 'signIn', sentBy: both, examples: [{ username: 'alan', password: 'pw' }], invalid: [{ username: '', password: 'pw' }, { username: 'a'.repeat(51), password: 'pw' }, { username: 'alan' }] },
    signUp: { payload: open({ username: uname(), password: password() }), status: 'active', joi: 'signUp', rateLimit: 'signUp', sentBy: both, examples: [{ username: 'alan', password: 'pw' }], invalid: [{ username: 'alan', password: '' }, { username: 'alan', password: 'p'.repeat(101) }], notes: 'Two per-socket budgets. The wrapper limit rateLimiter.signUp (20 / 5 min) counts every attempt and over it replies error {type:\'rateLimit\'}. Refusals by the new-name rules, the profanity filter and the taken check spend only that; an attempt past them (bcrypt hash + insert) also spends rateLimiter.signUpAccount (3 / 5 min), checked in-handler, and over it gets signUpResponse {success:false, message}.' },
    restoreSession: { payload: open({ username: uname(), sessionToken: uuid() }), status: 'active', joi: 'restoreSession', rateLimit: null, sentBy: both, examples: [{ username: 'alan', sessionToken: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ username: 'alan', sessionToken: 'not-a-uuid' }, { username: 'alan' }] },
    clientHello: {
        payload: open({
            client: str({ minLength: 1, maxLength: 16, pattern: '^[a-z0-9-]+$' }),
            version: str({ minLength: 1, maxLength: 32 }),
            build: str({ maxLength: 64 }),
            caps: arr(str({ minLength: 1, maxLength: 32 }), { maxItems: 16 }),
        }, { optional: ['build'] }),
        status: 'active', joi: 'clientHello', rateLimit: 'clientHello', sentBy: both,
        examples: [{ client: 'web', version: '1.0.0', build: 'abc1234', caps: ['avatarUrl'] }, { client: 'ios', version: '1.2.0', build: '3', caps: ['avatarUrl'] }, { client: 'ios', version: '1.1.0', caps: [] }],
        invalid: [{ client: 'web', version: '1.0.0' }, { client: 'web', version: '1', caps: 'avatarUrl' }, { client: '', version: '1', caps: [] }, { client: 'Web!', version: '1', caps: [] }],
        notes: 'Sent on every connect by clients that read avatarUrl / avatarUrls ($defs.clientCap). No reply. Absent = legacy shape (iOS 1.1.0, cached old web bundles); iOS sends it from 1.2.0 (SocketService, on every connect before restoreSession). Unknown caps are ignored; the last hello wins (one without avatarUrl downgrades the socket). Over the rate limit it is dropped silently. Logged with the client version (telemetry for V1_REMOVALS).',
    },
    deleteAccount: { payload: open({ password: password() }), status: 'active', joi: 'deleteAccount', rateLimit: 'deleteAccount', sentBy: both, examples: [{ password: 'pw' }], invalid: [{ password: '' }, {}] },

    // (joinQueue / leaveQueue / getLobbies, the matchmaking queue no client
    // sent, were removed: V1_REMOVALS #2, 2026-11-11)

    // Main room
    joinMainRoom: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    mainRoomChat: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'hi all' }], invalid: [{ message: '' }, { message: 'x'.repeat(501) }] },
    createLobby: { payload: open({ name: { type: ['string', 'null'], maxLength: 50 } }, { optional: ['name'] }), optionalPayload: true, status: 'active', joi: 'createLobby', rateLimit: 'createLobby', sentBy: both, examples: [{ name: 'Family night' }, {}], invalid: [{ name: 'x'.repeat(51) }, { name: 7 }] },
    joinLobby: { payload: open({ lobbyId: uuid() }), status: 'active', joi: 'joinLobby', rateLimit: null, sentBy: both, examples: [{ lobbyId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ lobbyId: 'x' }, {}, { lobbyId: 7 }], notes: 'Joi since V1_REMOVALS #18 (2026-11-11): lobby ids are uuids (web MainRoom / ClientSession re-entry and iOS 1.1.0 LobbyEmitter.joinLobby send {lobbyId}).' },
    joinAsSpectator: { payload: open({ gameId: uuid() }), status: 'active', joi: 'joinAsSpectator', rateLimit: null, sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ gameId: 'x' }, {}] },

    // Lobby
    playerReady: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    playerUnready: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    lobbyChat: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'ready?' }], invalid: [{ message: '' }] },
    leaveLobby: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}] },
    addBot: { ...noPayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { personality: 'mary' }], notes: 'The handler ignores the payload; iOS sends {personality}.' },
    removeBot: { payload: open({ botSocketId: str({ minLength: 5, maxLength: 200, pattern: '^bot:' }) }), status: 'active', joi: 'removeBot', rateLimit: null, sentBy: both, examples: [{ botSocketId: 'bot:Bot:1' }, { botSocketId: 'bot:🤖 bot 2:00000000-0000-4000-8000-000000000003' }], invalid: [{}, { botSocketId: 'AbCdEfGhIjKlMnOpQrSt' }, { botSocketId: 'bot:' + 'x'.repeat(200) }], notes: 'Joi since V1_REMOVALS #18 (2026-11-11): a payload is required and only a bot id (bot:...) passes; GameManager.removeBotFromLobby also refuses a human member. Web (GameLobby) and iOS 1.1.0 (LobbyEmitter.removeBot) send {botSocketId}; only the gated 1.0.0 sent no payload.' },

    // Game
    draw: { payload: open({ num: int({ minimum: 0, maximum: 53 }) }), status: 'active', joi: 'draw', rateLimit: 'draw', sentBy: both, examples: [{ num: 0 }, { num: 53 }], invalid: [{ num: -1 }, { num: 54 }, { num: 99 }, { num: 1.5 }, {}] },
    playerBid: { payload: open({ bid: bidIn, position: ref('position') }), status: 'active', joi: 'playerBid', rateLimit: 'playerBid', sentBy: both, examples: [{ bid: '3', position: 2 }, { bid: 3, position: 2 }, { bid: 'B', position: 2 }, { bid: '13', position: 1 }, { bid: 13, position: 1 }], invalid: [{ bid: '3' }, { bid: 14, position: 1 }, { bid: '14', position: 1 }, { bid: '5B', position: 1 }, { bid: '3', position: 5 }, { bid: 2.5, position: 1 }], notes: 'Web sends a string; iOS an Int for numeric bids and a string for bores. 13 / \'13\' passes Joi (both clients offer 0...hand size) and is refused by the handler (actionRejected invalid_bid) unless the hand has 13 cards.' },
    playCard: { payload: open({ card: ref('cardIn'), position: ref('position') }), status: 'active', joi: 'playCard', rateLimit: 'playCard', sentBy: both, examples: [{ card: { suit: 'hearts', rank: 'A' }, position: 1 }, { card: { suit: 'joker', rank: 'HI', id: 'x', selected: true }, position: 3 }], invalid: [{ card: { suit: 'hearts', rank: 'A' } }, { card: { suit: 'hearts' }, position: 1 }, { card: { suit: 'stars', rank: 'A' }, position: 1 }, { card: { suit: 'hearts', rank: 'A' }, position: 0 }] },
    forceResign: { payload: open({ position: ref('position') }), status: 'active', joi: 'forceResign', rateLimit: null, sentBy: both, examples: [{ position: 2 }], invalid: [{ position: 0 }, { position: 5 }, {}] },
    chatMessage: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'nice' }, { message: '/lazy' }, { message: '/active' }, { message: '/leave' }], invalid: [{ message: '' }, { message: 'x'.repeat(501) }, {}], notes: '/lazy, /active and /leave are seat commands.' },
    rejoinGame: { payload: open({ gameId: uuid(), username: uname(), sessionToken: str({ minLength: 1, maxLength: 200 }) }, { optional: ['sessionToken'] }), status: 'active', joi: 'rejoinGame', rateLimit: null, sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: 'tok' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan' }], invalid: [{ gameId: 'x', username: 'alan' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: 't'.repeat(201) }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: '' }] },

    // Snapshot v2
    requestSnapshot: {
        payload: open({ requestId: anyOf(str({ minLength: 1, maxLength: 64 }), int()), customPics: { type: 'boolean' }, log: { type: 'boolean' } }, { optional: ['requestId', 'customPics', 'log'] }),
        optionalPayload: true, status: 'active', joi: 'requestSnapshot', rateLimit: 'requestSnapshot', sentBy: { web: true, ios: false },
        examples: [{}, { requestId: 'r1' }, { requestId: 7, customPics: false, log: false }], invalid: [{ requestId: 'x'.repeat(65) }, { requestId: '' }, { requestId: 1.5 }, { customPics: 'yes' }],
        notes: 'New in snapshot v2 (no shipped iOS client sends it yet). Answered by stateSnapshot to this socket only. Web always sends {requestId, customPics:false, log:false}: "ping-*" its liveness ping after the tab was hidden > 5 s (item 15; a reconnect only when no reply arrives), "gap-*" on a seq gap (debounced: one in flight), "ack-*" when its bid/play got no answer for 5 s (item 16); every reply with a snapshot of its table is applied and rendered.',
    },

    // Profile
    getProfile: { ...scopePayload, status: 'active', joi: null, rateLimit: null, sentBy: webOnly, examples: [{}, { scope: 'bots' }, { scope: 'all' }], notes: SCOPE_NOTE },
    updateProfilePic: { payload: open({ profilePic: int({ minimum: 1, maximum: 82 }) }), status: 'active', joi: 'updateProfilePic', rateLimit: null, sentBy: webOnly, examples: [{ profilePic: 12 }], invalid: [{ profilePic: 0 }, { profilePic: 83 }, { profilePic: 500 }, {}] },
    uploadProfilePic: { payload: open({ imageData: str({ minLength: 1, maxLength: 682700 }) }), status: 'active', joi: 'uploadProfilePic', rateLimit: 'uploadProfilePic', notes: 'Pipeline on (docs/avatars.md): decoded and re-encoded server-side; stored as a WebP data URL <= 256 px; undecodable or unsafe images are refused with the usual {success:false, message}.', sentBy: webOnly, examples: [{ imageData: 'data:image/png;base64,iVBORw0KGgo=' }], invalid: [{}, { imageData: 5 }, { imageData: '' }] },
    getLeaderboard: { ...scopePayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { scope: 'bots' }, { scope: 'all' }], notes: 'Throttled in-handler (rateLimiter key getLeaderboard, one budget for every scope); over the limit replies leaderboardResponse with that scope\'s cached (possibly stale) result, else its fill in flight, else the existing {success:false, message} reply; never error. Served from a 60 s cache per scope, every scope invalidated on stats/picture/account changes. ' + SCOPE_NOTE },
    getRecords: { ...scopePayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { scope: 'bots' }, { scope: 'all' }], notes: 'Throttled in-handler (rateLimiter key getRecords, one budget for every scope); over the limit replies recordsResponse with that scope\'s cached (possibly stale) result, else its fill in flight, else the existing {success:false, message} reply; never error. Served from a 60 s cache per scope (per month), every scope invalidated when a game is recorded or an account deleted. ' + SCOPE_NOTE },
    searchPlayers: { payload: open({ query: str({ maxLength: 500 }) }), status: 'active', joi: 'searchPlayers', rateLimit: 'searchPlayers', sentBy: webOnly, examples: [{ query: 'al' }, { query: '' }], invalid: [{}, { query: 5 }, { query: 'x'.repeat(501) }], notes: 'Joi since V1_REMOVALS #18 (2026-11-11). A blank query answers {success:false} and a trimmed query longer than 50 (the username max) an empty list, in the handler.' },
    getPlayerProfile: { payload: open({ username: str({ minLength: 1, maxLength: 100 }), scope: statsScope() }, { optional: ['scope'] }), status: 'active', joi: 'getPlayerProfile', rateLimit: 'getPlayerProfile', sentBy: webOnly, examples: [{ username: 'alan' }, { username: '🤖 Mary' }, { username: 'alan', scope: 'all' }], invalid: [{}, { username: '' }, { username: 'x'.repeat(101) }], notes: 'Joi since V1_REMOVALS #18 (2026-11-11). Web asks from search rows, seat avatars and opponent plates (dataset.username, a bot name included). ' + SCOPE_NOTE + ' Joi takes scope as any string up to 16 characters (lenient: the handler normalizes).' },

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

    // Voice relays (Joi checked in-handler since V1_REMOVALS #18: joiInHandler)
    voiceOffer: { payload: open({ targetSocketId: str({ minLength: 1, maxLength: 64 }), offer: open({ type: enm('offer', 'pranswer', 'answer', 'rollback'), sdp: str({ maxLength: 65536 }) }), username: { type: ['string', 'null'], maxLength: 100 } }, { optional: ['username'] }), status: 'active', joi: null, joiInHandler: 'voiceOffer', rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', offer: { type: 'offer', sdp: 'v=0' }, username: 'alan' }, { targetSocketId: 's1', offer: { type: 'offer', sdp: 'v=0' }, username: '' }], invalid: [{ targetSocketId: '', offer: { type: 'offer', sdp: 'v=0' } }, { targetSocketId: 's1', offer: { type: 'bogus', sdp: 'v=0' } }, { targetSocketId: 's1', offer: { type: 'offer' } }, { targetSocketId: 's1', offer: { type: 'offer', sdp: 'x'.repeat(65537) } }, { targetSocketId: 'x'.repeat(65), offer: { type: 'offer', sdp: 'v=0' } }], notes: 'Forwarded only to a connected socket id (never a room) of a signed-in peer in the sender\'s lobby or game (entrant / seat owner; not a pure spectator), when neither user blocked the other, within the per-socket limit rateLimiter.voiceOffer (30 / 10 s), and when the payload passes validators.schemas.voiceOffer (joiInHandler, V1_REMOVALS #18), all checked in-handler; anything else is dropped silently (no reply, never error). iOS 1.1.0 sends username "" when it has none; the server forwards its own name.' },
    voiceAnswer: { payload: open({ targetSocketId: str({ minLength: 1, maxLength: 64 }), answer: open({ type: enm('offer', 'pranswer', 'answer', 'rollback'), sdp: str({ maxLength: 65536 }) }) }), status: 'active', joi: null, joiInHandler: 'voiceAnswer', rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', answer: { type: 'answer', sdp: 'v=0' } }], invalid: [{ targetSocketId: 's1' }, { targetSocketId: 's1', answer: { type: 'answer', sdp: 7 } }, { targetSocketId: 7, answer: { type: 'answer', sdp: 'v=0' } }], notes: 'Forwarded only to a connected socket id (never a room) of a signed-in peer in the sender\'s lobby or game (entrant / seat owner; not a pure spectator), when neither user blocked the other, within the per-socket limit rateLimiter.voiceAnswer (30 / 10 s), and when the payload passes validators.schemas.voiceAnswer (joiInHandler, V1_REMOVALS #18), all checked in-handler; anything else is dropped silently (no reply, never error).' },
    voiceIceCandidate: { payload: open({ targetSocketId: str({ minLength: 1, maxLength: 64 }), candidate: open({ candidate: str({ maxLength: 4096 }), sdpMLineIndex: { type: ['integer', 'null'], minimum: 0, maximum: 1024 }, sdpMid: { type: ['string', 'null'], maxLength: 256 }, usernameFragment: { type: ['string', 'null'], maxLength: 256 } }, { optional: ['sdpMLineIndex', 'sdpMid', 'usernameFragment'] }) }), status: 'active', joi: null, joiInHandler: 'voiceIceCandidate', rateLimit: null, sentBy: both, examples: [{ targetSocketId: 's1', candidate: { candidate: 'candidate:1', sdpMLineIndex: 0, sdpMid: '0' } }, { targetSocketId: 's1', candidate: { candidate: 'candidate:1', sdpMLineIndex: 0, sdpMid: '0', usernameFragment: 'abcd' } }, { targetSocketId: 's1', candidate: { candidate: '', sdpMLineIndex: null, sdpMid: null } }], invalid: [{ targetSocketId: 's1', candidate: {} }, { targetSocketId: 's1', candidate: { candidate: 'c', sdpMLineIndex: -1 } }, { targetSocketId: 's1', candidate: { candidate: 'x'.repeat(4097) } }], notes: 'Forwarded only to a connected socket id (never a room) of a signed-in peer in the sender\'s lobby or game (entrant / seat owner; not a pure spectator), when neither user blocked the other, within the per-socket limit rateLimiter.voiceIceCandidate (300 / 10 s), and when the payload passes validators.schemas.voiceIceCandidate (joiInHandler, V1_REMOVALS #18), all checked in-handler; anything else is dropped silently (no reply, never error). Web sends RTCIceCandidate.toJSON() (usernameFragment, nulls), iOS 1.1.0 {candidate, sdpMLineIndex, sdpMid} ("" for a nil sdpMid).' },
    getVoiceIceServers: {
        payload: open({ requestId: str({ minLength: 1, maxLength: 64 }) }, { optional: ['requestId'] }),
        optionalPayload: true, status: 'active', joi: 'getVoiceIceServers', rateLimit: 'getVoiceIceServers', sentBy: both,
        examples: [{}, { requestId: 'ice-1' }],
        invalid: [{ requestId: '' }, { requestId: 'x'.repeat(65) }, { requestId: 7 }],
        notes: 'Answered by voiceIceServers to this socket only (requestId echoed). Web asks before its first peer connection of a voice session and again before the credentials expire. TURN credentials (Cloudflare Realtime, minted server-side, cached per user) only for a signed-in socket that is a voice peer now (in a lobby, or an entrant / seat owner of a game); everyone else, and every failure (env unset, Cloudflare timeout or error), gets the public STUN servers. iOS 1.1.0 does not send it (it hard-codes STUN); iOS 1.2.0 asks on every voice start and before its restart (Voice/IceServerStore.swift; V1_REMOVALS "iOS TURN").',
    },

    // Admin panel (web only; the iOS app never sends it)
    adminRequest: {
        payload: open({
            requestId: str({ minLength: 1, maxLength: 64 }),
            action: enm(...ADMIN_ACTIONS),
            args: open({}),
        }, { optional: ['args'] }),
        status: 'active', joi: 'adminRequest', rateLimit: 'adminRequest', sentBy: webOnly,
        examples: [
            { requestId: 'adm-1', action: 'searchPlayers', args: { query: 'alan' } },
            { requestId: 'adm-2', action: 'listAdmins' },
            { requestId: 'adm-4', action: 'listPlayers', args: {} },
            { requestId: 'adm-5', action: 'deleteAccount', args: { username: 'keyprobe00001', confirm: 'keyprobe00001' } },
            { requestId: 'adm-6', action: 'renameAccount', args: { username: 'alan2', newName: 'Alan T', confirm: 'Alan T' } },
            { requestId: 'adm-3', action: 'applyMerge', args: { target: 'Alan', sources: ['alan2'], planHash: 'a'.repeat(64), confirm: 'Alan' } },
        ],
        invalid: [{ requestId: '', action: 'listAdmins' }, { requestId: 'a', action: 'dropDatabase' }, { action: 'listAdmins' }, { requestId: 'a', action: 'listAdmins', args: 'x' }, { requestId: 'x'.repeat(65), action: 'listAdmins' }],
        notes: 'The admin panel (server/socket/adminHandlers.js). Answered by adminResponse to this socket only (requestId and action echoed). Authorized on EVERY request against the database (signed in, the account\'s current socket, its session still live, not a merged tombstone, isAdmin true); anyone else gets {ok:false, error:\'forbidden\'} for every action and target, before args are read, so a non-admin learns nothing. args are validated per action after that (adminHandlers ACTION_SCHEMAS; invalid -> {ok:false, error:\'invalid\'}). Each request writes one adminAudit entry (listAudit excepted). Wrapper limit 60/min (error {type:\'rateLimit\'}).',
    },
};

// Silence an unused-import lint in editors
void bool; void iosOnly;

module.exports = { c2s };
