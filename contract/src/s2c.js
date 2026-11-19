/**
 * Server -> client events. Derived from the emit sites (emittedFrom); the
 * clients' reads (clientReads) are cited by file:function.
 *
 * Per event:
 *   payload     JSON Schema of the wire data (null = no payload: emit(event))
 *   status      active | deprecated | clientOnly | unsent
 *   to          who receives it (one or a list): room (game:<id> via
 *               game.broadcast), self (the requesting socket), socket
 *               (io.to(<socketId>)), mainRoom, tournament (tournament:<id>),
 *               all (io.emit). Enforced by the contract guard (self and
 *               socket count as the same: one client)
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
    str, int, num, bool, nul, konst, enm, arr, ref, anyOf, orNull, obj, variant, byPosition,
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
// iOS read sites cite the App Store build's source (cc9059f), the client the
// additive-only rule protects: GameSocketHandler's handle*/register* functions
// and GameState.restoreFromRejoin no longer exist on main. The next iOS build
// (item 23, docs/ios-table-store.md) reads through Networking/Wire and
// State/Table/TableReducer*.swift and adds three reads: error.handler,
// doneBidding.mults (recomputed when absent) and chatMessage.isSpectator
// (falling back to type).
const I = {
    auth: 'iOSClient/BABOnline/Networking/Handlers/AuthSocketHandler.swift:register',
    lobby: 'iOSClient/BABOnline/Networking/Handlers/LobbySocketHandler.swift:register',
    game: (fn) => `iOSClient/BABOnline/Networking/Handlers/GameSocketHandler.swift:${fn}`,
    chat: 'iOSClient/BABOnline/Networking/Handlers/ChatSocketHandler.swift:register',
    tour: 'iOSClient/BABOnline/Networking/Handlers/TournamentSocketHandler.swift:register',
    voice: 'iOSClient/BABOnline/Networking/Handlers/VoiceSocketHandler.swift:register',
    safety: 'iOSClient/BABOnline/Networking/Handlers/SafetySocketHandler.swift:register',
    board: 'iOSClient/BABOnline/Networking/Handlers/LeaderboardSocketHandler.swift:register',
    records: 'iOSClient/BABOnline/Networking/Handlers/RecordsSocketHandler.swift:register',
    // from iOS 1.2.2 (build 10): the Account sheet's own profile and the player profile sheet
    profile: 'iOSClient/BABOnline/Networking/Handlers/ProfileSocketHandler.swift:register',
    state: (fn) => `iOSClient/BABOnline/State/GameState.swift:${fn}`,
};
const reads = (web, ios) => ({ web: [].concat(web || []), ios: [].concat(ios || []) });

// ---------- shared payload pieces ----------
const fail = (extra = {}, o = {}) => variant('failure', obj({ success: konst(false), message: str(), ...extra }, o));
// The one-time notice after a password reset (authHandlers.resetNoticeFor)
const passwordResetNotice = obj({ by: enm('link', 'admin'), at: str() });
const PASSWORD_RESET_NOTE = 'passwordReset {by: link | admin, at: ISO time} (additive 2026-11-15, success only): the password was reset since the player last signed in, by a one-time reset link or by an admin (scripts/set-password.js); sent once (the reply\'s session write clears it). Web shows one info line ("Your password was reset with a reset link on <date>. If that wasn\'t you, tell an admin."); iOS from the next build after 1.2.1 build 9; iOS 1.2.0 ignores it.';
const okFail = (okProps, { optional = [], failScope = false } = {}) => anyOf(
    variant('success', obj({ success: konst(true), ...okProps }, { optional })),
    // failScope: the stats scope echo on a failure (SCOPE_ECHO_NOTE)
    failScope
        ? variant('failure', obj({ success: konst(false), message: str(), scope: statsScope }, { optional: ['scope'] }))
        : fail(),
);
const empty = obj({});
// Additive keys of every lobby event (2026-11-16, family lobbies of up to 8;
// GameManager.lobbyWire): every member, the host, the host's settings and
// the capacity (8 while every human sent casualSpectators, else 4).
// `players` / `reconnecting` stay the first 4 a shipped client reads
const LOBBY_EXTRA_PROPS = {
    members: arr(ref('lobbyMemberV2'), { maxItems: 8 }),
    host: str(),
    settings: ref('lobbySettings'),
    capacity: int({ minimum: 4, maximum: 8 }),
    // Play again (2026-11-16): the last game's older-app players whose
    // place is saved (a reservation; they have no row)
    expected: arr(str(), { minItems: 1, maxItems: 4 }),
};
const LOBBY_EXTRA_KEYS = Object.keys(LOBBY_EXTRA_PROPS);
const LOBBY_EXTRA_NOTE = 'members / host / settings / capacity (additive 2026-11-16, GameManager.lobbyWire; family lobbies): members lists everyone (at most 8) with playing (seated now: in a lobby of 4 or fewer every member; in a bigger one the table bots and the first humans to ready, up to 4) and reconnecting (a held seat); host the username that sets "Spectators can talk" (passes to the first connected member when it leaves); settings {spectatorsCanTalk} (always true since 2026-11-18: spectators always may talk); capacity 8 while every human member sent the casualSpectators cap, else 4. players / reconnecting keep at most the first 4 (frozen maxItems). Shipped clients read players and ignore the new keys (iOS reads lobby payloads as dictionaries). Play again (additive 2026-11-16, server/socket/playAgain.js): members[].returning marks a place held for someone not back from the last game (a row whose socketId is away:<uuid>, never a socket; it also carries reconnecting, and its name is in the top-level reconnecting a legacy client reads); expected (only while one stands) lists the last game\'s older-app players whose place is saved without a row (a reservation: strangers and Add Bot are refused while members + expected would pass 4). members[].onResults (additive 2026-11-16) marks a member moved back at the last game\'s end whose app still shows that game\'s results (lobby.afterGame.unsettled: no lobbyReturnSeen nor any act in the lobby yet), present and connected (never on a held row: a drop makes it returning or reconnecting instead); every moved member\'s row carries it in lobbyReturn. When one settles (lobbyReturnSeen, a joinLobby re-entry, an act whose own reply sends no list: chat, a refused Ready / Unready / Add Bot / Remove Bot / talk setting / Don\'t wait) the other capable members get a playerReadyUpdate (neither) without it; a leave or drop takes it off with that event\'s list. Web and iOS 1.2.2 (12) and later show "Still on the results" on the row (never on one\'s own) where it would say Waiting..., in the "Not back yet" style, with no "Don\'t wait" (they are present).';
// One gameEnd.playerStats entry (also lobbyReturn.lastGame.playerStats)
const GAME_END_STATS = obj({
    username: str(), totalBids: int(), totalTricks: int(), setsCaused: int(), totalHSI: num(), avgHSI: num(),
});
const lobbyLists = {
    lobbies: arr(ref('lobby')),
    inProgressGames: arr(ref('inProgressGame')),
    tournaments: arr(ref('tournamentSummary')),
};
const mainRoomState = {
    messages: arr(ref('mainRoomChatLine')),
    // only in the upgrade gate's 1.0.0 payload (V1_REMOVALS #13)
    recentMessages: arr(ref('mainRoomChatLine')),
    lobbies: arr(ref('lobby')),
    onlineCount: int({ minimum: 0 }),
    onlineUsers: arr(str()),
    inProgressGames: arr(ref('inProgressGame')),
    tournaments: arr(ref('tournamentSummary')),
};

// ---------- admin panel (adminResponse) ----------
const isoOrNull = () => orNull(str());
const adminPlayerRow = obj({
    username: str(), createdAt: isoOrNull(), lastSeenAt: isoOrNull(), online: bool(),
    // gamesPlayed: human games; botGamesPlayed: games with bots (users.botStats)
    gamesPlayed: int({ minimum: 0 }), botGamesPlayed: int({ minimum: 0 }), isAdmin: bool(), mergedInto: orNull(str()), renamed: bool(),
    renameUnfinished: orNull(str()),
    // a deleted account's name hold: until when the name stays taken (2026-11-15)
    heldUntil: isoOrNull(),
}, { optional: ['heldUntil'] });
const adminStats = obj({ gamesPlayed: num(), wins: num(), losses: num(), draws: num(), totalPoints: num() });
const teams = obj({ team1: arr(str()), team2: arr(str()) });
const mergePlanView = obj({
    target: str(), sources: arr(str()), errors: arr(str()), warnings: arr(str()),
    accounts: arr(obj({ role: enm('target', 'source', 'result'), username: str(), createdAt: isoOrNull(), stats: adminStats, botStats: adminStats, note: orNull(str()) })),
    statChanges: arr(obj({ key: str(), before: num(), after: num() })),
    botStatChanges: arr(obj({ key: str(), before: num(), after: num() })),
    profilePicFrom: orNull(str()),
    targetBlockedUsers: anyOf(obj({ before: arr(str()), after: arr(str()) }), nul()),
    gameRecords: arr(obj({ gameId: str(), completedAt: isoOrNull(), before: teams, after: teams })),
    reports: arr(obj({ id: str(), reporter: str(), reported: str(), newReporter: orNull(str()), newReported: orNull(str()) })),
    otherUsersBlocks: arr(obj({ username: str(), before: arr(str()), after: arr(str()) })),
    chainedTombstones: arr(obj({ username: str(), before: str() })),
    retire: arr(str()),
    changeCount: int({ minimum: 0 }),
});
const adminReportRow = obj({
    id: str(), reporter: str(), reported: str(), reason: str(), context: str(), createdAt: isoOrNull(),
    status: enm('open', 'resolved', 'dismissed'), resolvedBy: orNull(str()), resolvedAt: isoOrNull(), note: orNull(str()),
    reporterDeleted: bool(), reportedDeleted: bool(),
});
const adminAuditRow = obj({
    id: str(), at: str(), actor: orNull(str()), action: str(), target: orNull(str()),
    result: enm('ok', 'failed', 'forbidden'), detail: orNull(str()),
});
/** One ok variant per action: {requestId, action: <const>, ok: true, ...fields}. */
const adminOk = (action, props) => variant(action, obj({ requestId: str(), action: konst(action), ok: konst(true), ...props }));

const scoreboard = arr(ref('scoreboardRow'));

// Stats scope echo (server/utils/statsScope.js, owner 2026-11-13)
const statsScope = enm('human', 'bots', 'all');
const SCOPE_ECHO_NOTE = 'scope (additive 2026-11-13): the stats scope the request asked for (human | bots | all; an unknown value is human), echoed ONLY when the request carried a scope key, so a payload-less request (iOS, every shipped build) gets exactly the earlier reply. leaderboardResponse and recordsResponse failures echo it too (iOS 1.2.1 build 8 keeps a request in flight per scope and files a failure under the scope that asked); profile failures do not. The web client drops a reply whose scope is not its current choice (a stale reply after a fast switch).';
const seatNotice = obj({ position: ref('position'), username: str() });

// The snapshot carriers (rejoinSuccess, restorePlayerState, the spectator
// full state) since V1_REMOVALS #9 (2026-11-12): {snapshot} plus only the v1
// keys a client still reads (server/socket/snapshotHandlers.js carrierFor).
// players[] (position, username, pic): iOS 1.2.0 reads pic (a stock number
// or null since #19 A; a custom picture is only avatarUrls), web lets it win
// for names / pictures; its socketId (an iOS voice glow fallback) went with
// #14. gameId (and isLazy on
// rejoinSuccess, trump on the spectator state): what a web page from before
// #233 routes on. avatarUrls: iOS 1.2.0's hints. tournamentId: rejoinSuccess.
const CARRIER_PROPS = {
    gameId: str(),
    players: arr(ref('playerInfoV1'), { maxItems: 4 }),
};
const CARRIER_READS = reads(
    [W.game, 'client/src/state/tableSync.js:applyTableSnapshot'],
    ['iOSClient/BABOnline/Networking/Wire/WirePayloads.swift:RejoinEnvelope', 'iOSClient/BABOnline/State/Table/TableReducer+Snapshot.swift:seatState'],
);

const s2c = {
    // ==================== Auth ====================
    signInResponse: {
        payload: anyOf(
            variant('success', obj({
                success: konst(true), username: str(), sessionToken: str(), blockedUsers: arr(str()),
                activeGameId: str(), activeTournamentId: str(), isAdmin: konst(true), passwordReset: passwordResetNotice,
            }, { optional: ['activeGameId', 'activeTournamentId', 'isAdmin', 'passwordReset'] })),
            fail(),
        ),
        status: 'active', to: 'self',
        added: ['isAdmin', 'passwordReset'],
        notes: 'isAdmin (additive, 2026-11-11; present only when true): the web menu shows its Admin entry. Display only: the server re-checks the database on every adminRequest. iOS up to 1.2.1 reads the reply as a dictionary and ignores the key; from 1.2.2 build 10 it shows the Account sheet\'s Admin entry (AuthState.isAdmin). ' + PASSWORD_RESET_NOTE,
        clientReads: reads(W.auth, I.auth),
        emittedFrom: ['server/socket/authHandlers.js:signIn', 'server/socket/upgradeGate.js:sendUpdateMessage'],
    },
    signUpResponse: {
        payload: anyOf(
            variant('success', obj({ success: konst(true), username: str(), sessionToken: str(), autoLoggedIn: konst(true) })),
            fail(),
        ),
        status: 'active', to: 'self',
        clientReads: reads(W.auth, I.auth),
        emittedFrom: ['server/socket/authHandlers.js:signUp', 'server/socket/upgradeGate.js:replySignUp'],
    },
    restoreSessionResponse: {
        payload: anyOf(
            variant('success', obj({
                success: konst(true), username: str(), blockedUsers: arr(str()),
                activeGameId: str(), activeTournamentId: str(), isAdmin: konst(true), passwordReset: passwordResetNotice,
            }, { optional: ['activeGameId', 'activeTournamentId', 'isAdmin', 'passwordReset'] })),
            fail({ retryable: konst(true) }, { optional: ['retryable'] }),
        ),
        status: 'active', to: 'self',
        added: ['isAdmin', 'passwordReset', 'retryable'],
        notes: 'isAdmin: as on signInResponse (display only, present only when true; iOS up to 1.2.1 ignores it, 1.2.2 shows its Admin entry). ' + PASSWORD_RESET_NOTE + ' retryable: true (additive 2026-11-15, failure only) when the failure is passing and the saved token may still be good: a database error (also the session re-check\'s failed read) or a name an admin merge / rename / delete holds for a moment ("This account is being updated..."). Web keeps the saved token, shows Reconnecting... and sends restoreSession again with backoff (1 s doubling to 30 s, within the 10 / min limit); iOS the same from the next build after 1.2.1 build 9. iOS 1.2.0 and 1.2.1 up to build 9 ignore the key and forget the token on any failure (sign-in screen), as before. Every other failure (no such user, a deleted name, a bad or revoked token) has no retryable and both clients forget the token.',
        clientReads: reads(W.main('restoreSessionResponse'), I.auth),
        emittedFrom: ['server/socket/authHandlers.js:restoreSession'],
    },
    forceLogout: {
        payload: null,
        status: 'active', to: 'socket',
        clientReads: reads(W.auth, I.auth),
        emittedFrom: ['server/socket/authHandlers.js:disconnectPreviousSocket', 'server/socket/authHandlers.js:deleteAccount'],
    },
    sessionSuperseded: {
        payload: obj({ reason: enm('newerConnection', 'otherClosed'), refused: str({ maxLength: 64 }) }, { optional: ['refused'] }),
        status: 'active', to: 'socket',
        clientReads: reads([W.auth, W.main('onSessionSuperseded#reads:reason,refused')], []),
        emittedFrom: [
            'server/socket/sessionIdentity.js:confirmSupersede', 'server/socket/sessionIdentity.js:supersededGate',
            'server/socket/sessionIdentity.js:tellOtherClosed', 'server/socket/sessionIdentity.js:reparkClosedNotices',
        ],
        notes: 'New (2026-11-11). One live connection per user: a newer socket of the SAME saved session (another web tab adopting it, or a reload whose old socket the server still holds) took over; this socket is parked. Sent once when it happens and again (refused: the event name, at most once a second, with the reason it was last told) for every event the parked socket sends other than signIn / signUp / restoreSession / clientHello, which are dropped, never answered with error. Web: a full-screen notice, "Use here" reconnects and restores, which parks the other tab. reason \'otherClosed\' (additive, 2026-11-11): the user\'s LIVE socket disconnected and, 2 s later (OTHER_CLOSED_DELAY_MS: a reload of that tab re-takes the session first and nothing is sent), no socket holds the session; only that user\'s parked sockets are told, and nothing is taken back by itself (web: "The other BAB Online tab was closed. Use here to continue."). A socket that takes the session after that sends \'newerConnection\' again to the parked sockets told \'otherClosed\' (reparkClosedNotices). Limitation: a parked socket never restores, so one that reconnected (a deploy, a network blip) is anonymous to the server and told nothing more; the web notice then says only that the other tab may still be open. Web Sign Out revokes no token: a parked web tab signs itself out when the device\'s saved session is gone (the storage event, \'otherClosed\', Use here). iOS 1.1.0 has no handler (unknown events are ignored) and never shares a token between live sockets, so it never has a parked socket; a different session gets forceLogout as before.',
    },
    deleteAccountResponse: {
        payload: anyOf(variant('success', obj({ success: konst(true) })), fail()),
        status: 'active', to: 'self',
        notes: 'Refused (success false, the message says why) while the player is in a live game (its draw included, a /leave\'d seat until the game ends) or a tournament that is not complete (2026-11-15). On success the name is held for 30 days (a deleted-name tombstone: sign-up says it is taken; an admin can free it in the panel).',
        clientReads: reads(W.main('deleteAccountResponse'), I.auth),
        emittedFrom: ['server/socket/authHandlers.js:deleteAccount'],
    },
    changePasswordResponse: {
        payload: obj({ success: bool(), message: str() }),
        status: 'active', to: 'self',
        notes: 'New (2026-11-15): the reply to changePassword. success true: the password changed, every other device was signed out (forceLogout to its live sockets, its saved session revoked); this device stays signed in. success false: message says why (the 8-100 rule, the same password, a wrong current password (counted in the failed-sign-in throttle), throttled, busy, a database error). Web: the profile page\'s Change password form; iOS from the next build after 1.2.1 build 9 (Account sheet). Shipped iOS builds never send changePassword, so never get it.',
        clientReads: reads(W.main('changePasswordResponse'), []),
        emittedFrom: ['server/socket/authHandlers.js:changePassword'],
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
        payload: okFail({ blockedUsers: arr(str()), silent: konst(true) }, { optional: ['silent'] }),
        status: 'active', to: 'self',
        clientReads: reads(W.main('blockListUpdated'), I.safety),
        emittedFrom: ['server/socket/safetyHandlers.js:updateBlockList', 'server/admin/accountDelete.js:refreshBlockLists'],
        notes: 'Also sent unasked (success, with silent: true) to a player whose saved block list an admin RENAME re-pointed (accountDelete.refreshBlockLists), so the renamed player\'s chat stays hidden; both clients replace their list. Web shows its "Block list updated" info toast only without silent. The App Store iOS build (1.1.0, f05d264) ignores silent and shows its "Block list updated." alert (SafetySocketHandler / .safetyAlerts) wherever the player is: accepted for renames, which are rare and owner-run; so do 1.2.0 through 1.2.1 build 9. iOS reads silent from 1.2.2 (build 10; SafetySocketHandler.applyBlockListUpdated: list replaced, no alert). An admin DELETE sends nothing (the dead name stays in the client list, harmless, until the next sign-in; only the voice list is refreshed), and a player\'s own Delete account leaves other players\' lists alone.',
    },

    // ==================== Main room ====================
    mainRoomJoined: {
        payload: obj(mainRoomState, { optional: ['recentMessages'] }),
        status: 'active', to: 'self',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinMainRoom', 'server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/tournamentHandlers.js:sendToMainRoom', 'server/socket/upgradeGate.js:sendMainRoom'],
        notes: 'recentMessages (a copy of messages) is sent only by upgradeGate.sendMainRoom, to the gated iOS 1.0.0, which reads it first. The main-room handlers dropped it (V1_REMOVALS #13, 2026-11-11): web reads messages and iOS 1.1.0 recentMessages ?? messages (LobbySocketHandler, f05d264). inProgressGames is the joiner\'s own list (GameManager.getInProgressGames(username)): the ambient demo game only for the AMBIENT_CHAT_USERS accounts (owner, 2026-11-14), like the bot lines in messages.',
    },
    mainRoomMessage: {
        payload: ref('mainRoomChatLine'),
        status: 'active', to: ['mainRoom', 'socket'],
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:mainRoomChat', 'server/demo/ambientBots.js:postAmbientChat'],
        notes: 'mainRoom: a human line (and an ambient bot line when AMBIENT_CHAT_USERS=*); socket: an ambient bot line to each main-room socket of an AMBIENT_CHAT_USERS account (default test1; server/utils/ambientChatUsers.js).',
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
        status: 'active', to: ['mainRoom', 'socket'],
        reserved: [{ key: 'lobbyName', why: 'iOS reads lobbyName ?? name' }, { key: 'inProgress', why: 'reserved lobby key (iOS Lobby.from)' }],
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/gameLifecycle.js:emitLobbiesUpdated', 'server/socket/gameLifecycle.js:emitLobbiesUpdatedWide', 'server/socket/lobbyHandlers.js:startLobbyIfAllReady', 'server/socket/mainRoomHandlers.js:createLobby', 'server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/lobbyHandlers.js:addBot', 'server/socket/lobbyHandlers.js:removeBot', 'server/socket/lobbyHandlers.js:lobbySeatExpired', 'server/socket/tournamentHandlers.js:createTournament', 'server/socket/tournamentHandlers.js:joinTournament', 'server/socket/tournamentHandlers.js:leaveTournament', 'server/socket/tournamentHandlers.js:scheduleTournamentCleanup'],
        notes: 'Only to the main room since getLobbies (its one reply to a single socket) went with the matchmaking queue (V1_REMOVALS #2, 2026-11-11). Every send goes through gameLifecycle.emitLobbiesUpdated (the other sites call it). mainRoom: one broadcast while every member gets the same lists; socket: while the ambient demo game is listed and an AMBIENT_CHAT_USERS account (default test1; server/utils/ambientChatUsers.js) is in the main room, each main-room socket gets its own copy, with the demo game in inProgressGames for that audience only (owner, 2026-11-14). Same shape either way.',
    },

    // ==================== Lobby ====================
    lobbyCreated: {
        payload: anyOf(
            variant('withName', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), messages: arr(ref('lobbyChatLine')), name: str(), reconnecting: arr(str(), { minItems: 1, maxItems: 4 }), ...LOBBY_EXTRA_PROPS }, { optional: ['reconnecting', ...LOBBY_EXTRA_KEYS] })),
        ),
        status: 'active', to: 'self',
        added: ['reconnecting', ...LOBBY_EXTRA_KEYS],
        reserved: [{ key: 'lobbyName', why: 'iOS reads lobbyName ?? name' }],
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:createLobby', 'server/socket/mainRoomHandlers.js:joinLobby'],
        notes: 'The withoutName variant went with the matchmaking queue (V1_REMOVALS #2, 2026-11-11): every lobby a player can open or join is named. ' + LOBBY_EXTRA_NOTE,
    },
    lobbyReturn: {
        payload: obj({
            lobbyId: str(),
            players: arr(ref('lobbyMember'), { maxItems: 4 }),
            messages: arr(ref('lobbyChatLine')),
            name: str(),
            reconnecting: arr(str(), { minItems: 1, maxItems: 4 }),
            ...LOBBY_EXTRA_PROPS,
            lastGame: obj({
                gameId: str(),
                score: ref('teamPair'),
                playerStats: byPosition(GAME_END_STATS),
                position: orNull(ref('position')),
            }),
        }, { optional: ['reconnecting', 'expected'] }),
        status: 'active', to: 'socket',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/playAgain.js:openLobby'],
        notes: 'New (2026-11-16, play again; private, unsequenced, read by no shipped iOS build). Read by the web (handlers/lobbyHandlers.js -> main.js onLobbyReturn) and iOS from 1.2.2 (build 12) (LobbySocketHandler -> LobbyReturn.receive). Neither changes screen on it (owner 2026-11-16: the score screen stays exactly as it was until the player taps Return to Lobby): each remembers the lobby, follows its lobby events meanwhile, and Return shows it and sends lobbyReturnSeen (the web also joinLobby for it, which the server answers its own member with lobbyCreated). Only to a socket that sent the clientHello cap playAgain, at the end of a casual game a lobby started (never a tournament table, the ambient demo or an aborted game), in the same tick as its gameEnd and after it on that socket: the server moved it into a recreated copy of that lobby (a new lobbyId; the same name, host, settings, chat and lobby bots; nobody ready) and it is a mapped lobby member now. The lobby part is lobbyCreated\'s (withName) plus members / host / settings / capacity / expected, which it always carries. lastGame: the game that just ended (gameId, score and playerStats as in its gameEnd; position: this player\'s seat, null for a lobby extra who watched it). gameEnd is sequenced and can be held in a client\'s seq gate while this is not: a client applies it once it has applied gameEnd for lastGame.gameId (or after its gap timeout). Voice: the moved members\' calls are kept; r_i gets voicePeerList of the moved members before it in row order (a client skips a peer it is connected to). ' + LOBBY_EXTRA_NOTE,
    },
    lobbyPlayerJoined: {
        payload: obj({
            lobbyId: str(),
            players: arr(ref('lobbyMember'), { maxItems: 4 }),
            newPlayer: obj({ socketId: str(), username: str(), ready: bool() }, { optional: ['ready'] }),
            ...LOBBY_EXTRA_PROPS,
        }, { optional: LOBBY_EXTRA_KEYS }),
        status: 'active', to: 'socket',
        added: LOBBY_EXTRA_KEYS,
        notes: LOBBY_EXTRA_NOTE,
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinLobby'],
    },
    lobbyPlayerLeft: {
        payload: obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), leftUsername: str(), needsMorePlayers: bool(), ...LOBBY_EXTRA_PROPS }, { optional: LOBBY_EXTRA_KEYS }),
        status: 'active', to: 'socket',
        added: LOBBY_EXTRA_KEYS,
        notes: LOBBY_EXTRA_NOTE + ' needsMorePlayers stays "fewer than 4 members".',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/lobbyHandlers.js:releaseStaleLobbySeat'],
    },
    leftLobby: {
        payload: empty,
        status: 'active', to: 'self',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/lobbyHandlers.js:releaseStaleLobbySeat', 'server/socket/upgradeGate.js:replyLeave', 'server/socket/playAgain.js:leftOnResults'],
    },
    playerReadyUpdate: {
        payload: anyOf(
            variant('readySocketId', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), readySocketId: str(), reconnecting: arr(str(), { minItems: 1, maxItems: 4 }), ...LOBBY_EXTRA_PROPS }, { optional: ['reconnecting', ...LOBBY_EXTRA_KEYS] })),
            variant('unreadySocketId', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), unreadySocketId: str(), reconnecting: arr(str(), { minItems: 1, maxItems: 4 }), ...LOBBY_EXTRA_PROPS }, { optional: ['reconnecting', ...LOBBY_EXTRA_KEYS] })),
            variant('neither', obj({ lobbyId: str(), players: arr(ref('lobbyMember'), { maxItems: 4 }), reconnecting: arr(str(), { minItems: 1, maxItems: 4 }), ...LOBBY_EXTRA_PROPS }, { optional: ['reconnecting', ...LOBBY_EXTRA_KEYS] })),
        ),
        status: 'active', to: 'socket',
        added: ['reconnecting', ...LOBBY_EXTRA_KEYS],
        notes: LOBBY_EXTRA_NOTE + ' The neither variant also answers a setSpectatorsCanTalk (to its sender only, settings unchanged: always on since 2026-11-18) and goes back to a member whose Ready was refused because the table filled first ("The table is full — you\'ll watch this game"). reconnecting (additive, 2026-11-11; present only while a seat is held): the usernames whose lobby seat waits for its player to come back (GameManager.suspendLobbySeat, LOBBY_SEAT_GRACE_MS 30 s after a disconnect or a newer tab taking over). Every playerReadyUpdate carries it while one is held, lobbyCreated from joinLobby too; web shows "Reconnecting…" on those seats, iOS from 1.2.2 (build 10) too (LobbyState.applyPlayers: the list replaces the kept set, absent means none; lobbyPlayerJoined.newPlayer and a name no longer in players drop out). iOS up to 1.2.1 reads the reply as a dictionary and ignores it.',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:playerReady', 'server/socket/lobbyHandlers.js:playerUnready', 'server/socket/lobbyHandlers.js:sendLobbyState', 'server/socket/lobbyHandlers.js:addBot', 'server/socket/lobbyHandlers.js:removeBot', 'server/socket/lobbyHandlers.js:lobbySeatSuspended', 'server/socket/lobbyHandlers.js:lobbySeatResumed', 'server/socket/lobbyHandlers.js:setLobbySpectatorsCanTalk', 'server/socket/playAgain.js:sendExpected'],
    },
    allPlayersReady: {
        payload: obj({ gameId: str() }),
        status: 'active', to: 'socket',
        notes: 'To the table\'s humans only. A family lobby\'s extras (members who did not get a seat) never get it (every client would open the draw as an entrant): they get spectatorJoined (fullState at CREATED, no room notice) in the same tick, then voiceSettings when capable (lobbyHandlers.startExtras).',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:startLobbyIfAllReady', 'server/socket/tournamentHandlers.js:startTournamentRound'],
    },
    lobbyMessage: {
        payload: obj({ lobbyId: str(), username: str(), message: str(), timestamp: int() }),
        status: 'active', to: 'socket',
        clientReads: reads(W.lobby, I.lobby),
        emittedFrom: ['server/socket/lobbyHandlers.js:lobbyChat'],
        notes: 'Sent to every lobby member, bots included (bot: ids never reach a wire).',
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
        payload: obj({ username: str(), card: ref('card'), drawOrder: int({ minimum: 1, maximum: 4 }) }),
        status: 'active', to: 'room', seq: false,
        reserved: [{ key: 'cardIndex', why: 'iOS DrawResult reads cardIndex (defaults to 0 today)' }],
        notes: 'No socketId since 2026-11-12 (V1_REMOVALS #14): read by neither web nor iOS 1.2.0 (WirePayloads.PlayerDrew has no such field).',
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:draw', 'server/socket/gameHandlers.js:autoDraw', 'server/game/bot/BotController.js:processBotDraw'],
    },
    teamsAnnounced: {
        payload: obj({
            team1: arr(str(), { minItems: 2, maxItems: 2 }),
            team2: arr(str(), { minItems: 2, maxItems: 2 }),
            resumeInMs: int({ minimum: 0, description: 'TEAMS_MS: the server holds the announcement this long before createUI/gameStart' }),
        }),
        status: 'active', to: 'room', seq: false,
        added: ['resumeInMs'],
        notes: 'resumeInMs (additive, relative; contract/README.md "Resume holds"): web sizes its fade to it; the shipped iOS app ignores it.',
        clientReads: reads(W.game, I.game('registerSetupPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handleDrawComplete'],
    },

    // ==================== Game ====================
    positionUpdate: {
        payload: obj({
            positions: arr(ref('position'), { maxItems: 4 }),
            sockets: arr(str(), { maxItems: 4 }),
            usernames: arr(obj({ username: str() }), { maxItems: 4 }),
            pics: arr(ref('pic'), { maxItems: 4 }),
            avatarUrls: ref('avatarUrlsByPosition'),
            isBot: arr(bool(), { maxItems: 4, description: 'Per seat, in positions order: a native bot (its seat socket id starts with bot:)' }),
        }, { optional: ['avatarUrls'] }),
        status: 'active', to: 'room', seq: false,
        added: ['avatarUrls', 'isBot'],
        notes: 'pics: a stock number or null for every recipient (one room broadcast); since V1_REMOVALS #19 A (2026-11-12) a custom picture is null here and travels only in avatarUrls (additive, only when a rendition exists): {position: /avatar URL} (docs/avatars.md). V1_REMOVALS #14 (2026-11-12): usernames[] has no socketId (read by neither client); isBot (additive) is the bot: prefix of each seat socket id as a flag; iOS 1.2.0 build 5 reads it first (TableReducer.positionUpdate); the web reads it since 2026-11-19 (GameState positionUpdate: which seats are human, for the no-voice-alone rule, docs/claude/voice.md). sockets stays for now: build 5 reads it only as fallbacks (the prefix when isBot is absent or short, my seat before the username, the voice glow after the username), web only after yourPosition / the username and for the bot: prefix when isBot is absent or not a boolean, and the never-shipped TestFlight builds 3-4 tell a bot only by the prefix (V1_REMOVALS #14).',
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
                hand: arr(ref('card'), { maxItems: 13 }),
                trump: ref('card'),
                score1: int(),
                score2: int(),
                dealer: ref('position'),
                position: ref('position'),
                currentHand: int({ minimum: 1, maximum: 13 }),
                hsiValues: ref('hsiValues'),
                playerInfo: arr(ref('playerInfoGameStart'), { maxItems: 4 }),
                avatarUrls: ref('avatarUrlsByPosition'),
            }, { optional: ['avatarUrls'] })),
            variant('spectator', obj({
                gameId: str(),
                trump: ref('card'),
                score1: int(),
                score2: int(),
                dealer: ref('position'),
                currentHand: int({ minimum: 1, maximum: 13 }),
                hand: arr(ref('card'), { maxItems: 0 }),
                playerInfo: arr(ref('playerInfoGameStart'), { maxItems: 4 }),
                avatarUrls: ref('avatarUrlsByPosition'),
            }, { optional: ['avatarUrls'] })),
        ),
        status: 'active', to: 'socket', seq: false,
        added: ['avatarUrls'],
        clientReads: reads([W.game, 'client/src/state/GameState.js:applyDeal'], I.game('handleGameStart')),
        emittedFrom: ['server/socket/gameHandlers.js:dealHand'],
        notes: 'One per connected seat owner (seat) and per spectator (spectator), each deal. The seat variant\'s players (seat socket ids in deal order) went with V1_REMOVALS #6 (2026-11-12): web maps a voice peer to a seat by username (voice/speakingSlot.js) and keeps the ids positionUpdate gave (GameState.applyDeal); iOS 1.2.0 decodes it optionally and never reads it. playerInfo: web reads it only when present; iOS 1.2.0 needs it (its loop is what clears, each deal, the owner custom-picture avatarUrl a lazy / resign bot keeps, and its only read of gameStart avatarUrls), so it stays (V1_REMOVALS #5).',
    },
    bidReceived: {
        payload: obj({ bid: ref('bidString'), position: ref('position'), bidArray: ref('bidArray') }),
        status: 'active', to: 'room', seq: false,
        reserved: [
            { key: 'team1Mult', why: 'deferred: the shipped iOS app resets mults only in reset(), so a bore badge would persist into the next deal (V1_REMOVALS.md "Deferred additive")' },
            { key: 'team2Mult', why: 'deferred: same as team1Mult' },
        ],
        clientReads: reads(W.game, I.game('registerBiddingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:playerBid', 'server/game/bot/BotController.js:processBotBid'],
        notes: 'bid is always the normalized string (bidString), also for an iOS numeric bid sent as an Int (c2s playerBid keeps accepting Int: iOS 1.1.0 sends one). Until 2026-11-11 it echoed the client value ($defs.bidWire, Int | string; V1_REMOVALS #11); 1.1.0 decodes either (BidWire) and web applyBid calls String(data.bid).',
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
        status: 'active', to: ['room', 'socket'], seq: false,
        reserved: [{ key: 'turn', why: 'iOS reads currentTurn ?? turn' }],
        clientReads: reads(W.game, I.game('registerBiddingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:handlePostBid', 'server/socket/gameHandlers.js:handlePostPlay', 'server/socket/gameHandlers.js:resumeTrick', 'server/socket/gameHandlers.js:dealHand', 'server/socket/seatLifecycle.js:goActive'],
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
        payload: obj({
            card: ref('card'), position: ref('position'),
            trumpBroken: bool({ description: 'trump is broken after this card' }),
            resumeInMs: int({ minimum: 0, description: 'Only on the card that completes a trick: TRICK_VIEW_MS until trickComplete' }),
        }, { optional: ['resumeInMs'] }),
        status: 'active', to: 'room', seq: false,
        added: ['resumeInMs', 'trumpBroken'],
        activates: ['trumpBroken'],
        notes: 'resumeInMs (additive, relative; contract/README.md "Resume holds") only on the 4th card of a trick; built by GameState.cardPlayedPayload for both emit sites. trumpBroken (V1_REMOVALS #10, 2026-11-11): its reservation was for iOS 1.0.0 only (gated); 1.1.0 decodes trumpBroken ?? trump (WirePayloads.CardPlayed, TableReducer+Events) and web GameState.applyCardPlayed reads either. The `trump` Bool it replaced and `playerId` (a socket id read by neither client) were dropped the same day.',
        clientReads: reads([W.game, 'client/src/state/GameState.js:applyCardPlayed#reads:trumpBroken'], [I.game('handleCardPlayed'), 'iOSClient/BABOnline/State/Table/TableReducer+Events.swift:cardPlayed#reads:trumpBroken']),
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
        clientReads: reads([W.game, W.main('onActionRejected')], [I.game('registerPlayingPhase'), 'iOSClient/BABOnline/State/Table/TableReducer+Events.swift:apply']),
        emittedFrom: ['server/socket/gameHandlers.js:rejectAction'],
        notes: 'iOS reads action == "play" (rollbackCardPlay); web (item 16) rolls its pending bid/play back (state/MyAction.js) and renders the snapshot (the card returns to the hand; partial log: the log is kept). Always BEFORE the restorePlayerState of a "Card not in hand" play. reason: web toasts it in words (main.js onActionRejected); iOS 1.2.2 shows the same words (RejectReason, the server-error toast), an unknown reason as "Action not accepted"; earlier iOS builds decode it and show nothing.',
    },
    trickComplete: {
        payload: obj({
            winner: ref('position'),
            resumeInMs: int({ minimum: 0, description: 'Only on the last trick of a hand: HAND_END_MS (GAME_END_MS on hand 13) until handComplete' }),
        }, { optional: ['resumeInMs'] }),
        status: 'active', to: 'room', seq: false,
        added: ['resumeInMs'],
        notes: 'Absent resumeInMs: the next trick is open now (updateTurn follows in the same tick).',
        clientReads: reads(W.game, I.game('registerPlayingPhase')),
        emittedFrom: ['server/socket/gameHandlers.js:resumeTrick'],
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
            playerStats: byPosition(GAME_END_STATS),
            tournamentId: orNull(str()),
        }),
        status: 'active', to: 'room', seq: false,
        reserved: ['winner', 'winningTeam', 'team1Score', 'team1Players', 'team2Players', 'handHistory']
            .map((key) => ({ key, why: 'the iOS game-end screen reads it ahead of score/playerStats' })),
        clientReads: reads([W.game, W.main('onGameEnd')], I.game('registerGameEnd')),
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
            variant('humanOrSpectator', obj({
                position: orNull(ref('position')), message: str(), username: str(), isSpectator: bool(),
            })),
            variant('bot', obj({ position: ref('position'), message: str(), username: str(), isSpectator: konst(false) })),
        ),
        status: 'active', to: 'room', seq: false,
        added: ['isSpectator'],
        clientReads: reads([W.chat, W.main('onChatMessage')], 'iOSClient/BABOnline/State/Table/TableReducer+Events.swift:chatMessage'),
        emittedFrom: ['server/socket/chatHandlers.js:chatMessage', 'server/game/bot/BotController.js:sendBotChat'],
        notes: "isSpectator labels spectator chat: web (onChatMessage, the spectator bubble) and iOS 1.1.0 (TableReducer+Events: isSpectator ?? type == 'spectator', f05d264) read it; bot chat sends false. The `type` ('player' | 'spectator') copy, read only by the gated iOS 1.0.0, was dropped (V1_REMOVALS #12, 2026-11-11).",
    },
    gameLogEntry: {
        payload: anyOf(
            variant('room', obj({ message: str(), type: konst('system'), fault: ref('logFault') }, { optional: ['fault'] })),
            variant('private', obj({ message: str(), type: konst('system') })),
        ),
        status: 'active', to: ['room', 'socket'], seq: false,
        clientReads: reads(W.game, I.game('registerSpecialEvents')),
        emittedFrom: ['server/socket/seatLifecycle.js:logEntry', 'server/socket/gameHandlers.js:handlePostBid', 'server/socket/gameHandlers.js:handleDrawComplete', 'server/socket/gameHandlers.js:handleHandComplete', 'server/socket/chatHandlers.js:handleDrawPhaseLeave', 'server/socket/queueHandlers.js:routeGameDisconnect', 'server/utils/shutdown.js:noticeGames', 'server/socket/assistHandlers.js:help', 'server/socket/assistHandlers.js:sendLine', 'server/socket/assistHandlers.js:gameEndLines'],
        notes: "Reserved: a type other than 'system' must carry playerPosition (schemaMeta.test.js pins type to 'system' unless playerPosition is required). room: a system line stored in the game log and broadcast (sequenced). fault (additive 2026-11-19, owner): a hand's fault line \"Fault: <name> (bid N, took M)\", one per player on a set team who took fewer tricks than they bid (a bore counts as 0; server/game/rules.js handFaults, the setsCaused rule), sent after handComplete and stored after the hand's lines, so snapshot.log[] carries the same fault and a rejoin, reload or spectator replays it in place; web draws it red (GameLog is-fault), iOS from the next build. Among the room lines are the /help notices \"<name> used /help.\" and, on the use that crosses the free limit, \"<name> used /help. This game now counts as bot-assisted for <name>.\" (2026-11-18). private (2026-11-18, /help; unsequenced, NEVER stored, so no snapshot or rejoin has it): a /help answer, refusal or status line for a socket without the clientHello cap assist (at most 2 per ask: the answer and, on the last free use, the warning), the 'players only' / 'once the game starts' line for a spectator or entrant, and the end-of-game line to a player the game counted as bot-assisted for. Split from the one room shape (additiveOnly S2C_SPLIT): the room variant is the old payload plus the optional additive fault (2026-11-19); every shipped iOS build decodes seq as optional and applies an event without seq at once (TableReducer: guard let seq = ev.seq else apply), as the web SeqGate does.",
    },

    // ==================== Reconnection ====================
    rejoinSuccess: {
        payload: anyOf(
            variant('withTournament', obj({ ...CARRIER_PROPS, avatarUrls: ref('avatarUrlsByPosition'), isLazy: bool(), tournamentId: orNull(str()), snapshot: ref('snapshotV2') }, { optional: ['avatarUrls'] })),
            variant('watchViaSpectate', obj({ ...CARRIER_PROPS, avatarUrls: ref('avatarUrlsByPosition'), isLazy: bool(), snapshot: ref('snapshotV2') }, { optional: ['avatarUrls'] })),
        ),
        status: 'active', to: 'self',
        added: ['snapshot', 'avatarUrls'],
        reserved: ['teamTricks', 'oppTricks', 'teamScore', 'oppScore', 'isBidding', 'leadCard', 'playedCardIndex', 'trumpBroken']
            .map((key) => ({ key, why: 'iOS restoreFromRejoin reads it ahead of the legacy key and would take it as the viewer-relative value' })),
        clientReads: { ...CARRIER_READS, web: [...CARRIER_READS.web, W.main('onRejoinSuccess')] },
        emittedFrom: ['server/socket/seatLifecycle.js:reconnectOwner', 'server/socket/seatLifecycle.js:watchSeat', 'server/socket/reconnectHandlers.js:rejoinGame'],
        notes: 'A snapshot carrier (V1_REMOVALS #9, 2026-11-12: the 22 getClientState keys went; the table is the snapshot): gameId, players, avatarUrls (capable sockets with a URL), isLazy, tournamentId (string|null) on a rejoin; watchSeat via joinAsSpectator sends no tournamentId (web reads tournamentId !== undefined). Before playerReconnected and the presence replays.',
    },
    restorePlayerState: {
        payload: obj({ ...CARRIER_PROPS, avatarUrls: ref('avatarUrlsByPosition'), snapshot: ref('snapshotV2') }, { optional: ['avatarUrls'] }),
        status: 'active', to: 'self',
        added: ['snapshot', 'avatarUrls'],
        reserved: ['tournamentId', 'teamTricks', 'oppTricks', 'teamScore', 'oppScore', 'isBidding', 'leadCard', 'playedCardIndex', 'trumpBroken']
            .map((key) => ({ key, why: key === 'tournamentId' ? 'web routes a payload with tournamentId as a rejoin' : 'iOS restoreFromRejoin reads it ahead of the legacy key' })),
        clientReads: { ...CARRIER_READS, web: [...CARRIER_READS.web, W.main('onRestorePlayerState')] },
        emittedFrom: ['server/socket/gameHandlers.js:playCard', 'server/socket/seatLifecycle.js:goActive'],
        notes: 'A snapshot carrier (V1_REMOVALS #9, 2026-11-12): gameId, players, avatarUrls (capable sockets with a URL), snapshot. After actionRejected on a "Card not in hand" play (#183), and on /active from the watch view.',
    },
    stateSnapshot: {
        payload: anyOf(
            variant('found', obj({
                snapshot: ref('snapshotV2'),
                requestId: anyOf(str({ maxLength: 64 }), int()),
            }, { optional: ['requestId'] })),
            variant('notInGame', obj({
                snapshot: nul(),
                requestId: anyOf(str({ maxLength: 64 }), int()),
                reason: konst('not_in_game'),
            }, { optional: ['requestId'] })),
        ),
        status: 'active', to: 'self',
        clientReads: reads([W.game, W.main('onStateSnapshot'), 'client/src/socket/SocketManager.js:probeConnection'], []),
        emittedFrom: ['server/socket/snapshotHandlers.js:requestSnapshot'],
        notes: 'New in snapshot v2: the reply to requestSnapshot. The log is included unless the request sends log:false; no seat carries a picture inline (V1_REMOVALS #19 C: customPic always null, a custom picture is the seat\'s avatarUrl; customPics in the request is ignored and partial never lists \'customPics\'). notInGame: the socket is in no live game - also once its game ENDED or ABORTED (the terminal state arrives as gameEnd / abortGame, never as a snapshot).',
    },
    rejoinFailed: {
        payload: obj({ reason: str() }),
        status: 'active', to: 'self',
        clientReads: reads([W.game, W.main('onRejoinFailed')], I.game('registerReconnection')),
        emittedFrom: ['server/socket/reconnectHandlers.js:rejoinGame'],
        notes: 'Web drops its game on ANY rejoinFailed. debug {lookingFor, playersInGame} was dropped (V1_REMOVALS #15, 2026-11-11: it told the table\'s usernames to whoever asked; no client read it).',
    },
    playerDisconnected: {
        payload: anyOf(variant('room', seatNotice), variant('private', seatNotice)),
        status: 'active', to: ['room', 'socket'], seq: false,
        clientReads: reads(W.game, I.game('registerReconnection')),
        emittedFrom: ['server/socket/seatLifecycle.js:disconnectOwner', 'server/socket/gameHandlers.js:handleDrawComplete', 'server/socket/seatLifecycle.js:replayPresenceTo'],
        notes: 'private: the replay to a returning socket.',
    },
    playerReconnected: {
        payload: seatNotice,
        status: 'active', to: 'room', seq: false,
        clientReads: reads([W.game, W.main('onPlayerReconnected')], I.game('registerReconnection')),
        emittedFrom: ['server/socket/seatLifecycle.js:reconnectOwner', 'server/socket/seatLifecycle.js:watchSeat', 'server/socket/seatLifecycle.js:withdrawIdleOffer'],
        notes: 'withdrawIdleOffer: also sent for a seat that never left, to take an idle-seat offer down (both clients drop the offer on it and show nothing else).',
    },
    leftGame: {
        payload: null,
        status: 'active', to: 'self',
        clientReads: reads(W.game, I.game('registerSpectatorAndLazy')),
        emittedFrom: ['server/socket/seatLifecycle.js:leaveSeat', 'server/socket/chatHandlers.js:spectatorCommand', 'server/socket/chatHandlers.js:handleDrawPhaseLeave', 'server/socket/upgradeGate.js:replyLeave'],
    },

    // ==================== Presence ====================
    resignationAvailable: {
        payload: anyOf(
            variant('room', seatNotice),
            variant('private', obj({ position: ref('position'), username: str(), idle: konst(true) }, { optional: ['idle'] }))
        ),
        status: 'active', to: ['room', 'socket'], seq: false,
        added: ['idle'],
        clientReads: reads([W.game, W.main('onResignationAvailable')], [I.game('registerSpecialEvents'), 'iOSClient/BABOnline/State/Table/TableReducer+Events.swift:apply']),
        emittedFrom: ['server/socket/seatLifecycle.js:offer', 'server/socket/seatLifecycle.js:replayPresenceTo', 'server/socket/seatLifecycle.js:offerIdle'],
        notes: 'private: the replay to a returning socket, and the idle-seat offer at a tournament table (owner 2026-11-15; to the other present owners only, with idle: true, additive: web words its dialog by it; iOS 1.2.0 through 1.2.1 ignore it and show the seat as disconnected; iOS 1.2.2 reads it (WirePayload.ResignationAvailable, an optional Bool), keeps the seat connected and words its banner "<name> seems idle" / "Replace with a bot?" with Wait).',
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
        payload: obj({ position: ref('position'), username: str(), pic: ref('pic'), avatarUrl: ref('avatarUrl') }, { optional: ['avatarUrl'] }),
        status: 'active', to: 'room', seq: false,
        added: ['avatarUrl'],
        notes: 'One room broadcast: pic is a stock number or null; a custom picture is only avatarUrl (additive, only with a rendition; V1_REMOVALS #19 A).',
        clientReads: reads(W.game, I.game('registerSpectatorAndLazy')),
        emittedFrom: ['server/socket/seatLifecycle.js:goActive'],
    },
    spectatorJoined: {
        payload: anyOf(
            variant('fullState', obj({
                ...CARRIER_PROPS,
                avatarUrls: ref('avatarUrlsByPosition'),
                trump: orNull(ref('card')),
                snapshot: ref('snapshotV2'),
            }, { optional: ['avatarUrls'] })),
            variant('notice', obj({ username: str(), spectatorCount: int({ minimum: 0 }) })),
        ),
        status: 'active', to: ['room', 'self'], seq: false,
        added: ['snapshot', 'avatarUrls'],
        reserved: [
            { key: 'players', why: 'notice only: both clients route a payload with players + trump as the full state' },
            { key: 'trump', why: 'notice only: both clients route a payload with players + trump as the full state' },
        ],
        clientReads: reads([W.lobby, W.main('onSpectatorJoined'), ...CARRIER_READS.web], ['iOSClient/BABOnline/Networking/Wire/ServerEvent.swift:decode', ...CARRIER_READS.ios]),
        emittedFrom: ['server/socket/snapshotHandlers.js:sendSpectatorJoin'],
        notes: 'Split (V1_REMOVALS #8, 2026-11-12; sendSpectatorJoin, from joinAsSpectator and spectateTournamentGame): the notice goes to the room EXCEPT the joiner (socket.to(room), sequenced) and is sent first; then fullState to the joining socket only (socket.emit), whose snapshot is built after the notice, so snapshot.seq counts it and the joiner\'s next room event is snapshot.seq + 1. The joiner no longer gets its own notice (ctr-17). An owner watching their own lazy / resigned seat via joinAsSpectator (watchSeat \'spectate\') gets rejoinSuccess and sends no notice. Web and iOS 1.2.0 route a payload with a snapshot (or players + trump) as the full state, anything else as the notice, so neither changed. fullState is a snapshot carrier (V1_REMOVALS #9, 2026-11-12): gameId, players, avatarUrls (capable sockets with a URL), trump, snapshot; the cc865b4 legacy keys and the leadPosition / trumpBroken / teamTricks / oppTricks aliases (read only by the gated iOS builds) went.',
    },

    spectatorsUpdated: {
        payload: obj({
            gameId: str(),
            spectators: arr(ref('spectatorEntry'), { maxItems: 50 }),
            count: int({ minimum: 0 }),
        }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('register')),
        emittedFrom: ['server/game/spectatorRoster.js:flush'],
        notes: "Who is watching (owner, 2026-11-11: the table's spectator badge), the WHOLE list each time: GameState.spectatorList() (pure spectators, one per username in join order, never a seat owner or entrant), at most 50 entries, count the true total (the same as snapshot v2 `watching`; the older spectatorCount fields stay the spectator SOCKET count, cc865b4's meaning). Sent to the game room on every change (join, leave, disconnect, spectating another game, a round start, a reclaim), coalesced to one emit per game per 250 ms, skipped when unchanged, never after end/abort. UNSEQUENCED (no seq, no bump; GameState.emitUnsequenced): an absolute display state, and the App Store build (f05d264) registers no handler for it, so a sequenced form would open a gap in its seq gate on every change. The snapshot's `watching` carries the same {spectators, count}. iOS 1.1.0 reads nothing; iOS 1.2.0 routes it around its seq gate (ServerEvent.spectators) and shows the badge (V1_REMOVALS \"iOS spectator badge\").",
    },

    bidClock: {
        payload: anyOf(
            variant('running', obj({
                gameId: str(),
                position: ref('position'),
                running: konst(true),
                inMs: int({ minimum: 0, description: 'ms from emission until the server bids 0 for the seat (relative: measure from receipt with a monotonic clock, never compare with a wall clock)' }),
                durationMs: int({ minimum: 1, description: "the clock's full length (30000 by default), the countdown's scale" }),
            })),
            variant('stopped', obj({
                gameId: str(),
                position: ref('position'),
                running: konst(false),
                reason: enm('bid', 'timeout', 'turn', 'controller'),
            })),
        ),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('register')),
        emittedFrom: ['server/socket/bidClock.js:start', 'server/socket/bidClock.js:stop', 'server/socket/bidClock.js:resume'],
        notes: "The bid clock (owner 2026-11-18, every game; contract/README.md \"Bid clock\"): a human-controlled seat that has not bid 10 s (SeatState.BID_CLOCK_DELAY_MS) after its bid turn opened gets a 30 s clock (BID_CLOCK_MS, the length of bidclock.m4a, the tune the table plays); when it runs out the server bids '0' for the seat through the normal bid path, after the room log line \"<name> ran out of time.\". `running` carries the time left from emission (inMs) and the full length (durationMs): clients END-align the tune with the deadline and show the bidder a countdown with a small safety margin. `stopped` reasons: bid (the seat bid), timeout (the server is bidding 0 right after: let the tune's end cue ring), turn (the turn moved some other way, e.g. a new deal), controller (a bot took the seat: /lazy, AFK, resign, /leave). No stopped on gameEnd / abortGame (terminal games emit nothing): clients clear the clock on those and on every bidReceived / updateTurn / doneBidding / gameStart / destroyHands / snapshot without bidClock. A `running` is never sent before the 10 s pre-wait except on a same-turn resume (/active, reclaimSeat), which a client-side seq-gap replay of older events cannot clear. Bots never get one. UNSEQUENCED (no seq, no bump; GameState.emitUnsequenced), like spectatorsUpdated: the payload is absolute and every shipped iOS build (<= 1.2.3 (14)) registers no handler for it, so a sequenced form would open a gap in their seq gate on every clock start and stop; no clientHello cap (unknown unsequenced events are invisible to old clients). Timeouts in a row (BID_TIMEOUT_AFK_STRIKES, default 2): when a timeout is a connected seat's Nth in a row (casual tables, and tournament tables with no other owner present; not solo / AFK-exempt games, not with AFK_TIMEOUT_MS=0), a bot takes the seat in the same run: playerLazyMode and its \"was idle\" log line come after that bidReceived '0' and before the updateTurn / doneBidding / redeal it triggers. Shipped builds see only the log line and the ordinary bidReceived '0'; the next iOS build after 1.2.3 (14) registers it and routes it around its seq gate (ServerEvent.bidClock, decoded with seq nil: the tune, the bidder's countdown, the timeout toast). Snapshot v2 carries the running clock as the optional `bidClock`.",
    },

    seatLeft: {
        payload: obj({ gameId: str(), position: ref('position'), username: str() }),
        status: 'active', to: 'room', seq: false,
        clientReads: reads(W.game, I.game('register')),
        emittedFrom: ['server/socket/seatLifecycle.js:leaveSeat'],
        notes: "New (2026-11-19, additive): a seat's owner left the game for good (/leave from the seat or from watching a lazy / resigned seat: presence gone, absorbing; the bot keeps the seat). Before it the room heard a /leave from a human seat only as playerLazyMode (an already-lazy owner's not at all), the same as a /lazy owner still watching, and only a snapshot (seats[].presence gone) told them apart. Read by the web (state: GameState.applySeatLeft) and by the next iOS build after 1.2.3 (16) (GameSocketHandler, ServerEvent.seatLeft decoded with seq nil around its seq gate; TableReducer.seatLeft sets the seat's presence gone): voice runs only while another human is present (owner 2026-11-19, docs/claude/voice.md \"No voice alone\"; a gone owner no longer counts). UNSEQUENCED (no seq, no bump; GameState.emitUnsequenced): the fact is absorbing and a later snapshot shows it, and every shipped iOS build (<= 16) registers no handler for it, so a sequenced form would open a gap in their seq gate; no clientHello cap (unknown unsequenced events are invisible to old clients). Never sent from a terminal game; when the /leave ends the game (no owner left who could return) abortGame follows it in the same tick. Sent after the leaver's socket left the room, so the leaver never gets it.",
    },
    // ==================== /help ====================
    assistHint: {
        payload: obj({
            v: konst(1),
            source: enm('help', 'tutorial'),
            kind: enm('bid', 'card', 'tip', 'status'),
            turnKey: str({ description: 'game.turnKey() when it was answered: a client drops a hint whose turnKey is not the current turn' }),
            headline: str({ description: 'the suggestion ("Bid 4", "Lead A♣") or, for kind status, the whole reply (a refusal, the off-turn status line)' }),
            reasons: arr(str(), { maxItems: 2 }),
            uses: int({ minimum: 0, description: 'counted /help uses of this player this game, this one included' }),
            freeUses: int({ minimum: 0, description: 'free uses per game (3); more makes the game bot-assisted for the player' }),
            assisted: bool(),
            counted: bool({ description: 'this answer was counted (false: a forced move, a re-ask on a turn already counted, a status reply)' }),
            details: arr(str(), { maxItems: 4 }),
            confidence: enm('only', 'certain', 'clear', 'close', 'any', 'quick'),
            suggest: anyOf(obj({ bid: str() }), obj({ card: ref('card') })),
            codes: arr(str()),
            tipId: str(),
            actions: arr(enm('keep', 'off')),
            note: str(),
        }, { optional: ['details', 'confidence', 'suggest', 'codes', 'tipId', 'actions', 'note'] }),
        status: 'active', to: 'socket', seq: false,
        clientReads: reads(W.game, I.game('register')),
        emittedFrom: ['server/socket/assistHandlers.js:help', 'server/socket/assistHandlers.js:sendStatus'],
        notes: "New (2026-11-18, /help plan H2c; private, unsequenced. Web reads it from 2026-11-19 (H3: the clientHello cap assist, client/src/ui/components/AssistCard.js above the hand, the suggested card or bid ringed, cleared on the events below; a reply whose turnKey's stage, seat or bid count is not the current turn's is dropped); iOS from the build after 1.2.3 (17) (H4)). Only to a socket that sent the clientHello cap assist ($defs.clientCapAssist), as the reply to its own /help or ?help (chatMessage); every other socket gets the same reply as private gameLogEntry lines. kind bid / card: the bid or card a Mary bot would choose in that seat (server/game/assist), with up to 2 reasons, up to 4 details (a 'Why?' expander), the confidence (UI labels: Only legal card, Sure thing, Clear choice, Close call, Any card works, Quick suggestion) and suggest; note carries the warning on the last free use or 'This game now counts as bot-assisted for you.' on the use that crosses it. kind status: no suggestion (headline is the whole reply: a bot plays the seat, the rate limit, nothing to suggest, the off-turn status line, an error, players only, once the game starts), never counted. source tutorial, kind tip, tipId and actions are reserved for the tutorial (not sent yet). Every text is at most 280 characters. Clear it on the next updateTurn, the player's own bidReceived / cardPlayed, hand end, or a turnKey that is not the current turn's. iOS (the build after 1.2.3 (17)) sends the cap and reads it (GameSocketHandler; ServerEvent.assistHint decoded with seq nil, every field optional but kind and headline; TableReducer+Assist: AssistCardView above the hand or the bid panel, the suggested card's glow, the suggested bid's ring, the lightbulb by the hand); builds <= 17 never send the cap, so they keep the private lines.",
    },

    // ==================== Profile ====================
    profileResponse: {
        payload: okFail({ profile: ref('profile'), avatarUrl: ref('avatarUrl'), scope: statsScope }, { optional: ['avatarUrl', 'scope'] }),
        status: 'active', to: 'self',
        added: ['avatarUrl', 'scope'],
        notes: SCOPE_ECHO_NOTE,
        clientReads: reads(W.profile, I.profile),
        emittedFrom: ['server/socket/profileHandlers.js:getProfile'],
    },
    profilePicUpdateResponse: {
        payload: okFail({ profilePic: int({ minimum: 1, maximum: 82 }) }),
        status: 'active', to: 'self',
        clientReads: reads(W.profile, I.profile),
        emittedFrom: ['server/socket/profileHandlers.js:updateProfilePic'],
    },
    profilePicUploadResponse: {
        payload: okFail({ customProfilePic: str(), avatarUrl: ref('avatarUrl') }, { optional: ['avatarUrl'] }),
        status: 'active', to: 'self',
        added: ['avatarUrl'],
        clientReads: reads(W.profile, I.profile),
        emittedFrom: ['server/socket/profileHandlers.js:uploadProfilePic'],
    },
    searchPlayersResponse: {
        // query: the request's query as sent, on every answer to a non-blank
        // one (additive 2026-11-15): web drops a reply to an older query
        payload: anyOf(
            variant('success', obj({ success: konst(true), players: arr(ref('playerSearchRow')), avatarUrls: ref('avatarUrlsByUsername'), query: str() }, { optional: ['avatarUrls', 'query'] })),
            variant('failure', obj({ success: konst(false), message: str(), query: str() }, { optional: ['query'] })),
        ),
        status: 'active', to: 'self',
        added: ['avatarUrls', 'query'],
        notes: 'query (2026-11-15) echoes the request\'s query so web search-as-you-type ignores a stale reply; iOS never sends searchPlayers.',
        clientReads: reads(W.profile, []),
        emittedFrom: ['server/socket/profileHandlers.js:searchPlayers'],
    },
    playerProfileResponse: {
        payload: okFail({ profile: ref('profile'), avatarUrl: ref('avatarUrl'), scope: statsScope }, { optional: ['avatarUrl', 'scope'] }),
        status: 'active', to: 'self',
        added: ['avatarUrl', 'scope'],
        notes: SCOPE_ECHO_NOTE,
        clientReads: reads(W.profile, I.profile),
        emittedFrom: ['server/socket/profileHandlers.js:getPlayerProfile'],
    },
    leaderboardResponse: {
        payload: okFail({ leaderboard: arr(ref('leaderboardRow')), avatarUrls: ref('avatarUrlsByUsername'), scope: statsScope }, { optional: ['avatarUrls', 'scope'], failScope: true }),
        status: 'active', to: 'self',
        added: ['avatarUrls', 'scope'],
        notes: 'Every row has customProfilePic null; custom pictures are avatarUrls {username: url} (V1_REMOVALS #19 B, docs/avatars.md). iOS 1.2.0 (build 6, the App Store build) shows no leaderboard picture; the next iOS build (after 1.2.0 build 6) shows avatarUrls[username], else the stock profilePic, in Stats. ' + SCOPE_ECHO_NOTE,
        clientReads: reads(W.board, I.board),
        emittedFrom: ['server/socket/profileHandlers.js:getLeaderboard'],
    },
    recordsResponse: {
        payload: okFail({
            records: obj({ allTime: ref('recordsPeriod'), thisYear: ref('recordsPeriod'), thisMonth: ref('recordsPeriod') }, { open: true }),
            totalGames: int({ minimum: 0 }),
            periodGames: obj({ allTime: int({ minimum: 0 }), thisYear: int({ minimum: 0 }), thisMonth: int({ minimum: 0 }) }),
            scope: statsScope,
        }, { optional: ['scope'], failScope: true }),
        status: 'active', to: 'self',
        added: ['scope', 'periodGames'],
        notes: 'iOS reads it from the next iOS build (after 1.2.0 build 6: the Records tab of Stats); every field optional there (a missing period or record shows "No games yet"). In the bots / all scopes a record\'s `players` lists the humans, then the bot personas (\'🤖 Mary\'); a team of two bots never holds a team record. totalGames is the scope\'s ALL-TIME game count (unchanged for shipped clients); periodGames (additive 2026-11-14) is the game count of each period, the same scope filter and period boundaries (server-local year / month) as that period\'s records, so periodGames.allTime equals totalGames. The web shows each period\'s count on its column; iOS 1.2.1 build 9 shows the selected period\'s (falling back to totalGames for All Time only, against a server without periodGames). ' + SCOPE_ECHO_NOTE,
        clientReads: reads(W.records, I.records),
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
            variant('spectator', obj({ ...tournamentStateProps(), isSpectator: konst(true) }, { optional: ['winners', 'readyDeadlinePassed'] })),
        ),
        status: 'active', to: 'self',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:joinTournament', 'server/socket/tournamentHandlers.js:spectateTournament', 'server/socket/tournamentHandlers.js:returnToTournament'],
    },
    tournamentPlayerJoined: {
        payload: obj({ username: str(), players: arr(ref('tournamentPlayer')), scoreboard }),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:joinTournament', 'server/socket/seatLifecycle.js:reattachTournament'],
        notes: 'scoreboard (additive, 2026-11-11): the whole sorted scoreboard, the joiner\'s new row included; web redraws the lobby\'s table from it, iOS from 1.2.2 (build 10) replaces its scoreboard with it when present; iOS up to 1.2.1 reads only players.',
    },
    tournamentPlayerLeft: {
        payload: obj({ username: str(), players: arr(ref('tournamentPlayer')), newCreator: orNull(str()), reason: konst('hostIdle') }, { optional: ['username', 'reason'] }),
        status: 'active', to: 'tournament',
        added: ['reason'],
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:leaveTournament', 'server/socket/queueHandlers.js:handleDisconnect', 'server/socket/tournamentHandlers.js:releaseStaleTournamentSeat', 'server/socket/tournamentLiveness.js:handOffHost'],
        notes: 'username is absent when the leaver had no registered user (user?.username). reason \'hostIdle\' (additive 2026-11-15): nobody left; the idle host (username, still a member) handed the role to newCreator (tournamentLiveness.handOffHost). Web and iOS 1.2.0 read only players and newCreator, which is what moves Begin / Cancel: web toasts "X is now the tournament host" and drops the old host\'s controls, iOS 1.2.0 sets creatorUsername (the old host\'s buttons go, the new host\'s appear); iOS from 1.2.2 (build 10) also shows the web\'s toast when newCreator differs from the host it had (reason is still not read: the idle hand-off\'s tournamentMessage notice says why).',
    },
    tournamentReadyUpdate: {
        payload: obj({ players: arr(ref('tournamentPlayer')), allReady: bool(), readyDeadlinePassed: bool() }, { optional: ['readyDeadlinePassed'] }),
        status: 'active', to: 'tournament',
        added: ['readyDeadlinePassed'],
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:tournamentReady', 'server/socket/tournamentHandlers.js:tournamentUnready', 'server/socket/tournamentHandlers.js:rollbackRound', 'server/socket/tournamentLiveness.js:onReadyDeadline'],
        notes: 'readyDeadlinePassed (additive 2026-11-15, between rounds only): the ready deadline passed, so the host\'s Begin starts the round with the host and the ready members and the rest sit out; sent at the deadline and after a rolled-back start too. allReady keeps its meaning (every connected member ready). Web enables Begin as "Start with ready players"; iOS up to 1.2.1 ignores it and keeps Begin disabled until all are ready (the idle host hands the role on once, and the next idle spell gets the round started by the server: tournamentLiveness); iOS from 1.2.2 (build 10) reads it optionally here and on tournamentJoined (absent: unchanged / not passed), enables Begin as "Start with ready players" and marks the members who would sit out (TournamentBegin).',
    },
    tournamentMessage: {
        payload: ref('tournamentChatLine'),
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:tournamentChat', 'server/socket/tournamentHandlers.js:spectateTournament', 'server/socket/tournamentHandlers.js:rollbackRound', 'server/socket/tournamentLiveness.js:onReadyDeadline', 'server/socket/tournamentLiveness.js:handOffHost', 'server/socket/tournamentLiveness.js:startForIdleHost'],
        notes: 'system: true and type: \'system\' (additive, 2026-11-15) mark a server notice (spectateTournament, rollbackRound, the ready deadline, the idle-host hand-off and the server start past the deadline); a player line has neither, so a player who registered "System" before it was reserved cannot pass for one. Web styles by system; iOS 1.2.0 (ChatMessage.from reads type) shows type \'system\' as a dim line without the name and without the report/block menu. username stays \'System\'; iOS 1.2.0 filters lines by blocked username before reading type, so blocking a legacy "System" account hides notices there.',
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
        emittedFrom: ['server/socket/tournamentHandlers.js:broadcastRoundOutcome', 'server/socket/tournamentHandlers.js:rollbackRound'],
        notes: 'rollbackRound (2026-11-15) sends it again, unchanged in shape, when a start past the ready deadline got no table: the members who sat out had gone to the round screen on tournamentRoundStart, and this puts both clients (web setTournamentPhase, iOS 1.2.0 phase / isReady) back between rounds, ready cleared as on the server.',
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
        emittedFrom: ['server/socket/tournamentHandlers.js:leaveTournament', 'server/socket/tournamentHandlers.js:returnToTournament', 'server/socket/upgradeGate.js:replyLeave', 'server/socket/tournamentHandlers.js:releaseStaleTournamentSeat'],
    },
    tournamentCancelled: {
        payload: empty,
        status: 'active', to: 'tournament',
        clientReads: reads(W.tour, I.tour),
        emittedFrom: ['server/socket/tournamentHandlers.js:cancelTournament'],
    },


    // ==================== Admin panel (web; iOS from 1.2.2 build 10) ====================
    adminResponse: {
        payload: anyOf(
            variant('failure', obj({
                requestId: str(), action: str(), ok: konst(false),
                error: enm('forbidden', 'invalid', 'not_found', 'refused', 'last_admin', 'stale_plan', 'server'),
                message: str(),
            })),
            adminOk('searchPlayers', { players: arr(adminPlayerRow) }),
            adminOk('createResetLink', { username: str(), token: str({ pattern: '^[A-Za-z0-9_-]{43}$' }), expiresAt: str() }),
            adminOk('signOutEverywhere', { username: str(), revokedSessions: int({ minimum: 0 }), disconnected: int({ minimum: 0 }) }),
            adminOk('findDuplicates', { groups: arr(arr(obj({ username: str(), gamesPlayed: num(), botGamesPlayed: num(), createdAt: isoOrNull() }))) }),
            adminOk('planMerge', { plan: mergePlanView, planHash: str({ pattern: '^[0-9a-f]{64}$' }) }),
            adminOk('applyMerge', {
                result: obj({
                    target: str(), statsMerged: arr(str()), retired: arr(str()), gameRecords: int({ minimum: 0 }),
                    reports: int({ minimum: 0 }), otherUsersBlocks: int({ minimum: 0 }), chainedTombstones: int({ minimum: 0 }),
                    profilePic: bool(), signedOut: int({ minimum: 0 }),
                }),
            }),
            adminOk('listReports', { reports: arr(adminReportRow) }),
            adminOk('resolveReport', { report: adminReportRow }),
            adminOk('listAdmins', { admins: arr(obj({ username: str(), adminSince: isoOrNull() })) }),
            adminOk('setAdmin', { username: str(), isAdmin: bool(), changed: bool() }),
            adminOk('listAudit', { entries: arr(adminAuditRow), hasMore: bool() }),
            adminOk('listPlayers', { players: arr(adminPlayerRow), total: int({ minimum: 0 }), limit: int({ minimum: 1 }) }),
            adminOk('renameAccount', {
                username: str(), newName: str(), resumed: bool(), oldNameKept: bool(),
                gameRecords: int({ minimum: 0 }), reports: int({ minimum: 0 }), otherUsersBlocks: int({ minimum: 0 }),
                chainedTombstones: int({ minimum: 0 }), adminSetBy: int({ minimum: 0 }), resetLinks: int({ minimum: 0 }),
                revokedSessions: int({ minimum: 0 }), signedOut: int({ minimum: 0 }),
            }),
            adminOk('deleteAccount', {
                username: str(), kind: enm('account', 'tombstone'), mergedInto: orNull(str()),
                gameRecords: int({ minimum: 0 }), reports: int({ minimum: 0 }), blockLists: int({ minimum: 0 }),
                resetLinks: int({ minimum: 0 }), tombstones: int({ minimum: 0 }), signedOut: int({ minimum: 0 }),
            }),
        ),
        status: 'active', to: 'self',
        clientReads: reads('client/src/admin/adminApi.js:createAdminApi', 'iOSClient/BABOnline/Networking/Handlers/AdminSocketHandler.swift:register'),
        emittedFrom: ['server/socket/adminHandlers.js:adminRequest'],
        notes: 'The reply to adminRequest, to the requesting socket only (requestId and action echoed). failure: forbidden = not an admin right now (the one uniform refusal for every action and target: no account information), invalid = bad args or a wrong typed confirmation, not_found / refused / last_admin / stale_plan (the merge changed since its preview: preview again) / server; message is for the admin. createResetLink.token is the one-time link secret (/reset#<token>): shown to the admin once, never logged or audited. planMerge.plan is formatPlan\'s content as data (no picture bytes); planHash fingerprints the whole plan and applyMerge applies only when a fresh plan has the same hash. listPlayers: every account newest first, at most `limit` (500) rows; `total` is the true count (the panel says when the list is capped). deleteAccount: kind \'account\' = the player\'s own deletion (server/admin/accountDelete.js; counts of what changed), \'tombstone\' = only that merged / renamed name was removed (mergedInto names the account it pointed at, which is unchanged). renameAccount: username is the old name, newName the new; every saved session was revoked (the player signs in once with the new name); the old name became a redirect (oldNameKept; mergedInto + renamedAt, so sign-in with the old name and the account\'s password says "This account is now called X"; nobody else is told the new name); resumed = a second rename with the same names finished a partial one (also when the redirect was never written: oldNameKept then says whether it is now); a player row\'s renamed = that redirect, renameUnfinished = on a live account, the old name of its rename that stopped partway (the panel\'s Finish rename sends renameAccount {username: old, newName: the row}); an admin cannot rename their own account (refused). applyMerge / deleteAccount / renameAccount wait in one queue and are authorized again when their turn comes (forbidden if the admin lost the flag or was signed out meanwhile). iOS (from 1.2.2 build 10): AdminSocketHandler hands the reply to AdminApi by requestId (a dictionary read: unknown keys ignored, missing ones defaulted; State/Admin/AdminModels.swift); the reset token is kept in memory only while its sheet is open and never logged. iOS 1.2.0 / 1.2.1 register no handler and never get one (the reply goes only to the requesting socket).',
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
    voicePeerList: {
        payload: obj({ peers: arr(ref('voicePeer')) }),
        status: 'active', to: 'self',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/seatLifecycle.js:announceOwnerVoice', 'server/voice/gameVoice.js:announceSpectator', 'server/socket/playAgain.js:voiceAtReturn'],
        notes: 'Since 2026-11-16 joinLobby lists (and voicePeerJoined goes to) mapped lobby members only: a seat held for its reload grace has a dead socket and a play-again hold none. At a play-again return (server/socket/playAgain.js) each moved member gets the moved members before it in row order (playAgain cap only). The receiver offers to every listed peer. A casual game\'s voice room (2026-11-16, server/voice/gameVoice.js) adds capable spectators: a newly admitted one gets the players (and, while spectators may talk, the spectators admitted before it), a returning owner (reconnect, /active reclaim) gets the voice spectators too; a block list that is loaded leaves a pair out.',
    },
    voicePeerJoined: {
        payload: ref('voicePeer'),
        status: 'active', to: 'socket',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/mainRoomHandlers.js:joinLobby', 'server/socket/lobbyHandlers.js:lobbySeatResumed', 'server/socket/seatLifecycle.js:announceOwnerVoice', 'server/voice/gameVoice.js:announceSpectator', 'server/socket/playAgain.js:voiceAtReturn'],
    },
    voicePeerLeft: {
        payload: anyOf(variant('room', obj({ socketId: str() })), variant('private', obj({ socketId: str() }))),
        status: 'active', to: ['room', 'socket'], seq: false,
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/socket/seatLifecycle.js:disconnectOwner', 'server/socket/seatLifecycle.js:watchSeat', 'server/socket/lobbyHandlers.js:leaveLobby', 'server/socket/lobbyHandlers.js:releaseStaleLobbySeat', 'server/socket/queueHandlers.js:handleDisconnect', 'server/socket/lobbyHandlers.js:lobbySeatSuspended', 'server/socket/lobbyHandlers.js:startExtras', 'server/voice/gameVoice.js:removeVoiceSpectator', 'server/voice/gameVoice.js:playerLeftVoice', 'server/voice/gameVoice.js:endBlockedCall', 'server/socket/playAgain.js:voiceAtReturn', 'server/socket/playAgain.js:endLingeringEntry', 'server/socket/playAgain.js:leftOnResults'],
        notes: 'room: a game seat owner dropped (game.broadcast); private: lobby peers (io.to(socketId)) and, since 2026-11-16, a game\'s voice peers: a voice spectator leaving (to the members, never the room), an entrant dropping or leaving during the draw, a demoted owner socket (watchSeat, both ways), a blocked pair (both ways), the spectator talk switch and its backstop (server/voice/gameVoice.js). Play again (2026-11-16, server/socket/playAgain.js), private, both ways: at a lobby-born game\'s end between the members moved back to the lobby and every other socket of the game\'s voice room (main-room spectators, owners not moved) except an older-app owner still on the score screen, whose calls with them linger until it leaves that screen (joinMainRoom, another entry point, a disconnect) or the lobby starts or goes. Every shipped iOS build only drops the peer on a private one.',
    },
    voiceSettings: {
        payload: obj({
            gameId: str(),
            host: orNull(str()),
            spectatorsCanTalk: bool(),
            role: enm('player', 'spectator', 'none'),
            canTalk: bool(),
            canChange: bool(),
        }),
        status: 'active', to: 'socket',
        clientReads: reads(W.voice, I.voice),
        emittedFrom: ['server/voice/gameVoice.js:sendVoiceSettings'],
        notes: 'New (2026-11-16, family lobbies; private, unsequenced, read by no shipped iOS build). Read by the web (handlers/voiceHandlers.js -> main.js onVoiceSettings) and iOS from 1.2.2 (build 12) (VoiceSocketHandler.applyVoiceSettings). Only to a socket that sent the casualSpectators cap, in a casual game (one started from a lobby; never a tournament table or the ambient demo): at the start (the table\'s players and the extras), on spectating or admission, as the answer to a setSpectatorsCanTalk from the game, when an owner drops, returns or reclaims a seat, and when an entrant leaves. role: player (a seat owner / entrant in voice), spectator (admitted to the voice room), none (a capable spectator refused: voice is full, 8 people). Since 2026-11-18 (owner: no spectator talk switch) spectatorsCanTalk is always true, canTalk is true for a player and a spectator (false only with role none) and canChange is always false (iOS 12-15 then hide their in-game switch); every field stays for the builds that read them. Until then canTalk could be false for a spectator (the switch off, or a main-room stranger at an all-legacy table), whose listen-only SDP the server gated, and canChange named who could send setSpectatorsCanTalk. host: the lobby host\'s username.',
    },
    voiceIceServers: {
        payload: obj({
            iceServers: arr(ref('iceServer'), { minItems: 1 }),
            turn: bool(),
            expiresInSec: orNull(int({ minimum: 0 })),
            requestId: str(),
        }, { optional: ['requestId'] }),
        status: 'active', to: 'self',
        clientReads: reads('client/src/voice/VoiceChatManager.js:fetchIceServers', I.voice),
        emittedFrom: ['server/socket/voiceHandlers.js:getVoiceIceServers'],
        notes: 'The reply to getVoiceIceServers. iceServers is an RTCPeerConnection iceServers list: turn true = Cloudflare TURN (username / credential on the turn: / turns: entry, valid expiresInSec more seconds; port-53 URLs dropped), false = the public STUN servers both clients used before (expiresInSec null). requestId echoes the request\'s. Never the API token.',
    },

    // ==================== Connection ====================
    serverShutdown: {
        payload: obj({ message: str() }),
        status: 'active', to: 'all',
        clientReads: reads([W.auth, W.main('onServerShutdown')], ['iOSClient/BABOnline/Networking/SocketService.swift:handleServerShutdown']),
        emittedFrom: ['server/utils/shutdown.js:gracefulShutdown'],
        notes: 'Every deploy (SIGTERM -> gracefulShutdown): sent to every socket, which is closed about 1 s later (a transport close, so the clients reconnect by themselves). Kept (owner 2026-11-11, V1_REMOVALS #17): web shows a restart banner and, after reconnect, what ended (the game, the watched game, the lobby or the tournament the player was in; nothing for the main room); the message text is not read. iOS 1.1.0 ignores it (no handler); iOS 1.2 shows a "Restarting for an update" toast and, after the restore, one alert for what ended (RestartNotice.swift; the message text is not read).',
    },
    serverError: {
        payload: obj({ code: ref('serverErrorCode'), message: str(), handler: orNull(str()) }),
        status: 'active', to: 'self',
        clientReads: reads([W.main('onServerFailure'), 'client/src/admin/adminApi.js:createAdminApi#reads:code,handler'], ['iOSClient/BABOnline/Networking/SocketService.swift:handleServerError']),
        emittedFrom: ['server/socket/serverError.js:emitError', 'server/socket/chatHandlers.js:sendError'],
        notes: "Every app-level server error (V1_REMOVALS #1): the wrappers' rate limit / Joi validation / unexpected exception, a handler's refusal, a chat command error. Phase A (2026-11-11) added it as the twin of the v1 `error`; phase B (2026-11-12, once iOS 1.1.0 was gated) dropped `error`, so this is the only copy. code: rateLimit / validation / server, or rejected (a handler's {message} refusal); handler: the c2s event it answers (the registered socket.on name: errorHandler options.event, else the schema; or the handler that refused; the chat events: mainRoomChat / lobbyChat / tournamentChat, in-game chat chatMessage), null when unknown. Read by web (main.js onServerFailure: a toast, and a table resync for playCard / playerBid / requestSnapshot; adminApi.js fails a dropped admin request fast as rate_limited on {code:'rateLimit', handler:'adminRequest'}) and iOS 1.2.0 (SocketService handleServerError: toast + routeTableError); its own name because Socket.IO-Client-Swift reserves 'error' for transport errors (clientEvent .error, which 1.2.0 still listens to for those). Gated builds 1 and 2 never get it (upgradeGate.js registers no handler for them).",
    },
};

function tournamentStateProps() {
    // tournamentClientState's properties (spectator variant extends them)
    const { defs } = require('./defs');
    return defs.tournamentClientState.properties;
}

// ---------- seq (contract/README.md R1-R5) ----------
// Every room broadcast (GameState.broadcast / terminate) carries a required
// top-level `seq`, and so does gameStart (one value per deal). Where an
// event also has a private form, only the room variant has it. Derived from
// observation: these are exactly the events emitted to game:<id> rooms.
const SEQ_EVENTS = {
    startDraw: null, playerDrew: null, positionUpdate: null, teamsAnnounced: null, createUI: null,
    bidReceived: null, doneBidding: null, destroyHands: null, rainbow: null, cardPlayed: null,
    trickComplete: null, handComplete: null, gameEnd: null, abortGame: null, gameLogEntry: ['room'],
    playerReconnected: null, playerResigned: null, playerLazyMode: null, playerActiveMode: null,
    chatMessage: ['humanOrSpectator', 'bot'],
    gameStart: ['seat', 'spectator'],
    updateTurn: ['room'],
    playerDisconnected: ['room'],
    resignationAvailable: ['room'],
    spectatorJoined: ['notice'],
    voicePeerLeft: ['room'],
};

const withSeq = (s) => ({
    ...s,
    properties: { ...s.properties, seq: ref('seq') },
    required: [...(s.required || []), 'seq'],
});

for (const [event, variants] of Object.entries(SEQ_EVENTS)) {
    const entry = s2c[event];
    if (variants === null) {
        entry.payload = withSeq(entry.payload);
    } else {
        entry.payload = { ...entry.payload, anyOf: entry.payload.anyOf.map((v) => (variants.includes(v.variant) ? withSeq(v) : v)) };
    }
    entry.seq = true;
    entry.added = [...(entry.added || []), 'seq'];
}

module.exports = { s2c, SEQ_EVENTS };
