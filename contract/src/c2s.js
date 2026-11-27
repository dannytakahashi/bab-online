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

const { str, int, bool, nul, enm, ref, anyOf, obj, arr, orNull } = require('./defs');
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
    signUp: { payload: open({ username: uname(), password: password() }), status: 'active', joi: 'signUp', rateLimit: 'signUp', sentBy: both, examples: [{ username: 'alan', password: 'pw' }], invalid: [{ username: 'alan', password: '' }, { username: 'alan', password: 'p'.repeat(101) }], notes: 'Two per-socket budgets. The wrapper limit rateLimiter.signUp (20 / 5 min) counts every attempt and over it replies error {type:\'rateLimit\'}. Refusals by the new-name rules, the profanity filter and the taken check spend only that; an attempt past them (bcrypt hash + insert) also spends rateLimiter.signUpAccount (3 / 5 min), checked in-handler, and over it gets signUpResponse {success:false, message}. The same attempt also spends budgets a reconnect does not reset (rateLimiter.buckets, all checked before any is spent, and before signUpAccount): signUpIp per client IP, an IPv6 address by its /64 (5 at once, then 5 an hour; skipped when the IP is unknown), signUpNet48 per IPv6 /48 (10 at once, then 10 an hour) and signUpGlobal for the whole server (20 at once, then 60 an hour); over any of them it gets signUpResponse {success:false, message} too.' },
    restoreSession: { payload: open({ username: uname(), sessionToken: uuid() }), status: 'active', joi: 'restoreSession', rateLimit: 'restoreSession', sentBy: both, examples: [{ username: 'alan', sessionToken: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ username: 'alan', sessionToken: 'not-a-uuid' }, { username: 'alan' }], notes: 'Wrapper limit 10 / min per socket (every reconnect is a new socket, so it never meets a flaky network); over it serverError {code:\'rateLimit\'}, never a restoreSessionResponse failure, which makes iOS forget its saved token.' },
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
        notes: 'Sent on every connect by clients that read avatarUrl / avatarUrls ($defs.clientCap). No reply. Absent = legacy shape (iOS 1.1.0, cached old web bundles); iOS sends it from 1.2.0 (SocketService, on every connect before restoreSession). Unknown caps are ignored; the last hello wins (one without avatarUrl downgrades the socket). Over the rate limit it is dropped silently. Logged with the client version (telemetry for V1_REMOVALS). Caps the server acts on: avatarUrl, casualSpectators, playAgain, assist, tutorial (2026-11-19: the client renders the tutorial\'s tips and assistState, and only such a socket gets the tutorial\'s auto-start; $defs.clientCapTutorial), shoulderView (2026-11-21: the over-the-shoulder view, watchHand and every shoulder key; without it none is sent, and a hello that drops it ends the socket\'s watch; $defs.clientCapShoulderView), and tournamentVoice (2026-11-24: the client starts voice on its tournament lobby screen and at a tournament table, so it is a peer of the tournament\'s voice room and announced at its table\'s seating; without it a socket is never listed in the tournament room; $defs.clientCapTournamentVoice), and tournamentPairings (2026-11-25: the client shows the tournament events\' pairings and, at a tournament table, startDraw.teams / snapshot draw.teams as a draw for first deal; every tournament table draws honestly, each player the card they picked, whoever is there (no staged draw once the upgrade gate requires iOS build 41); $defs.clientCapTournamentPairings), getYourBid (2026-11-24: the Get Your Bid mode; $defs.clientCapGetYourBid) and tournamentVoiceStatus (2026-11-25: the client renders the over-cap notice s2c tournamentVoiceStatus for a member waiting in line for a full tournament voice room; $defs.clientCapTournamentVoiceStatus).',
    },
    changePassword: {
        payload: open({ current: password(), next: password() }), status: 'active', joi: 'changePassword', rateLimit: 'changePassword', sentBy: webOnly,
        examples: [{ current: 'old password', next: 'new password 1' }],
        invalid: [{ current: 'old password' }, { current: '', next: 'new password 1' }, { current: 'old password', next: 'n'.repeat(101) }],
        notes: 'New (2026-11-15). The signed-in socket\'s own account only. Answered by changePasswordResponse {success, message}. next must be 8-100 characters and differ from current (checked in the handler, so Joi stays 1-100 and a short one gets the rule message); the current-password check counts in the failed-sign-in throttle like deleteAccount\'s. On success every saved session but this device\'s is revoked, every other live socket of the account gets forceLogout, and open reset links are cancelled. Rate limit 5 / 5 min per socket. Web: profile page, Change password. iOS: Account sheet, Change Password, from the next build after 1.2.1 build 9 (sentBy says what shipped clients send).',
    },
    clientError: {
        payload: open({
            kind: str({ pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,31}$' }),
            message: str({ minLength: 1, maxLength: 500 }),
            stack: str({ maxLength: 4000 }),
            where: str({ maxLength: 200 }),
            build: str({ maxLength: 64 }),
            page: str({ maxLength: 32, pattern: '^[A-Za-z0-9_.:-]*$' }),
        }, { optional: ['stack', 'where', 'build', 'page'] }),
        status: 'active', joi: null, joiInHandler: 'clientError', rateLimit: null, sentBy: both,
        examples: [
            { kind: 'error', message: "TypeError: Cannot read properties of undefined (reading 'x')", stack: 'at f (https://babonline.io/dist/assets/main-AbCd1234.js:1:23456)', where: 'main-AbCd1234.js:1:23456', build: 'abc1234', page: 'TABLE' },
            { kind: 'unhandledrejection', message: 'NotAllowedError: play() failed', build: 'abc1234', page: 'MAIN_ROOM' },
            { kind: 'decode', message: 'stateSnapshot undecodable: keyNotFound snapshot.watching', where: 'stateSnapshot', build: '10', page: 'game' },
            { kind: 'seqGap', message: 'expected 12, got 14' },
        ],
        invalid: [{ message: 'x' }, { kind: 'error' }, { kind: 'error', message: '' }, { kind: 'bad kind!', message: 'x' }, { kind: 'error', message: 'x'.repeat(501) }, { kind: 'error', message: 'x', stack: 's'.repeat(4001) }, { kind: 'error', message: 'x', page: 'a/b?c' }, { kind: 'error', message: 'x', where: 7 }],
        notes: 'Additive 2026-11-15: a short technical report of a client-side error (server/socket/clientErrorHandlers.js). Never answered, never serverError: a payload Joi refuses, a report over a limit and every report while CLIENT_ERRORS=off are dropped silently. Limits: 5 a minute and 50 a day per socket, plus per-IP and server-wide buckets (rateLimiter.buckets clientErrorIp / clientErrorGlobal). Logged at warn with the signed-in username and every text field scrubbed (URL queries and fragments, emails, ids, long digit runs, IPs, quoted text), never chat. Web sends it (client/src/telemetry/clientErrors.js: uncaught errors, unhandled rejections, SeqGate gaps, TableDirector failures, illegal screen transitions; once per kind per session, only while connected, a few buffered before). iOS sends it from the build after 1.2.1 build 9 (ErrorReporter.swift: undecodable table events and snapshots, the unreadable table, seq gaps, unexpected socket errors, an uncaught exception saved and sent on the next launch); 1.2.0 through 1.2.1 build 9 never send it.',
    },
    deleteAccount: { payload: open({ password: password() }), status: 'active', joi: 'deleteAccount', rateLimit: 'deleteAccount', sentBy: both, examples: [{ password: 'pw' }], invalid: [{ password: '' }, {}], notes: 'The password check also counts in the failed-sign-in throttle (server/socket/signInThrottle.js: per username / IP across sockets); throttled, it answers deleteAccountResponse {success:false, message} before any hash.' },

    // (joinQueue / leaveQueue / getLobbies, the matchmaking queue no client
    // sent, were removed: V1_REMOVALS #2, 2026-11-11)

    // Main room
    joinMainRoom: { ...noPayload, status: 'active', joi: null, rateLimit: 'joinMainRoom', sentBy: both, examples: [{}] },
    mainRoomChat: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'hi all' }], invalid: [{ message: '' }, { message: 'x'.repeat(501) }] },
    createLobby: { payload: open({ name: { type: ['string', 'null'], maxLength: 50 }, mode: enm('classic', 'gyb') }, { optional: ['name', 'mode'] }), optionalPayload: true, status: 'active', joi: 'createLobby', rateLimit: 'createLobby', sentBy: both, notes: 'mode (additive 2026-11-24; the web sends it, and iOS from 1.2.7 (42)): gyb opens a Get Your Bid lobby (3 seats, no teams; server/game/gameMode.js), only from a socket that sent the clientHello cap getYourBid (else serverError); absent or classic is the base game.', examples: [{ name: 'Family night' }, {}, { name: 'Three of us', mode: 'gyb' }], invalid: [{ name: 'x'.repeat(51) }, { name: 7 }] },
    joinLobby: { payload: open({ lobbyId: uuid() }), status: 'active', joi: 'joinLobby', rateLimit: 'joinLobby', sentBy: both, examples: [{ lobbyId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ lobbyId: 'x' }, {}, { lobbyId: 7 }], notes: 'Joi since V1_REMOVALS #18 (2026-11-11): lobby ids are uuids (web MainRoom / ClientSession re-entry and iOS 1.1.0 LobbyEmitter.joinLobby send {lobbyId}).' },
    joinAsSpectator: { payload: open({ gameId: uuid() }), status: 'active', joi: 'joinAsSpectator', rateLimit: 'joinAsSpectator', sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ gameId: 'x' }, {}] },

    // Lobby
    playerReady: { ...noPayload, status: 'active', joi: null, rateLimit: 'playerReady', sentBy: both, examples: [{}] },
    playerUnready: { ...noPayload, status: 'active', joi: null, rateLimit: 'playerUnready', sentBy: both, examples: [{}] },
    lobbyChat: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'ready?' }], invalid: [{ message: '' }] },
    leaveLobby: { ...noPayload, status: 'active', joi: null, rateLimit: 'leaveLobby', sentBy: both, examples: [{}] },
    addBot: { ...noPayload, status: 'active', joi: null, rateLimit: 'addBot', sentBy: both, examples: [{}, { personality: 'mary' }], notes: 'The handler ignores the payload; iOS sends {personality}.' },
    setSpectatorsCanTalk: {
        payload: open({ spectatorsCanTalk: bool() }), status: 'active', joi: 'setSpectatorsCanTalk', rateLimit: 'setSpectatorsCanTalk', sentBy: iosOnly,
        examples: [{ spectatorsCanTalk: false }, { spectatorsCanTalk: true }],
        invalid: [{}, { spectatorsCanTalk: 'no' }, { spectatorsCanTalk: 1 }],
        notes: 'New (2026-11-16, family lobbies); IGNORED since 2026-11-18 (owner: "we don\'t need the spectator voice host toggle, just having it default on is good"): spectators always may talk, so nothing changes it. Sent by iOS 1.2.2 (build 12) to 1.2.3 (build 15) (the lobby host\'s Toggle, GameLobbyView, and the in-game switch in the voice panel while voiceSettings.canChange, VoicePanelSheet; LobbyEmitter.setSpectatorsCanTalk) and by web bundles cached from before that day; neither the web nor later iOS builds have the switch. Accepted from anyone and answered with the unchanged settings, never an error (that echo repeats the value the client already holds, which those builds do not take as the answer: an old lobby Toggle switched off shows Off, disabled, until its own 5 s echo timeout puts it back On; sending false first would only flash it): in a lobby a playerReadyUpdate (the plain variant, settings {spectatorsCanTalk: true}) to the sender only (it still counts as acting in the lobby: play again settles it); in a casual game the sender\'s voiceSettings (spectatorsCanTalk true, canChange false); anywhere else nothing (debug log). Wrapper limit 4 / 30 s per socket (an over-limit send still gets serverError rateLimit).',
    },
    releaseLobbyHold: {
        payload: open({ username: str({ minLength: 1, maxLength: 32 }) }), status: 'active', joi: 'releaseLobbyHold', rateLimit: 'releaseLobbyHold', sentBy: both,
        examples: [{ username: 'grandma' }],
        invalid: [{}, { username: '' }, { username: 'x'.repeat(33) }, { username: 7 }],
        notes: 'New (2026-11-16, play again). Web sends it (GameLobby: "Don\'t wait" on a row marked members[].returning or an expected name, shown to the host, or to anyone present while the host is away); iOS from 1.2.2 (build 12): "Don\'t wait for <name>" on a returning row or an expected name of the lobby (GameLobbyView; LobbyEmitter.releaseLobbyHold), shown to the host, or to anyone present while the host is held. "Don\'t wait for <name>" in a lobby reopened after a game (server/socket/playAgain.js): releases that user\'s hold (a row marked members[].returning) or reservation (expected) at once, as its expiry would: a leave that keeps everyone\'s ready flags. The lobby host only; while the host is away (held), any present member. Anyone else, a socket in no lobby, or a name with nothing held: serverError {code: \'rejected\'}. Wrapper limit 10 / 30 s per socket.',
    },
    lobbyReturnSeen: {
        ...noPayload, status: 'active', joi: null, rateLimit: 'lobbyReturnSeen', sentBy: both,
        examples: [{}],
        notes: 'New (2026-11-16, play again; additive). Sent when the person leaves the last game\'s results for the lobby lobbyReturn kept behind them, i.e. whenever the client puts that lobby on screen. iOS from 1.2.2 (build 12): LobbyReturn.enter, from GameEndView\'s Return to Lobby, its own entry when that game\'s gameEnd never applied within 5 s, and a lobbyReturn that arrived off the table (main room, lobby screen). Web (main.js returnToReopenedLobby -> ClientSession.returnToReopenedLobby, then its joinLobby): the score modal\'s Return to Lobby landing in that lobby, its only entry (its seq gate applies a held gameEnd within 5 s, GAP_TIMEOUT_MS, so the modal always comes; a lobbyReturn in the main room leaves that lobby instead; one that started its next game meanwhile lands in the main room, already out of it). The results stay up until that tap (owner 2026-11-16), so without it the server cannot tell the score screen from the lobby screen: the socket stays in lobby.afterGame.unsettled until it acts in the lobby. Settles it (server/socket/playAgain.js lobbyReturnSeen -> settle): a later drop is the ordinary 30 s reload grace (no "Not back yet" hold), another socket of the same user no longer takes the seat on its joinMainRoom (autoClaimTarget), and at the next start it is an extra like any member (an unsettled one gets leftLobby instead of spectatorJoined: GameManager.startGameFromLobby onResults, playAgain.leftOnResults). No reply; when it settled the socket, the lobby\'s other capable members get a playerReadyUpdate (neither) whose members no longer mark its row onResults ("Still on the results", additive 2026-11-16: playAgain.announceSettled); a socket in no lobby, or already settled, changes nothing. Wrapper limit 10 / 30 s per socket.',
    },
    removeBot: { payload: open({ botSocketId: str({ minLength: 5, maxLength: 200, pattern: '^bot:' }) }), status: 'active', joi: 'removeBot', rateLimit: null, sentBy: both, examples: [{ botSocketId: 'bot:Bot:1' }, { botSocketId: 'bot:🤖 bot 2:00000000-0000-4000-8000-000000000003' }], invalid: [{}, { botSocketId: 'AbCdEfGhIjKlMnOpQrSt' }, { botSocketId: 'bot:' + 'x'.repeat(200) }], notes: 'Joi since V1_REMOVALS #18 (2026-11-11): a payload is required and only a bot id (bot:...) passes; GameManager.removeBotFromLobby also refuses a human member. Web (GameLobby) and iOS 1.1.0 (LobbyEmitter.removeBot) send {botSocketId}; only the gated 1.0.0 sent no payload.' },

    // Game
    draw: { payload: open({ num: int({ minimum: 0, maximum: 53 }) }), status: 'active', joi: 'draw', rateLimit: 'draw', sentBy: both, examples: [{ num: 0 }, { num: 53 }], invalid: [{ num: -1 }, { num: 54 }, { num: 99 }, { num: 1.5 }, {}] },
    playerBid: { payload: open({ bid: bidIn, position: ref('position') }), status: 'active', joi: 'playerBid', rateLimit: 'playerBid', sentBy: both, examples: [{ bid: '3', position: 2 }, { bid: 3, position: 2 }, { bid: 'B', position: 2 }, { bid: '13', position: 1 }, { bid: 13, position: 1 }], invalid: [{ bid: '3' }, { bid: 14, position: 1 }, { bid: '14', position: 1 }, { bid: '5B', position: 1 }, { bid: '3', position: 5 }, { bid: 2.5, position: 1 }], notes: 'Web sends a string; iOS an Int for numeric bids and a string for bores. 13 / \'13\' passes Joi (both clients offer 0...hand size) and is refused by the handler (actionRejected invalid_bid) unless the hand has 13 cards.' },
    playCard: { payload: open({ card: ref('cardIn'), position: ref('position') }), status: 'active', joi: 'playCard', rateLimit: 'playCard', sentBy: both, examples: [{ card: { suit: 'hearts', rank: 'A' }, position: 1 }, { card: { suit: 'joker', rank: 'HI', id: 'x', selected: true }, position: 3 }], invalid: [{ card: { suit: 'hearts', rank: 'A' } }, { card: { suit: 'hearts' }, position: 1 }, { card: { suit: 'stars', rank: 'A' }, position: 1 }, { card: { suit: 'hearts', rank: 'A' }, position: 0 }] },
    forceResign: { payload: open({ position: ref('position') }), status: 'active', joi: 'forceResign', rateLimit: null, sentBy: both, examples: [{ position: 2 }], invalid: [{ position: 0 }, { position: 5 }, {}] },
    chatMessage: { payload: open({ message: message() }), status: 'active', joi: 'chatMessage', rateLimit: 'chatMessage', sentBy: both, examples: [{ message: 'nice' }, { message: '/lazy' }, { message: '/active' }, { message: '/leave' }, { message: '/help' }, { message: '?help' }], invalid: [{ message: '' }, { message: 'x'.repeat(501) }, {}], notes: '/lazy, /active and /leave are seat commands. /help (2026-11-18) and the exact line ?help (any case, surrounding spaces ignored: the only way shipped iOS builds can ask, since they refuse unknown / commands on the device) ask for a suggestion (server/socket/assistHandlers.js): never broadcast or stored as chat; the reply is private (s2c assistHint with the clientHello cap assist, else private gameLogEntry lines), and a counted use posts the room line "<name> used /help.". "?help me" is ordinary chat.' },
    rejoinGame: { payload: open({ gameId: uuid(), username: uname(), sessionToken: str({ minLength: 1, maxLength: 200 }) }, { optional: ['sessionToken'] }), status: 'active', joi: 'rejoinGame', rateLimit: 'rejoinGame', sentBy: both, examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: 'tok' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan' }], invalid: [{ gameId: 'x', username: 'alan' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: 't'.repeat(201) }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', username: 'alan', sessionToken: '' }] },

    // Over-the-shoulder view (2026-11-21)
    watchHand: {
        payload: open({ gameId: uuid(), position: orNull(ref('position')), requestId: anyOf(str({ minLength: 1, maxLength: 64 }), int()) }, { optional: ['requestId'] }),
        status: 'active', joi: 'watchHand', rateLimit: 'watchHand', sentBy: { web: true, ios: true },
        examples: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: 2 }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: null }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: 4, requestId: 'w1' }],
        invalid: [{ gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: 0 }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: 5 }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: '2' }, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }, { gameId: 'x', position: 1 }, { position: 1 }],
        notes: 'New (2026-11-21, the over-the-shoulder view). Web sends it from 2026-11-21 (client/src/state/shoulder.js: the default watch after each full state, an avatar click, Table view; iOS from the build after 1.2.3 (30): State/Table/Shoulder.swift, the same rules, ActionCoordinator sends it). A pure spectator with the clientHello cap shoulderView watches seat `position` (1-4) read-only, or stops (null). Accepted: stateSnapshot {snapshot, reason: \'watchHand\', requestId?} (viewer.shoulder while watching), then the table\'s coalesced spectatorsUpdated; every later deal\'s spectator gameStart carries shoulder, and the watched seat\'s hints come as assistHint {watched}. Refused: watchHandRefused {gameId, position, reason, message, ownPosition?}. From a socket without the cap it is dropped silently (no reply). The watch is never saved and goes with the socket\'s spectator entry: re-send it after a spectatorJoined full state without viewer.shoulder (a reconnect on a new socket, spectating another game and back, a deploy-survival adoption); re-spectating the same game from the same socket keeps it, and re-sending watchHand is idempotent. A stop (null) is always done (no reply while the table is suspended or frozen); after an unavailable refusal keep the selection and re-send after "Game resumed." or the next full state. docs/claude/spectators.md "Over-the-shoulder view".',
    },

    // Snapshot v2
    requestSnapshot: {
        payload: open({ requestId: anyOf(str({ minLength: 1, maxLength: 64 }), int()), customPics: { type: 'boolean' }, log: { type: 'boolean' } }, { optional: ['requestId', 'customPics', 'log'] }),
        optionalPayload: true, status: 'active', joi: 'requestSnapshot', rateLimit: 'requestSnapshot', sentBy: { web: true, ios: false },
        examples: [{}, { requestId: 'r1' }, { requestId: 7, customPics: false, log: false }], invalid: [{ requestId: 'x'.repeat(65) }, { requestId: '' }, { requestId: 1.5 }, { customPics: 'yes' }],
        notes: 'New in snapshot v2. Answered by stateSnapshot to this socket only. customPics is accepted and ignored since V1_REMOVALS #19 C (no snapshot carries an inline picture; web and iOS 1.2.0 send customPics:false). Web always sends {requestId, customPics:false, log:false}: "ping-*" its liveness ping after the tab was hidden > 5 s (item 15; a reconnect only when no reply arrives), "gap-*" on a seq gap (debounced: one in flight), "ack-*" when its bid/play got no answer for 5 s (item 16); every reply with a snapshot of its table is applied and rendered.',
    },

    // Profile
    getProfile: { ...scopePayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { scope: 'bots' }, { scope: 'all' }], notes: 'iOS from 1.2.2 (build 10): the own profile in the Account sheet; it always sends {scope} (human included), so every success carries the echo. Throttled in-handler (rateLimiter key getProfile, 20 / 10 s per socket); over the limit serverError {code:\'rateLimit\', handler:\'getProfile\'}, as the wrappers answer. ' + SCOPE_NOTE },
    updateProfilePic: { payload: open({ profilePic: int({ minimum: 1, maximum: 82 }) }), status: 'active', joi: 'updateProfilePic', rateLimit: 'updateProfilePic', sentBy: both, examples: [{ profilePic: 12 }], invalid: [{ profilePic: 0 }, { profilePic: 83 }, { profilePic: 500 }, {}], notes: 'iOS from 1.2.2 (build 10): Account sheet, Choose Avatar. Answered by profilePicUpdateResponse.' },
    uploadProfilePic: { payload: open({ imageData: str({ minLength: 1, maxLength: 682700 }) }), status: 'active', joi: 'uploadProfilePic', rateLimit: 'uploadProfilePic', notes: 'iOS from 1.2.2 (build 10): Account sheet, Upload Photo (a 200 px PNG data URL, cropped to a circle with 16% padding like the web\'s). Pipeline on (docs/avatars.md): decoded and re-encoded server-side; stored as a WebP data URL <= 256 px; undecodable or unsafe images are refused with the usual {success:false, message}.', sentBy: both, examples: [{ imageData: 'data:image/png;base64,iVBORw0KGgo=' }], invalid: [{}, { imageData: 5 }, { imageData: '' }] },
    getLeaderboard: { ...scopePayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { scope: 'bots' }, { scope: 'all' }], notes: 'Throttled in-handler (rateLimiter key getLeaderboard, one budget for every scope); over the limit replies leaderboardResponse with that scope\'s cached (possibly stale) result, else its fill in flight, else the existing {success:false, message} reply; never error. Served from a 60 s cache per scope, every scope invalidated on stats/picture/account changes. ' + SCOPE_NOTE },
    getRecords: { ...scopePayload, status: 'active', joi: null, rateLimit: null, sentBy: both, examples: [{}, { scope: 'bots' }, { scope: 'all' }], notes: 'Throttled in-handler (rateLimiter key getRecords, one budget for every scope); over the limit replies recordsResponse with that scope\'s cached (possibly stale) result, else its fill in flight, else the existing {success:false, message} reply; never error. Served from a 60 s cache per scope (per month), every scope invalidated when a game is recorded or an account deleted. ' + SCOPE_NOTE },
    searchPlayers: { payload: open({ query: str({ maxLength: 500 }) }), status: 'active', joi: 'searchPlayers', rateLimit: 'searchPlayers', sentBy: webOnly, examples: [{ query: 'al' }, { query: '' }], invalid: [{}, { query: 5 }, { query: 'x'.repeat(501) }], notes: 'Joi since V1_REMOVALS #18 (2026-11-11). A blank query answers {success:false} and a trimmed query longer than 50 (the username max) an empty list, in the handler.' },
    getPlayerProfile: { payload: open({ username: str({ minLength: 1, maxLength: 100 }), scope: statsScope() }, { optional: ['scope'] }), status: 'active', joi: 'getPlayerProfile', rateLimit: 'getPlayerProfile', sentBy: both, examples: [{ username: 'alan' }, { username: '🤖 Mary' }, { username: 'alan', scope: 'all' }], invalid: [{}, { username: '' }, { username: 'x'.repeat(101) }], notes: 'iOS from 1.2.2 (build 10): the player profile sheet (chat long-press View Profile, a seat avatar tap, the online list), always with {scope}; a bot name is asked too and answers Player not found. Joi since V1_REMOVALS #18 (2026-11-11). Web asks from search rows, seat avatars and opponent plates (dataset.username, a bot name included). ' + SCOPE_NOTE + ' Joi accepts any scope value (lenient: the handler normalizes a non-string, null or unknown scope to human, echoed).' },

    // Tournament
    createTournament: { ...noPayload, status: 'active', joi: 'createTournament', rateLimit: 'createTournament', sentBy: both, examples: [{}] },
    joinTournament: { payload: open({ tournamentId: uuid() }), status: 'active', joi: 'joinTournament', rateLimit: 'joinTournament', sentBy: both, examples: [{ tournamentId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' }], invalid: [{ tournamentId: 'x' }, {}] },
    leaveTournament: { ...noPayload, status: 'active', joi: 'leaveTournament', rateLimit: 'leaveTournament', sentBy: both, examples: [{}] },
    tournamentReady: { ...noPayload, status: 'active', joi: 'tournamentReady', rateLimit: 'tournamentReady', sentBy: both, examples: [{}] },
    tournamentUnready: { ...noPayload, status: 'active', joi: 'tournamentUnready', rateLimit: 'tournamentUnready', sentBy: both, examples: [{}] },
    setTournamentRounds: {
        payload: open({ totalRounds: int({ minimum: 1, maximum: 5 }) }),
        status: 'active', joi: 'setTournamentRounds', rateLimit: 'setTournamentRounds', sentBy: both,
        examples: [{ totalRounds: 1 }, { totalRounds: 4 }, { totalRounds: 5 }],
        invalid: [{ totalRounds: 0 }, { totalRounds: 6 }, { totalRounds: 2.5 }, { totalRounds: '3' }, {}],
        notes: 'New (2026-11-25): the host picks the number of rounds, 1 to 5 (default 4), in the tournament lobby before Begin. Accepted: tournamentSettingsUpdated {totalRounds, by} and an unstored system tournamentMessage "<host> set the tournament to 3 rounds." to the room, then lobbiesUpdated; ready flags are kept; the same count again sends nothing. Refused with serverError: \'Not in a tournament\', \'Only the host can change the number of rounds\', \'Rounds can only change before the tournament begins\'. Web sends it from the lobby\'s Rounds picker (ui/screens/TournamentLobby.js); iOS from build 41 (the host\'s Rounds picker above Begin, Views/Tournament/TournamentRoundsPicker.swift, TournamentEmitter.setTournamentRounds).',
    },
    cutForABuckDraw: {
        payload: open({ round: int({ minimum: 1, maximum: 10000 }), slot: { type: ['integer', 'null'], minimum: 0, maximum: 107 } }, { optional: ['slot'] }),
        status: 'active', joi: 'cutForABuckDraw', rateLimit: 'cutForABuckDraw', sentBy: both,
        examples: [{ round: 1, slot: 7 }, { round: 3, slot: null }, { round: 2 }],
        invalid: [{ round: 0, slot: 1 }, { round: 1, slot: -1 }, { round: 1, slot: 108 }, { round: 1, slot: 2.5 }, { round: '1', slot: 1 }, { slot: 1 }],
        notes: 'New (2026-11-25, Cut for a buck; server/socket/cutForABuck.js draw): a draw for the open round (the round of the last cutForABuckRound), the slot clicked in the face-down fan, or null for a random one. Answered by the room\'s cutForABuckDrew. Anything out of turn (no tournament, not phase cut, no open round, a stale round, not a player still in, a repeat, a spectator) is dropped silently (no serverError); a malformed payload gets the wrapper\'s serverError {code: \'validation\'}. Rate limit 10 / 10 s. Sent by the web (ui/cut/CutForABuck.js: a click on the fan sends the slot under the pointer, Enter / Space on the deck null) and iOS from build 41 (TournamentEmitter.cutForABuckDraw: a tap on the fan sends the slot under the finger, VoiceOver\'s Draw a card and the list\'s button null, and a tap after the server drew for me (away) null once a round, so the next round waits for me).',
    },
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

    // Admin panel (web; iOS from 1.2.2 build 10)
    adminRequest: {
        payload: open({
            requestId: str({ minLength: 1, maxLength: 64 }),
            action: enm(...ADMIN_ACTIONS),
            args: open({}),
        }, { optional: ['args'] }),
        status: 'active', joi: 'adminRequest', rateLimit: 'adminRequest', sentBy: both,
        examples: [
            { requestId: 'adm-1', action: 'searchPlayers', args: { query: 'alan' } },
            { requestId: 'adm-2', action: 'listAdmins' },
            { requestId: 'adm-4', action: 'listPlayers', args: {} },
            { requestId: 'adm-5', action: 'deleteAccount', args: { username: 'keyprobe00001', confirm: 'keyprobe00001' } },
            { requestId: 'adm-6', action: 'renameAccount', args: { username: 'alan2', newName: 'Alan T', confirm: 'Alan T' } },
            { requestId: 'adm-3', action: 'applyMerge', args: { target: 'Alan', sources: ['alan2'], planHash: 'a'.repeat(64), confirm: 'Alan' } },
        ],
        invalid: [{ requestId: '', action: 'listAdmins' }, { requestId: 'a', action: 'dropDatabase' }, { action: 'listAdmins' }, { requestId: 'a', action: 'listAdmins', args: 'x' }, { requestId: 'x'.repeat(65), action: 'listAdmins' }],
        notes: 'The admin panel (server/socket/adminHandlers.js). Answered by adminResponse to this socket only (requestId and action echoed). Authorized on EVERY request against the database (signed in, the account\'s current socket, its session still live, not a merged tombstone, isAdmin true); anyone else gets {ok:false, error:\'forbidden\'} for every action and target, before args are read, so a non-admin learns nothing. args are validated per action after that (adminHandlers ACTION_SCHEMAS; invalid -> {ok:false, error:\'invalid\'}). Each request writes one adminAudit entry (listAudit excepted). Wrapper limit 60/min (serverError {code:\'rateLimit\', handler:\'adminRequest\'}, never an adminResponse). Sent by the web panel and, from iOS 1.2.2 build 10, by the iOS admin panel (Networking/AdminApi.swift: the same requestId matching, 15 s timeout and 3 s rate-limit fail-fast; only on a connected socket whose sign-in or restore was answered, so a forbidden answer always means the access is gone). iOS 1.2.0 / 1.2.1 never send it. No platform check on the server: every socket is authorized the same way.',
    },
};

// Silence an unused-import lint in editors
void bool; void iosOnly;

module.exports = { c2s };
