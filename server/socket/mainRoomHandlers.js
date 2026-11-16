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

/** Did `socket` announce casualSpectators (a lobby of up to 8, spectator voice)? */
const isCapable = (socket) => clientInfo.hasCap(socket, gameVoice.CAP);

/**
 * Handle player joining the main room
 */
function joinMainRoom(socket, io) {
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

    const result = gameManager.joinMainRoom(socket.id, { wide: isCapable(socket) });

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
        inProgressGames: gameManager.getInProgressGames(result.username),
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
    const { name } = data || {};

    const { filterProfanity } = require('../utils/profanityFilter');
    const result = gameManager.createNamedLobby(socket.id, name ? filterProfanity(name) : name, { capable: isCapable(socket), io });

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

    const result = gameManager.joinSpecificLobby(socket.id, lobbyId, { capable: isCapable(socket), io });

    if (!result.success) {
        emitError(socket, { message: result.error }, 'joinLobby');
        return;
    }

    const lobby = result.lobby;

    // This socket holds its seat here already (it took a held seat back in
    // place): it gets the lobby again; the others were told on the resume
    if (result.alreadySeated) {
        socket.leave('mainRoom');
        socket.emit('lobbyCreated', gameManager.lobbyWire(lobby, { messages: lobby.messages, name: lobby.name }, { to: socket.id }));
        const peers = lobby.players
            .filter(p => p.socketId !== socket.id && !gameManager.isBot(p.socketId))
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
        if (player.socketId !== socket.id) {
            io.to(player.socketId).emit('lobbyPlayerJoined', gameManager.lobbyWire(lobby, {
                newPlayer: result.newPlayer
            }, { withReconnecting: false, to: player.socketId }));

            // Send voicePeerJoined to existing human players
            if (!gameManager.isBot(player.socketId)) {
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
function joinAsSpectator(socket, io, data, { fromLobby = false } = {}) {
    const { gameId } = data;

    // The ambient demo game is "not found" outside its audience (owner,
    // 2026-11-14: AMBIENT_CHAT_USERS, default test1), the same reply as an
    // unknown or ended game
    const user = gameManager.getUserBySocketId(socket.id);
    const game = gameManager.getGameVisibleTo(gameId, user?.username);
    if (!game) {
        emitError(socket, { message: 'Game not found' }, 'joinAsSpectator');
        return;
    }

    if (!user) {
        emitError(socket, { message: 'User not found' }, 'joinAsSpectator');
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

    // A casual game's voice room, for a capable client: listen-only at
    // first for a main-room spectator (voiceSettings; it asks for the mic
    // only when its player taps to talk). Nothing for a legacy client, a
    // tournament table or the ambient demo
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
    joinAsSpectator
};
