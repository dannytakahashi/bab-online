/**
 * Main room socket event handlers
 * Handles global chat and lobby browsing before joining a game lobby
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { emitError } = require('./serverError');
const { Controller, Presence } = require('../game/SeatState');
const seatLifecycle = require('./seatLifecycle');
const { sendSpectatorJoin } = require('./snapshotHandlers');
const { releaseStaleLobbySeat, leaveLobby } = require('./lobbyHandlers');
const { emitLobbiesUpdated } = require('./gameLifecycle');
const { deletedSince } = require('../admin/accountDelete');
const clientInfo = require('./clientInfo');
const gameVoice = require('../voice/gameVoice');
const playAgain = require('./playAgain');
const tournamentVoice = require('../voice/tournamentVoice');
const pointerResolve = require('./pointerResolve');
const { MODE, GYB_CAP, GYB_UNSUPPORTED, isGyb } = require('../game/gameMode');

/** Did `socket` announce casualSpectators (a lobby of up to 8, spectator voice)? */
const isCapable = (socket) => clientInfo.hasCap(socket, gameVoice.CAP);

/**
 * Handle player joining the main room
 */
function joinMainRoom(socket, io) {
    // An older app's Return to Lobby from the score screen: its calls with
    // the players who went back to the lobby end now (play again, lingering)
    playAgain.endLingering(io, socket.id, 'joinMainRoom');
    // Off the tournament lobby screen: out of its voice room
    tournamentVoice.leaveSocket(io, socket.id);

    // Back in the main room: a pure spectator stops watching its game
    // (never affects a seat owner's socket)
    gameManager.leaveSpectating(io, socket.id);

    // Still in a lobby: leave it as the Leave button does (leftLobby + mainRoomJoined
    // to this socket, lobbyPlayerLeft to the others). GameManager.joinMainRoom alone
    // dropped the seat silently: an iOS tap on New Game right after a reconnect,
    // before the restore's joinMainRoom, left the app on a lobby screen whose Leave
    // the server then refused (owner, 2026-11-12, buttons dead after a long background)
    if (gameManager.playerLobbies.has(socket.id) && gameManager.getUserBySocketId(socket.id)) {
        leaveLobby(socket, io);
        return;
    }

    // Play again: someone whose game ended while they were offline comes
    // back on a capable client into the lobby that kept their place (the
    // ordinary joinLobby flow: lobbyCreated, no mainRoomJoined). Never an
    // away hold (they chose the main room) or a legacy socket
    if (autoClaimHold(socket, io)) return;

    const lists = clientInfo.listOpts(socket);
    const result = gameManager.joinMainRoom(socket.id, lists);

    if (!result.success) {
        emitError(socket, { message: result.error || 'Failed to join main room' }, 'joinMainRoom');
        return;
    }

    // Join the Socket.IO room for main room broadcasts
    socket.join('mainRoom');

    // Compute online users once so count and list always agree
    const onlineUsers = gameManager.getOnlineUsernames();

    // Send initial state to the player. Both clients read the chat replay
    // from messages (iOS 1.1.0: recentMessages ?? messages); the
    // recentMessages copy is only in the upgrade gate's 1.0.0 payload
    // (V1_REMOVALS #13)
    socket.emit('mainRoomJoined', {
        messages: result.messages,
        lobbies: result.lobbies,
        onlineCount: onlineUsers.length,
        onlineUsers,
        inProgressGames: gameManager.getInProgressGames(result.username, { gyb: lists.gyb }),
        tournaments: gameManager.getAllTournaments()
    });

    // Notify others of new player
    socket.to('mainRoom').emit('mainRoomPlayerJoined', {
        username: result.username,
        onlineCount: onlineUsers.length,
        onlineUsers
    });

    socketLogger.info('Player joined main room', {
        socketId: socket.id,
        username: result.username,
        onlineCount: onlineUsers.length
    });
}

/**
 * The joinMainRoom auto-claim of a play-again place (playAgain.autoClaimTarget:
 * an offline hold, or the seat of a moved member whose older socket never
 * acted in the lobby, i.e. a restore off the score screen): only for a
 * socket with the playAgain cap, signed in, with no membership, whose user
 * is not merge-locked. @returns {boolean} the socket is in that lobby now
 */
function autoClaimHold(socket, io) {
    if (!clientInfo.hasCap(socket, playAgain.CAP)) return false;
    const user = gameManager.getUserBySocketId(socket.id);
    if (!user || gameManager.isMergeLocked(user.username) || gameManager.activityOf(socket.id)) return false;
    const hold = playAgain.autoClaimTarget(user.username, socket.id);
    if (!hold) return false;
    joinLobby(socket, io, { lobbyId: hold.lobbyId });
    const claimed = gameManager.playerLobbies.get(socket.id) === hold.lobbyId;
    if (claimed) socketLogger.info('Play again: offline hold claimed on joinMainRoom', { socketId: socket.id, lobbyId: hold.lobbyId });
    return claimed;
}

/**
 * Handle main room chat message
 */
function mainRoomChat(socket, io, data) {
    const { message } = data;

    if (!message || message.trim().length === 0) {
        return;
    }

    if (!gameManager.isInMainRoom(socket.id)) {
        emitError(socket, { message: 'Not in main room' }, 'mainRoomChat');
        return;
    }

    const { filterProfanity } = require('../utils/profanityFilter');
    const result = gameManager.addMainRoomMessage(socket.id, filterProfanity(message.trim()));

    if (!result.success) {
        emitError(socket, { message: result.error }, 'mainRoomChat');
        return;
    }

    // Broadcast to all in main room
    io.to('mainRoom').emit('mainRoomMessage', {
        username: result.chatMessage.username,
        message: result.chatMessage.message,
        timestamp: result.chatMessage.timestamp
    });

    socketLogger.debug('Main room chat', {
        username: result.chatMessage.username
    });
}

/**
 * Handle player creating a new game lobby
 */
function createLobby(socket, io, data) {
    const { name, mode } = data || {};
    // Get Your Bid (gameMode.js) only from a client that can show it
    if (mode === MODE.GYB && !clientInfo.hasCap(socket, GYB_CAP)) {
        emitError(socket, { message: GYB_UNSUPPORTED }, 'createLobby');
        return;
    }
    playAgain.endLingering(io, socket.id, 'createLobby');
    // Off the tournament lobby screen: out of its voice room
    tournamentVoice.leaveSocket(io, socket.id);

    const { filterProfanity } = require('../utils/profanityFilter');
    const result = gameManager.createNamedLobby(socket.id, name ? filterProfanity(name) : name, { capable: isCapable(socket), io, mode });

    if (!result.success) {
        emitError(socket, { message: result.error }, 'createLobby');
        return;
    }

    // A seat this user held elsewhere from an older socket was given up
    if (result.evicted) {
        releaseStaleLobbySeat(io, { ...result.evicted, newSocketId: socket.id, username: result.lobby.createdBy });
    }
    // Or a tournament lobby membership (GameManager.giveUpStaleTournament)
    require('./tournamentHandlers').releaseStaleTournamentSeat(io, result.evictedTournament, result.lobby.createdBy);

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify the player
    socket.emit('lobbyCreated', gameManager.lobbyWire(result.lobby, {
        messages: result.lobby.messages,
        name: result.lobby.name
    }, { withReconnecting: false, to: socket.id }));

    // Notify main room of new lobby
    emitLobbiesUpdated(io);

    socketLogger.info('Player created lobby', {
        socketId: socket.id,
        lobbyId: result.lobby.id,
        lobbyName: result.lobby.name
    });
}

/**
 * Handle player joining a specific lobby
 */
function joinLobby(socket, io, data) {
    const { lobbyId } = data;

    if (!lobbyId) {
        emitError(socket, { message: 'Lobby ID required' }, 'joinLobby');
        return;
    }
    playAgain.endLingering(io, socket.id, 'joinLobby');
    // Off the tournament lobby screen: out of its voice room
    tournamentVoice.leaveSocket(io, socket.id);

    // A lobby that just became a game: one of its extras (a reload during
    // the start) watches that game instead; anyone else, a table member
    // included, gets 'Lobby not found' as before
    if (!gameManager.getLobbyById(lobbyId) && isCapable(socket)) {
        const user = gameManager.getUserBySocketId(socket.id);
        const gameId = user ? gameManager.startedLobbyRedirect(lobbyId, user.username) : null;
        if (gameId && !gameManager.activityOf(socket.id)) {
            socketLogger.info('joinLobby for a started lobby: spectating its game', { socketId: socket.id, lobbyId, gameId });
            joinAsSpectator(socket, io, { gameId }, { fromLobby: true });
            return;
        }
    }

    const result = gameManager.joinSpecificLobby(socket.id, lobbyId, {
        capable: isCapable(socket), io, gyb: clientInfo.hasCap(socket, GYB_CAP)
    });

    if (!result.success) {
        emitError(socket, { message: result.error }, 'joinLobby');
        return;
    }

    const lobby = result.lobby;

    // This socket holds its seat here already (it took a held seat back in
    // place): it gets the lobby again; the others were told on the resume
    if (result.alreadySeated) {
        // (play again: a re-entry means it is on the lobby screen; the
        // others' rows lose its "Still on the results")
        playAgain.announceSettled(io, playAgain.settle(socket.id), socket.id);
        socket.leave('mainRoom');
        socket.emit('lobbyCreated', gameManager.lobbyWire(lobby, { messages: lobby.messages, name: lobby.name }, { to: socket.id }));
        // Mapped members only: a held seat's socket is gone (a reload) or
        // never existed (a play-again hold)
        const peers = lobby.players
            .filter(p => p.socketId !== socket.id && !gameManager.isBot(p.socketId) && gameManager.playerLobbies.get(p.socketId) === lobby.id)
            .map(p => ({ socketId: p.socketId, username: p.username }));
        if (peers.length > 0) socket.emit('voicePeerList', { peers });
        return;
    }

    // Re-entry from a new socket: the seat moved here from the older one
    // (or a seat in another lobby was given up). The joined notifications
    // below carry the updated list.
    if (result.replacedSocketId) {
        releaseStaleLobbySeat(io, { oldSocketId: result.replacedSocketId, newSocketId: socket.id, lobby });
    } else if (result.evicted) {
        releaseStaleLobbySeat(io, { ...result.evicted, newSocketId: socket.id, username: result.newPlayer.username });
    }
    // Or a tournament lobby membership (GameManager.giveUpStaleTournament)
    require('./tournamentHandlers').releaseStaleTournamentSeat(io, result.evictedTournament, result.newPlayer?.username);

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify the joining player (with the seats held for a reconnect)
    socket.emit('lobbyCreated', gameManager.lobbyWire(lobby, { messages: lobby.messages, name: lobby.name }, { to: socket.id }));

    // Notify existing players in the lobby
    const existingHumans = [];
    lobby.players.forEach(player => {
        if (player.socketId !== socket.id && !playAgain.isAwayId(player.socketId)) {
            io.to(player.socketId).emit('lobbyPlayerJoined', gameManager.lobbyWire(lobby, {
                newPlayer: result.newPlayer
            }, { withReconnecting: false, to: player.socketId }));

            // Send voicePeerJoined to existing human players: mapped
            // members only (a seat held for its reload grace has a dead
            // socket, a play-again hold none)
            if (!gameManager.isBot(player.socketId) && gameManager.playerLobbies.get(player.socketId) === lobby.id) {
                existingHumans.push({ socketId: player.socketId, username: player.username });
                io.to(player.socketId).emit('voicePeerJoined', {
                    socketId: socket.id,
                    username: result.newPlayer.username
                });
            }
        }
    });

    // Send voicePeerList to the joining player
    if (existingHumans.length > 0) {
        socket.emit('voicePeerList', { peers: existingHumans });
    }

    // Notify main room of updated lobbies
    emitLobbiesUpdated(io);

    socketLogger.info('Player joined lobby', {
        socketId: socket.id,
        lobbyId: lobby.id,
        playerCount: lobby.players.length
    });
}

/**
 * Handle player joining a game as a spectator
 */
function joinAsSpectator(socket, io, data, { fromLobby = false, resolved = false } = {}) {
    const { gameId } = data;
    playAgain.endLingering(io, socket.id, 'joinAsSpectator');
    // Off the tournament lobby screen: out of its voice room
    tournamentVoice.leaveSocket(io, socket.id);

    // The ambient demo game is "not found" outside its audience (owner,
    // 2026-11-14: AMBIENT_CHAT_USERS, default test1), the same reply as an
    // unknown or ended game
    const user = gameManager.getUserBySocketId(socket.id);
    const game = gameManager.getGameVisibleTo(gameId, user?.username);
    if (!game) {
        // LIVE_PERSIST=on: a game in no memory here may be saved or held by
        // another instance (pointerResolve): resolved, adopted or parked;
        // then this runs again (resolved) and finds it, or "not found"
        if (!resolved && user && pointerResolve.active() && !gameManager.getGameById(gameId)) {
            return pointerResolve.resolveThen(socket, gameId, 'joinAsSpectator', {
                onGame: () => joinAsSpectator(socket, io, data, { fromLobby, resolved: true }),
                onGone: () => emitError(socket, { message: 'Game not found' }, 'joinAsSpectator')
            });
        }
        emitError(socket, { message: 'Game not found' }, 'joinAsSpectator');
        return;
    }

    if (!user) {
        emitError(socket, { message: 'User not found' }, 'joinAsSpectator');
        return;
    }
    // A Get Your Bid table: only a client that can show one (its own
    // seat's owner too: an app without the mode cannot draw the table)
    if (isGyb(game) && !clientInfo.hasCap(socket, GYB_CAP)) {
        emitError(socket, { message: GYB_UNSUPPORTED }, 'joinAsSpectator');
        return;
    }

    // An owner of this game comes back to their own seat, not as a spectator
    // (never from a lobby seat, another game or another tournament:
    // GameManager.activityOf; never a seat of an account deleted since the
    // game began: accountDelete.deletedSince)
    const ownPos = deletedSince(user.username, game.createdAt) ? null : game.seatByUsername(user.username);
    const ownSeat = ownPos ? game.seat(ownPos) : null;
    const watches = ownSeat && ownSeat.controller !== Controller.HUMAN &&
        (ownSeat.presence === Presence.CONNECTED || ownSeat.presence === Presence.AWAY);
    const returns = ownSeat && ownSeat.controller === Controller.HUMAN &&
        (ownSeat.presence === Presence.GRACE || ownSeat.presence === Presence.RESIGNABLE);
    const other = watches || returns ? gameManager.activityBesides(socket.id, game.gameId) : null;
    if (other) {
        socketLogger.warn('Spectate refused: socket belongs elsewhere', { socketId: socket.id, gameId, kind: other.kind });
        emitError(socket, { message: gameManager.membershipError(other) }, 'joinAsSpectator');
        return;
    }
    if (watches) {
        // Lazy or resigned seat: watch it while the bot plays (/active works)
        seatLifecycle.watchSeat(io, game, ownPos, socket, user.username, { via: 'spectate' });
        return;
    }
    if (returns) {
        socket.leave('mainRoom');
        gameManager.leaveMainRoom(socket.id);
        seatLifecycle.reconnectOwner(io, game, ownPos, socket, user.username);
        return;
    }

    // A pure spectator (of one game at a time), in the game's room
    if (!gameManager.addSpectator(io, game, socket.id, user.username, null)) {
        socketLogger.warn('Spectate refused: socket is in a game', { socketId: socket.id, gameId });
        emitError(socket, { message: 'Leave your current game before spectating another' }, 'joinAsSpectator');
        return;
    }

    // Leave main room
    socket.leave('mainRoom');
    gameManager.leaveMainRoom(socket.id);

    sendSpectatorJoin(game, socket, user.username);

    // A casual game's voice room, for a capable client (voiceSettings; it
    // joins muted and asks for the mic only when its player taps to
    // unmute). Nothing for a legacy client, a tournament table or the
    // ambient demo
    gameVoice.admitVoiceSpectator(io, game, socket.id, { fromLobby, announce: true });

    socketLogger.info('Player joined as spectator', {
        socketId: socket.id,
        username: user.username,
        gameId
    });
}

module.exports = {
    joinMainRoom,
    mainRoomChat,
    createLobby,
    joinLobby,
    // Counted as a restore in flight for requestSnapshot's deferral (LIVE_PERSIST=on)
    joinAsSpectator: pointerResolve.tracked(joinAsSpectator)
};
