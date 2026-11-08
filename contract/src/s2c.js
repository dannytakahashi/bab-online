/**
 * Server -> client events. Derived from the emit sites (emittedFrom); the
 * clients' reads (clientReads) are cited by file:function.
 *
 * Per event:
 *   payload     JSON Schema of the wire data (null = no payload: emit(event))
 *   status      active | deprecated | clientOnly | unsent
 *   to          who receives it: room (game:<id> via game.broadcast), self
 *               (the requesting socket), socket (io.to(<socketId>)), mainRoom,
 *               tournament (tournament:<id>), all (io.emit)
 *   seq         true when room broadcasts of it carry `seq` (contract/README.md)
 *   added       payload keys added since cc865b4 (wire-additive)
 *   activates   added keys a SHIPPED client already reads (lights up a dormant
 *               read path); everything else in `added` is read by nobody yet
 *   reserved    keys that must never be added (a shipped client would
 *               misread them); see schemaMeta.test.js
 * Variants (anyOf members) carry a `variant` name and are never merged.
 */

'use strict';

const {
    str, int, num, bool, konst, enm, arr, ref, anyOf, orNull, obj, variant, byPosition,
    LEGACY_CLIENT_STATE_PROPS, SPECTATOR_STATE_V1_PROPS,
} = require('./defs');

// ---------- client read sites ----------
const W = {
    auth: 'client/src/handlers/authHandlers.js:registerAuthHandlers',
    lobby: 'client/src/handlers/lobbyHandlers.js:registerLobbyHandlers',
    game: 'client/src/handlers/gameHandlers.js:registerGameHandlers',
    chat: 'client/src/handlers/chatHandlers.js:registerChatHandlers',
    tour: 'client/src/handlers/tournamentHandlers.js:registerTournamentHandlers',
    voice: 'client/src/handlers/voiceHandlers.js:registerVoiceHandlers',
    profile: 'client/src/handlers/profileHandlers.js:registerProfileHandlers',
    board: 'client/src/handlers/leaderboardHandlers.js:registerLeaderboardHandlers',
    records: 'client/src/handlers/recordsHandlers.js:registerRecordsHandlers',
    main: (fn) => `client/src/main.js:${fn}`,
};
const I = {
    auth: 'iOSClient/BABOnline/Networking/Handlers/AuthSocketHandler.swift:register',
    lobby: 'iOSClient/BABOnline/Networking/Handlers/LobbySocketHandler.swift:register',
    game: (fn) => `iOSClient/BABOnline/Networking/Handlers/GameSocketHandler.swift:${fn}`,
    chat: 'iOSClient/BABOnline/Networking/Handlers/ChatSocketHandler.swift:register',
    tour: 'iOSClient/BABOnline/Networking/Handlers/TournamentSocketHandler.swift:register',
    voice: 'iOSClient/BABOnline/Networking/Handlers/VoiceSocketHandler.swift:register',
    safety: 'iOSClient/BABOnline/Networking/Handlers/SafetySocketHandler.swift:register',
    board: 'iOSClient/BABOnline/Networking/Handlers/LeaderboardSocketHandler.swift:register',
    state: (fn) => `iOSClient/BABOnline/State/GameState.swift:${fn}`,
};
const reads = (web, ios) => ({ web: [].concat(web || []), ios: [].concat(ios || []) });

// ---------- shared payload pieces ----------
const fail = (extra = {}) => variant('failure', obj({ success: konst(false), message: str(), ...extra }));
const okFail = (okProps, { optional = [] } = {}) => anyOf(
    variant('success', obj({ success: konst(true), ...okProps }, { optional })),
    fail(),
);
const empty = obj({});
const lobbyLists = {
    lobbies: arr(ref('lobby')),
    inProgressGames: arr(ref('inProgressGame')),
    tournaments: arr(ref('tournamentSummary')),
};
const mainRoomState = {
    messages: arr(ref('mainRoomChatLine')),
    recentMessages: arr(ref('mainRoomChatLine')),
    lobbies: arr(ref('lobby')),
    onlineCount: int({ minimum: 0 }),
    onlineUsers: arr(str()),
    inProgressGames: arr(ref('inProgressGame')),
    tournaments: arr(ref('tournamentSummary')),
};
const scoreboard = arr(ref('scoreboardRow'));
const seatNotice = obj({ position: ref('position'), username: str() });

const LEGACY_STATE_READS = reads(
    [W.game, W.main('processRejoinOrRestore'), 'client/src/state/GameState.js:restoreFromRejoin'],
    [I.game('registerReconnection'), I.state('restoreFromRejoin')],
);

const s2c = {
    // ==================== Auth ====================
    signInResponse: {
        payload: anyOf(
            variant('success', obj({
                success: konst(true), username: str(), sessionToken: str(), blockedUsers: arr(str()),
                activeGameId: str(), activeTournamentId: str(),
            }, { optional: ['activeGameId', 'activeTournamentId'] })),
            fail(),
        ),
        status: 'active', to: 'self',
        clientReads: reads(W.auth, I.auth),
        emittedFrom: ['server/socket/authHandlers.js:signIn'],
    },
    signUpResponse: {
        payload: anyOf(
            variant('success', obj({ success: konst(true), username: str(), sessionToken: str(), autoLoggedIn: konst(true) })),
            fail(),
        ),
        status: 'active', to: 'self',
        clientReads: reads(W.auth, I.auth),
        emittedFrom: ['server/socket/authHandlers.js:signUp'],
    },
    restoreSessionResponse: {
        payload: anyOf(
            variant('success', obj({
                success: konst(true), username: str(), blockedUsers: arr(str()),
                activeGameId: str(), activeTournamentId: str(),
            }, { optional: ['activeGameId', 'activeTournamentId'] })),
            fail(),
        ),
        status: 'active', to: 'self',
        clientReads: reads(W.main('restoreSessionResponse'), I.auth),
        emittedFrom: ['server/socket/authHandlers.js:restoreSession'],
    },
    forceLogout: {
        payload: null,
        status: 'active', to: 'socket',
        clientReads: reads(W.auth, I.auth),
        emittedFrom: ['server/socket/authHandlers.js:disconnectPreviousSocket', 'server/socket/authHandlers.js:deleteAccount'],
    },
    deleteAccountResponse: {
        payload: anyOf(variant('success', obj({ success: konst(true) })), fail()),
        status: 'active', to: 'self',
        clientReads: reads(W.main('deleteAccountResponse'), I.auth),
        emittedFrom: ['server/socket/authHandlers.js:deleteAccount'],
    },
    activeGameFound: {
        payload: obj({ gameId: str() }, { open: true }),
        status: 'clientOnly', to: 'self',
        clientReads: reads(W.auth, I.auth),
        emittedFrom: [],
        notes: 'Never emitted (signInResponse.activeGameId replaced it). CAUTION: the only event that makes the shipped iOS app emit rejoinGame by itself (AuthSocketHandler.handleActiveGameFound); see V1_REMOVALS.md.',
    },

    // ==================== Safety ====================
    reportUserResponse: {
        payload: anyOf(variant('success', obj({ success: konst(true) })), fail()),
        status: 'active', to: 'self',
        clientReads: reads(W.main('reportUserResponse'), I.safety),
        emittedFrom: ['server/socket/safetyHandlers.js:reportUser'],
    },
    blockListUpdated: {
        payload: okFail({ blockedUsers: arr(str()) }),
        status: 'active', to: 'self',
        clientReads: reads(W.main('blockListUpdated'), I.safety),
        emittedFrom: ['server/socket/safetyHandlers.js:updateBlockList'],
    },

    // ==================== Main room ====================
    mainRoomJoined: {
        payload: obj(mainRoomState),
        status: 'active', to: 'self',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinMainRoom', 'server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/tournamentHandlers.js:sendToMainRoom'],
        notes: 'recentMessages duplicates messages (iOS reads recentMessages first).',
    },
    mainRoomMessage: {
        payload: ref('mainRoomChatLine'),
        status: 'active', to: 'mainRoom',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:mainRoomChat', 'server/demo/ambientBots.js:maybePostChat', 'server/demo/ambientBots.js:announceGameVisible'],
    },
    mainRoomPlayerJoined: {
        payload: obj({ username: str(), onlineCount: int({ minimum: 0 }), onlineUsers: arr(str()) }),
        status: 'active', to: 'mainRoom',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinMainRoom'],
        notes: 'socket.to(mainRoom): everyone in the main room but the joiner.',
    },
    mainRoomPlayerLeft: {
        payload: obj({ username: str(), onlineCount: int({ minimum: 0 }), onlineUsers: arr(str()) }),
        status: 'active', to: 'mainRoom',
        clientReads: reads([], []),
        emittedFrom: ['server/socket/queueHandlers.js:handleDisconnect'],
        notes: "New: the user's last socket disconnected (the online list shrank). Counterpart of mainRoomPlayerJoined. A sign-out that keeps the socket open is not covered. Current builds ignore it and keep a stale count (ctr-21).",
    },
    lobbiesUpdated: {
        payload: obj(lobbyLists),
        status: 'active', to: 'mainRoom',
        reserved: [{ key: 'lobbyName', why: 'iOS reads lobbyName ?? name' }, { key: 'inProgress', why: 'reserved lobby key (iOS Lobby.from)' }],
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/gameLifecycle.js:emitLobbiesUpdated', 'server/socket/mainRoomHandlers.js:createLobby', 'server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/mainRoomHandlers.js:getLobbies', 'server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/lobbyHandlers.js:addBot', 'server/socket/lobbyHandlers.js:removeBot', 'server/socket/tournamentHandlers.js:createTournament', 'server/socket/tournamentHandlers.js:joinTournament', 'server/socket/tournamentHandlers.js:leaveTournament', 'server/socket/tournamentHandlers.js:scheduleTournamentCleanup'],
        notes: 'getLobbies answers the requesting socket with the same shape.',
    },

    // ==================== Lobby ====================
    lobbyCreated: {
        payload: anyOf(
            variant('withName', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), messages: arr(ref('lobbyChatLine')), name: str() })),
            variant('withoutName', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), messages: arr(ref('lobbyChatLine')) })),
        ),
        status: 'active', to: 'self',
        reserved: [{ key: 'lobbyName', why: 'iOS reads lobbyName ?? name' }],
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:createLobby', 'server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/queueHandlers.js:joinQueue'],
        notes: 'withoutName only from the unsent joinQueue path.',
    },
    lobbyJoined: {
        payload: obj({ lobbyId: str() }, { open: true }),
        status: 'clientOnly', to: 'self',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: [],
        notes: 'Never emitted: joining a lobby answers lobbyCreated.',
    },
    lobbyPlayerJoined: {
        payload: obj({
            lobbyId: str(),
            players: arr(ref('lobbyMember'), { maxItems: 4 }),
            newPlayer: obj({ socketId: str(), username: str(), ready: bool() }, { optional: ['ready'] }),
        }),
        status: 'active', to: 'socket',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/queueHandlers.js:joinQueue'],
    },
    lobbyPlayerLeft: {
        payload: obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), leftUsername: str(), needsMorePlayers: bool() }),
        status: 'active', to: 'socket',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:leaveLobby'],
    },
    leftLobby: {
        payload: empty,
        status: 'active', to: 'self',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:leaveLobby'],
    },
    playerReadyUpdate: {
        payload: anyOf(
            variant('readySocketId', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), readySocketId: str() })),
            variant('unreadySocketId', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), unreadySocketId: str() })),
            variant('neither', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }) })),
        ),
        status: 'active', to: 'socket',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:playerReady', 'server/socket/lobbyHandlers.js:playerUnready', 'server/socket/lobbyHandlers.js:addBot', 'server/socket/lobbyHandlers.js:removeBot'],
    },
    allPlayersReady: {
        payload: obj({ gameId: str() }),
        status: 'active', to: 'socket',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:playerReady', 'server/socket/tournamentHandlers.js:startTournamentRound'],
    },
    lobbyMessage: {
        payload: obj({ lobbyId: str(), username: str(), message: str(), timestamp: int() }),
        status: 'active', to: 'socket',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:lobbyChat'],
        notes: 'Sent to every lobby member, bots included (bot: ids never reach a wire).',
    },
    queueUpdate: {
        payload: obj({ queuedUsers: arr(obj({}, { open: true })) }),
        status: 'deprecated', to: 'all',
        clientReads: reads([], []),
        emittedFrom: ['server/socket/queueHandlers.js:leaveQueue'],
        notes: 'Only from the unsent leaveQueue; no listener in either client. V1_REMOVALS #2.',
    },

    // ==================== Draw ====================
    startDraw: {
        payload: obj({ start: konst(true) }),
        status: 'active', to: 'room', seq: false,
        reserved: [{ key: 'numCards', why: 'iOS sets drawCardCount from it (GameSocketHandler.registerSetupPhase)' }],
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameLifecycle.js:beginDraw'],
    },
    youDrew: {
        payload: obj({ card: ref('card'), drawOrder: int({ minimum: 1, maximum: 4 }) }),
        status: 'active', to: 'self',
        reserved: [{ key: 'position', why: 'iOS would read it as a seat before seats exist' }],
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:draw', 'server/socket/seatLifecycle.js:startDrawWatchdog'],
        notes: 'The watchdog variant goes through game.sendToPlayer (io.to(socketId)).',
    },
    playerDrew: {
        payload: obj({ username: str(), card: ref('card'), drawOrder: int({ minimum: 1, maximum: 4 }), socketId: str() }),
        status: 'active', to: 'room', seq: false,
        reserved: [{ key: 'cardIndex', why: 'iOS DrawResult reads cardIndex (defaults to 0 today)' }],
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:draw', 'server/socket/gameHandlers.js:autoDraw', 'server/game/bot/BotController.js:processBotDraw'],
    },
    playerAssigned: {
        payload: obj({ playerId: str(), position: ref('position') }),
        status: 'deprecated', to: 'socket',
        clientReads: reads(W.main('playerAssigned'), []),
        emittedFrom: ['server/socket/gameHandlers.js:handleDrawComplete'],
        notes: 'Web main.js reads it; replaced by v2 viewer.position (V1_REMOVALS #7).',
    },
    teamsAnnounced: {
        payload: obj({ team1: arr(str(), { minItems: 2, maxItems: 2 }), team2: arr(str(), { minItems: 2, maxItems: 2 }) }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handleDrawComplete'],
    },

    // ==================== Game ====================
    positionUpdate: {
        payload: obj({
            positions: arr(ref('position'), { maxItems: 4 }),
            sockets: arr(str(), { maxItems: 4 }),
            usernames: arr(obj({ username: str(), socketId: str() }), { maxItems: 4 }),
            pics: arr(ref('pic'), { maxItems: 4 }),
        }),
        status: 'active', to: 'room', seq: false,
        reserved: [{ key: 'yourPosition', why: 'iOS reads yourPosition as the viewer seat' }],
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handleDrawComplete'],
    },
    createUI: {
        payload: empty,
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handleDrawComplete'],
        notes: 'Always before the first gameStart.',
    },
    gameStart: {
        payload: anyOf(
            variant('seat', obj({
                gameId: str(),
                players: arr(str(), { maxItems: 4 }),
                hand: arr(ref('card'), { maxItems: 13 }),
                trump: ref('card'),
                score1: int(),
                score2: int(),
                dealer: ref('position'),
                position: ref('position'),
                currentHand: int({ minimum: 1, maximum: 13 }),
                hsiValues: ref('hsiValues'),
                playerInfo: arr(ref('playerInfoGameStart'), { maxItems: 4 }),
            })),
            variant('spectator', obj({
                gameId: str(),
                trump: ref('card'),
                score1: int(),
                score2: int(),
                dealer: ref('position'),
                currentHand: int({ minimum: 1, maximum: 13 }),
                hand: arr(ref('card'), { maxItems: 0 }),
                playerInfo: arr(ref('playerInfoGameStart'), { maxItems: 4 }),
            })),
        ),
        status: 'active', to: 'socket', seq: false,
        clientReads: reads([W.game, W.main('gameStart')], I.game('handleGameStart')),
        emittedFrom: ['server/socket/gameHandlers.js:dealHand'],
        notes: 'One per connected seat owner (seat) and per spectator (spectator), each deal. players: seat socket ids (unused; V1_REMOVALS #6). playerInfo rebuilds web avatars every hand (V1_REMOVALS #5).',
    },
    bidReceived: {
        payload: obj({ bid: ref('bidWire'), position: ref('position'), bidArray: ref('bidArray') }),
        status: 'active', to: 'room', seq: false,
        reserved: [
            { key: 'team1Mult', why: 'deferred: the shipped iOS app resets mults only in reset(), so a bore badge would persist into the next deal (V1_REMOVALS.md "Deferred additive")' },
            { key: 'team2Mult', why: 'deferred: same as team1Mult' },
        ],
        clientReads: reads(W.game, I.game('registerBiddingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:playerBid', 'server/game/bot/BotController.js:processBotBid'],
        notes: 'bid echoes the client value: an Int from iOS numeric bids (ctr-22).',
    },
    doneBidding: {
        payload: obj({ bids: ref('bidArray'), lead: ref('position'), teamBids: ref('teamPair'), mults: obj({ team1: int({ minimum: 1 }), team2: int({ minimum: 1 }) }) }),
        status: 'active', to: 'room', seq: false,
        added: ['teamBids', 'mults'],
        clientReads: reads(W.game, I.game('registerBiddingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handlePostBid'],
        notes: 'Web reads bids and lead; iOS reads lead. teamBids (capped at the hand size) and mults (bore multipliers) are additive and read by neither shipped client. Not sent for an all-zero redeal.',
    },
    updateTurn: {
        payload: anyOf(
            variant('room', obj({ currentTurn: ref('position') })),
            variant('private', obj({ currentTurn: ref('position') })),
        ),
        status: 'active', to: 'room', seq: false,
        reserved: [{ key: 'turn', why: 'iOS reads currentTurn ?? turn' }],
        clientReads: reads(W.game, I.game('registerBiddingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handlePostBid', 'server/socket/gameHandlers.js:handlePostPlay', 'server/socket/gameHandlers.js:dealHand', 'server/socket/seatLifecycle.js:goActive'],
        notes: 'private: goActive re-sends it to the returning owner socket only.',
    },
    rainbow: {
        payload: obj({ position: ref('position') }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: ['server/socket/gameHandlers.js:handlePostBid'],
    },
    destroyHands: {
        payload: empty,
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: ['server/socket/gameHandlers.js:handlePostBid'],
    },
    cardPlayed: {
        payload: obj({ playerId: str(), card: ref('card'), position: ref('position'), trump: bool({ description: 'trumpBroken after this card' }) }),
        status: 'active', to: 'room', seq: false,
        reserved: [{ key: 'trumpBroken', why: 'iOS reads trumpBroken ?? trump; trump must stay a Bool' }],
        clientReads: reads(W.game, I.game('handleCardPlayed')),
        emittedFrom: ['server/socket/gameHandlers.js:playCard', 'server/game/bot/BotController.js:processBotPlay'],
    },
    actionRejected: {
        payload: obj({
            action: enm('bid', 'play'),
            reason: enm('not_your_turn', 'already_bid', 'invalid_bid', 'invalid_play', 'already_played', 'illegal_card'),
            snapshot: ref('snapshotV2'),
        }),
        status: 'active', to: 'self',
        added: ['snapshot'],
        clientReads: reads([], I.game('registerPlayingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:rejectAction'],
        notes: 'iOS reads action == "play" (rollbackCardPlay); web has no listener. Always BEFORE the restorePlayerState of a "Card not in hand" play.',
    },
    trickComplete: {
        payload: obj({ winner: ref('position') }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerPlayingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handlePostPlay'],
    },
    handComplete: {
        payload: obj({ score: ref('teamPair'), team1Tricks: int({ minimum: 0 }), team2Tricks: int({ minimum: 0 }), team1OldScore: int(), team2OldScore: int() }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('handleHandComplete')),
        emittedFrom: ['server/socket/gameHandlers.js:handleHandComplete'],
    },
    gameEnd: {
        payload: obj({
            score: ref('teamPair'),
            playerStats: byPosition(obj({
                username: str(), totalBids: int(), totalTricks: int(), setsCaused: int(), totalHSI: num(), avgHSI: num(),
            })),
            tournamentId: orNull(str()),
        }),
        status: 'active', to: 'room', seq: false,
        reserved: ['winner', 'winningTeam', 'team1Score', 'team1Players', 'team2Players', 'handHistory']
            .map((key) => ({ key, why: 'the iOS game-end screen reads it ahead of score/playerStats' })),
        clientReads: reads([W.game, W.main('gameEnd')], I.game('registerGameEnd')),
        emittedFrom: ['server/socket/gameHandlers.js:handleHandComplete (via GameState.terminate)'],
    },
    abortGame: {
        payload: obj({ reason: str() }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: ['server/socket/gameLifecycle.js:abortGame (via GameState.terminate)'],
    },

    // ==================== Chat ====================
    chatMessage: {
        payload: anyOf(
            variant('humanOrSpectator', obj({ position: orNull(ref('position')), message: str(), username: str(), isSpectator: bool() })),
            variant('bot', obj({ position: ref('position'), message: str(), username: str() })),
        ),
        status: 'active', to: 'room', seq: false,
        clientReads: reads([W.chat, W.main('onChatMessage')], I.chat),
        emittedFrom: ['server/socket/chatHandlers.js:chatMessage', 'server/game/bot/BotController.js:sendBotChat'],
    },
    gameLogEntry: {
        payload: obj({ message: str(), type: konst('system') }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: ['server/socket/seatLifecycle.js:logEntry', 'server/socket/gameHandlers.js:handlePostBid', 'server/socket/gameHandlers.js:handleDrawComplete', 'server/socket/chatHandlers.js:handleDrawPhaseLeave', 'server/socket/queueHandlers.js:routeGameDisconnect'],
        notes: "Reserved: a type other than 'system' must carry playerPosition (schemaMeta.test.js pins type to 'system' unless playerPosition is required).",
    },

    // ==================== Reconnection ====================
    rejoinSuccess: {
        payload: anyOf(
            variant('withTournament', obj({ ...LEGACY_CLIENT_STATE_PROPS, tournamentId: orNull(str()), snapshot: ref('snapshotV2') })),
            variant('watchViaSpectate', obj({ ...LEGACY_CLIENT_STATE_PROPS, snapshot: ref('snapshotV2') })),
        ),
        status: 'active', to: 'self',
        added: ['snapshot'],
        reserved: ['teamTricks', 'oppTricks', 'teamScore', 'oppScore', 'isBidding', 'leadCard', 'playedCardIndex', 'trumpBroken']
            .map((key) => ({ key, why: 'iOS restoreFromRejoin reads it ahead of the legacy key and would take it as the viewer-relative value' })),
        clientReads: { ...LEGACY_STATE_READS, web: [...LEGACY_STATE_READS.web, W.main('rejoinSuccess')] },
        emittedFrom: ['server/socket/seatLifecycle.js:reconnectOwner', 'server/socket/seatLifecycle.js:watchSeat', 'server/socket/reconnectHandlers.js:rejoinGame'],
        notes: 'getClientState + tournamentId (string|null) on a rejoin; watchSeat via joinAsSpectator sends the bare state (web reads tournamentId !== undefined). Before playerReconnected and the presence replays.',
    },
    restorePlayerState: {
        payload: obj({ ...LEGACY_CLIENT_STATE_PROPS, snapshot: ref('snapshotV2') }),
        status: 'active', to: 'self',
        added: ['snapshot'],
        reserved: ['tournamentId', 'teamTricks', 'oppTricks', 'teamScore', 'oppScore', 'isBidding', 'leadCard', 'playedCardIndex', 'trumpBroken']
            .map((key) => ({ key, why: key === 'tournamentId' ? 'web routes a payload with tournamentId as a rejoin' : 'iOS restoreFromRejoin reads it ahead of the legacy key' })),
        clientReads: LEGACY_STATE_READS,
        emittedFrom: ['server/socket/gameHandlers.js:playCard', 'server/socket/seatLifecycle.js:goActive'],
        notes: 'After actionRejected on a "Card not in hand" play (#183), and on /active from the watch view.',
    },
    stateSnapshot: {
        payload: obj({
            snapshot: orNull(ref('snapshotV2')),
            requestId: anyOf(str({ maxLength: 64 }), int()),
            reason: konst('not_in_game'),
        }, { optional: ['requestId', 'reason'] }),
        status: 'active', to: 'self',
        clientReads: reads([], []),
        emittedFrom: ['server/socket/snapshotHandlers.js:requestSnapshot'],
        notes: 'New in snapshot v2: the reply to requestSnapshot (full pictures and log unless the request opts out). snapshot null + reason not_in_game when the socket is in no game.',
    },
    rejoinFailed: {
        payload: obj({
            reason: str(),
            debug: obj({ lookingFor: str(), playersInGame: arr(str()) }),
        }, { optional: ['debug'] }),
        status: 'active', to: 'self',
        clientReads: reads([W.game, W.main('rejoinFailed')], I.game('registerReconnection')),
        emittedFrom: ['server/socket/reconnectHandlers.js:rejoinGame'],
        notes: 'Web drops its game on ANY rejoinFailed.',
    },
    playerDisconnected: {
        payload: anyOf(variant('room', seatNotice), variant('private', seatNotice)),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerReconnection')),
        emittedFrom: ['server/socket/seatLifecycle.js:disconnectOwner', 'server/socket/gameHandlers.js:handleDrawComplete', 'server/socket/seatLifecycle.js:replayPresenceTo'],
        notes: 'private: the replay to a returning socket.',
    },
    playerReconnected: {
        payload: seatNotice,
        status: 'active', to: 'room', seq: false,
        clientReads: reads([W.game, W.main('playerReconnected')], I.game('registerReconnection')),
        emittedFrom: ['server/socket/seatLifecycle.js:reconnectOwner', 'server/socket/seatLifecycle.js:watchSeat'],
    },
    leftGame: {
        payload: null,
        status: 'active', to: 'self',
        clientReads: reads(W.game, I.game('registerSpectatorAndLazy')),
        emittedFrom: ['server/socket/seatLifecycle.js:leaveSeat', 'server/socket/chatHandlers.js:spectatorCommand', 'server/socket/chatHandlers.js:handleDrawPhaseLeave'],
    },
    joinMainRoom: {
        payload: null,
        status: 'deprecated', to: 'self',
        clientReads: reads([], []),
        emittedFrom: ['server/socket/seatLifecycle.js:leaveSeat', 'server/socket/chatHandlers.js:spectatorCommand'],
        notes: 'No listener in either client (V1_REMOVALS #4).',
    },
    roomFull: {
        payload: obj({}, { open: true }),
        status: 'clientOnly', to: 'self',
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: [],
    },

    // ==================== Presence ====================
    resignationAvailable: {
        payload: anyOf(variant('room', seatNotice), variant('private', seatNotice)),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: ['server/socket/seatLifecycle.js:offer', 'server/socket/seatLifecycle.js:replayPresenceTo'],
    },
    playerResigned: {
        payload: obj({ position: ref('position'), oldUsername: str(), botUsername: str(), botPic: ref('pic') }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: ['server/socket/seatLifecycle.js:resignSeat'],
    },
    playerLazyMode: {
        payload: obj({ position: ref('position'), botUsername: str(), botPic: ref('pic'), originalUsername: str() }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpectatorAndLazy')),
        emittedFrom: ['server/socket/seatLifecycle.js:goLazy'],
    },
    playerActiveMode: {
        payload: obj({ position: ref('position'), username: str(), pic: ref('pic') }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('registerSpectatorAndLazy')),
        emittedFrom: ['server/socket/seatLifecycle.js:goActive'],
    },
    spectatorJoined: {
        payload: anyOf(
            variant('fullState', obj({
                ...SPECTATOR_STATE_V1_PROPS,
                leadPosition: ref('position'),
                trumpBroken: bool(),
                teamTricks: int({ minimum: 0 }),
                oppTricks: int({ minimum: 0 }),
                snapshot: ref('snapshotV2'),
            })),
            variant('notice', obj({ username: str(), spectatorCount: int({ minimum: 0 }) })),
        ),
        status: 'active', to: 'room', seq: false,
        added: ['snapshot', 'leadPosition', 'trumpBroken', 'teamTricks', 'oppTricks'],
        activates: ['leadPosition', 'trumpBroken', 'teamTricks', 'oppTricks'],
        reserved: [
            { key: 'players', why: 'notice only: both clients route a payload with players + trump as the full state' },
            { key: 'trump', why: 'notice only: both clients route a payload with players + trump as the full state' },
        ],
        clientReads: reads([W.lobby, W.main('onSpectatorJoined')], [I.game('registerSpectatorAndLazy'), I.state('restoreFromSpectator#reads:leadPosition,trumpBroken,teamTricks,oppTricks')]),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinAsSpectator', 'server/socket/tournamentHandlers.js:spectateTournamentGame', 'server/socket/seatLifecycle.js:watchSeat'],
        notes: 'fullState goes to the joining socket only (socket.emit), BEFORE the room notice. The notice reaches the joiner too (ctr-17; V1_REMOVALS #8). leadPosition / trumpBroken / teamTricks / oppTricks switch on the shipped iOS restoreFromSpectator reads (ctr-1, ctr-8, ios-8d); web reads none of them.',
    },

    // ==================== Profile ====================
    profileResponse: {
        payload: okFail({ profile: ref('profile') }),
        status: 'active', to: 'self',
        clientReads: reads(W.profile, []),
        emittedFrom: ['server/socket/profileHandlers.js:getProfile'],
    },
    profilePicUpdateResponse: {
        payload: okFail({ profilePic: int({ minimum: 1, maximum: 82 }) }),
        status: 'active', to: 'self',
        clientReads: reads(W.profile, []),
        emittedFrom: ['server/socket/profileHandlers.js:updateProfilePic'],
    },
    profilePicUploadResponse: {
        payload: okFail({ customProfilePic: str() }),
        status: 'active', to: 'self',
        clientReads: reads(W.profile, []),
        emittedFrom: ['server/socket/profileHandlers.js:uploadProfilePic'],
    },
    searchPlayersResponse: {
        payload: okFail({ players: arr(ref('playerSearchRow')) }),
        status: 'active', to: 'self',
        clientReads: reads(W.profile, []),
        emittedFrom: ['server/socket/profileHandlers.js:searchPlayers'],
    },
    playerProfileResponse: {
        payload: okFail({ profile: ref('profile') }),
        status: 'active', to: 'self',
        clientReads: reads(W.profile, []),
        emittedFrom: ['server/socket/profileHandlers.js:getPlayerProfile'],
    },
    leaderboardResponse: {
        payload: okFail({ leaderboard: arr(ref('leaderboardRow')) }),
        status: 'active', to: 'self',
        clientReads: reads(W.board, I.board),
        emittedFrom: ['server/socket/profileHandlers.js:getLeaderboard'],
    },
    recordsResponse: {
        payload: okFail({ records: obj({}, { open: true }), totalGames: int({ minimum: 0 }) }),
        status: 'active', to: 'self',
        clientReads: reads(W.records, []),
        emittedFrom: ['server/socket/profileHandlers.js:getRecords'],
    },

    // ==================== Tournament ====================
    tournamentCreated: {
        payload: ref('tournamentClientState'),
        status: 'active', to: 'self',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:createTournament'],
    },
    tournamentJoined: {
        payload: anyOf(
            variant('member', ref('tournamentClientState')),
            variant('spectator', obj({ ...tournamentStateProps(), isSpectator: konst(true) }, { optional: ['winners'] })),
        ),
        status: 'active', to: 'self',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:joinTournament', 'server/socket/tournamentHandlers.js:spectateTournament', 'server/socket/tournamentHandlers.js:returnToTournament'],
    },
    tournamentPlayerJoined: {
        payload: obj({ username: str(), players: arr(ref('tournamentPlayer')) }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:joinTournament', 'server/socket/seatLifecycle.js:reattachTournament'],
    },
    tournamentPlayerLeft: {
        payload: obj({ username: str(), players: arr(ref('tournamentPlayer')), newCreator: orNull(str()) }, { optional: ['username'] }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:leaveTournament', 'server/socket/queueHandlers.js:handleDisconnect'],
        notes: 'username is absent when the leaver had no registered user (user?.username).',
    },
    tournamentReadyUpdate: {
        payload: obj({ players: arr(ref('tournamentPlayer')), allReady: bool() }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:tournamentReady', 'server/socket/tournamentHandlers.js:tournamentUnready'],
    },
    tournamentMessage: {
        payload: ref('tournamentChatLine'),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:tournamentChat', 'server/socket/tournamentHandlers.js:spectateTournament', 'server/socket/tournamentHandlers.js:rollbackRound'],
    },
    tournamentRoundStart: {
        payload: obj({ roundNumber: int({ minimum: 1 }), totalRounds: int(), assignments: arr(obj({ humanCount: int({ minimum: 0 }), botCount: int({ minimum: 0 }) })) }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:startTournamentRound'],
    },
    tournamentGameAssignment: {
        payload: obj({ gameId: str(), tournamentId: str(), roundNumber: int({ minimum: 1 }) }),
        status: 'active', to: 'socket',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:startTournamentRound'],
    },
    tournamentGameComplete: {
        payload: obj({
            gameId: str(), score: ref('teamPair'), aborted: konst(true),
            activeGames: arr(ref('tournamentActiveGame')), scoreboard, currentRound: int({ minimum: 0 }), totalRounds: int(),
        }, { optional: ['aborted'] }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/gameHandlers.js:handleHandComplete', 'server/socket/tournamentHandlers.js:handleAbortedTournamentGame'],
    },
    tournamentRoundComplete: {
        payload: obj({ scoreboard, currentRound: int({ minimum: 0 }), totalRounds: int() }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:broadcastRoundOutcome'],
    },
    tournamentComplete: {
        payload: obj({ scoreboard, winners: arr(str()) }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:broadcastRoundOutcome'],
    },
    tournamentLeft: {
        payload: empty,
        status: 'active', to: 'self',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:leaveTournament', 'server/socket/tournamentHandlers.js:returnToTournament'],
    },
    tournamentCancelled: {
        payload: empty,
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:cancelTournament'],
    },
    activeTournamentFound: {
        payload: obj({ tournamentId: str() }, { open: true }),
        status: 'clientOnly', to: 'self',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: [],
        notes: 'Never emitted (signInResponse.activeTournamentId replaced it).',
    },

    // ==================== Voice (relays) ====================
    voiceOffer: {
        payload: obj({ fromSocketId: str(), offer: obj({}, { open: true }), username: str() }, { optional: ['username'] }),
        status: 'active', to: 'socket',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/voiceHandlers.js:voiceOffer'],
        notes: 'username is the server-side name of the sender; absent if the sender is not signed in.',
    },
    voiceAnswer: {
        payload: obj({ fromSocketId: str(), answer: obj({}, { open: true }) }),
        status: 'active', to: 'socket',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/voiceHandlers.js:voiceAnswer'],
    },
    voiceIceCandidate: {
        payload: obj({ fromSocketId: str(), candidate: obj({}, { open: true }) }),
        status: 'active', to: 'socket',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/voiceHandlers.js:voiceIceCandidate'],
    },
    voiceRelayAudio: {
        payload: obj({ fromSocketId: str(), audio: { type: ['string', 'object', 'array'] } }),
        status: 'active', to: 'socket',
        clientReads: reads(W.voice, []),
        emittedFrom: ['server/socket/voiceHandlers.js:voiceRelayAudio'],
    },
    voicePeerList: {
        payload: obj({ peers: arr(ref('voicePeer')) }),
        status: 'active', to: 'self',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/queueHandlers.js:joinQueue', 'server/socket/seatLifecycle.js:reconnectOwner'],
    },
    voicePeerJoined: {
        payload: ref('voicePeer'),
        status: 'active', to: 'socket',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/queueHandlers.js:joinQueue', 'server/socket/seatLifecycle.js:reconnectOwner'],
    },
    voicePeerLeft: {
        payload: anyOf(variant('room', obj({ socketId: str() })), variant('private', obj({ socketId: str() }))),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/seatLifecycle.js:disconnectOwner', 'server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/queueHandlers.js:handleDisconnect'],
        notes: 'room: a game seat owner dropped (game.broadcast); private: lobby peers (io.to(socketId)).',
    },

    // ==================== Connection ====================
    serverShutdown: {
        payload: obj({ message: str() }),
        status: 'active', to: 'all',
        clientReads: reads([], []),
        emittedFrom: ['server/utils/shutdown.js:gracefulShutdown'],
        notes: 'No listener in either client today (V1_REMOVALS #17).',
    },
    error: {
        payload: anyOf(
            variant('handler', obj({ type: enm('rateLimit', 'validation', 'server'), message: str(), handler: str() })),
            variant('validation', obj({ type: konst('validation'), message: str() })),
            variant('message', obj({ message: str() })),
        ),
        status: 'active', to: 'self',
        clientReads: reads(W.main('setupSocketErrorHandler'), []),
        emittedFrom: ['server/socket/errorHandler.js:asyncHandler', 'server/socket/errorHandler.js:syncHandler', 'server/socket/errorHandler.js:handleError', 'server/socket/validators.js:withValidation', 'server/socket/*.js:<many handlers> (socket.emit(\'error\', {message}))', 'server/socket/chatHandlers.js:sendError'],
        notes: "App-level event (not the transport's error). Rename to serverError is V1_REMOVALS #1.",
    },
};

function tournamentStateProps() {
    // tournamentClientState's properties (spectator variant extends them)
    const { defs } = require('./defs');
    return defs.tournamentClientState.properties;
}

module.exports = { s2c };
