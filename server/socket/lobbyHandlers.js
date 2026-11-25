/**
 * Lobby socket event handlers
 * Handles pre-game lobby: ready status, chat, and leaving
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { emitError } = require('./serverError');
const { beginDraw, emitLobbiesUpdated } = require('./gameLifecycle');
const { delay } = require('../utils/timing');
const pacing = require('../game/pacing');
const { botController, personalities } = require('../game/bot');
const { getDisplayName } = personalities;
const gameVoice = require('../voice/gameVoice');
const clientInfo = require('./clientInfo');
const { isGyb, seatsOf } = require('../game/gameMode');
const playAgain = require('./playAgain');

/**
 * playerReadyUpdate (the plain 'neither' variant) to every human member of
 * `lobby`, or only to `onlyTo`: the player list plus the additive members /
 * host / settings / capacity. Used by the ready paths, bots, held seats and
 * the host's "Spectators can talk" switch.
 */
function sendLobbyState(io, lobby, { except = null, onlyTo = null, own = {} } = {}) {
    for (const player of lobby.players) {
        if (gameManager.isBot(player.socketId) || player.socketId === except) continue;
        // A play-again hold has no socket
        if (playAgain.isAwayId(player.socketId)) continue;
        if (onlyTo && player.socketId !== onlyTo) continue;
        io.to(player.socketId).emit('playerReadyUpdate', gameManager.lobbyWire(lobby, own, { to: player.socketId }));
    }
}

/**
 * Handle player marking themselves as ready
 */
async function playerReady(socket, io) {
    // (play again: acting in the lobby means it is on the lobby screen; the
    // others' lists lose its "Still on the results" with the update below,
    // or with announceSettled when there is none)
    const settled = playAgain.settle(socket.id);
    const result = gameManager.setPlayerReady(socket.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'playerReady');
        // The table filled first (a lobby of more than 4): this member
        // watches; its list is sent again so a client showing it ready resyncs
        if (result.tableFull && result.lobby) sendLobbyState(io, result.lobby, { onlyTo: socket.id });
        playAgain.announceSettled(io, settled, socket.id);
        return;
    }

    const lobby = result.lobby;

    // Auto-ready the bots that play: all of them in a lobby of 4 (as
    // before), the table bots once the table is full in a bigger one
    gameManager.readyBotsAfterHumanReady(lobby.id);

    // Broadcast ready status update to all lobby members (skip bots)
    lobby.players.forEach(player => {
        if (!gameManager.isBot(player.socketId)) {
            io.to(player.socketId).emit('playerReadyUpdate', gameManager.lobbyWire(lobby, { readySocketId: socket.id }, { to: player.socketId }));
        }
    });

    socketLogger.info('Player marked ready', {
        socketId: socket.id,
        lobbyId: lobby.id,
        readyCount: lobby.readyPlayers.size
    });

    // Starts the game once all 4 are ready (including auto-readied bots)
    await startLobbyIfAllReady(io, lobby);
}

/**
 * The shared tail of every path that can leave a lobby with all 4 seats
 * ready (a human's playerReady; addBot filling a lobby whose humans are
 * all ready already): after LOBBY_START_MS the lobby becomes a game
 * (startGameFromLobby re-validates: a seat that unreadied, left or was
 * removed meanwhile stops it), the humans join the game room and get
 * allPlayersReady, and after the countdown the draw begins. Does nothing
 * unless every seat is ready now.
 */
async function startLobbyIfAllReady(io, lobby) {
    if (!gameManager.lobbyTableReady(lobby)) return;

    socketLogger.info('All players ready, starting game', { lobbyId: lobby.id });

    // Small delay before transitioning to draw phase. A raw delay: no
    // game exists yet, and startGameFromLobby re-validates the lobby
    const lobbyMs = pacing().LOBBY_START_MS;
    pacing.trace('lobby', lobbyMs);
    await delay(lobbyMs);

    const startResult = gameManager.startGameFromLobby(lobby.id, io);
    if (!startResult.success) return;

    const game = startResult.game;
    const onTable = new Set(startResult.players);

    // Register the table's bots with bot controller (reveal real
    // personality names); a bot sitting out was never registered
    for (const player of lobby.players) {
        if (player.isBot && onTable.has(player.socketId)) {
            const personality = gameManager.lobbyBotPersonality(lobby, player.socketId);
            const realName = `🤖 ${getDisplayName(personality)}`;
            const bot = botController.createBot(realName, personality);
            bot.socketId = player.socketId; // Use existing socket ID
            botController.registerBot(game.gameId, bot);
        }
    }

    // Join all human players to game room
    startResult.players.forEach(socketId => {
        if (!gameManager.isBot(socketId)) {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
                playerSocket.join(game.roomName);
            }
        }
    });

    // Emit allPlayersReady to the table's humans only (every client opens
    // the draw as an entrant on it)
    startResult.players.forEach(socketId => {
        if (!gameManager.isBot(socketId)) {
            io.to(socketId).emit('allPlayersReady', {
                gameId: game.gameId,
                // additive: a Get Your Bid table (3 seats; gameMode.js)
                ...(isGyb(game) ? { mode: game.mode } : {})
            });
        }
    });

    startExtras(io, game, startResult.extras || []);
    // Play again: members still reading the last game's results are not
    // made spectators of this one (leftLobby, their calls end)
    playAgain.leftOnResults(io, startResult);
    // Every capable socket of the voice room learns its role (nothing for a
    // legacy client)
    gameVoice.refreshVoice(io, game);

    // The started lobby leaves the main room's list now (it used to stay
    // listed until the first deal). Only for a lobby with a capable member
    // (the family-lobby feature), so a lobby of legacy clients keeps the
    // wire byte-identical (wireGolden)
    if (startResult.lobby?.capable?.size > 0) emitLobbiesUpdated(io);

    // After another delay, start the draw phase (false: the game
    // was aborted meanwhile)
    if (!(await game.hold('countdown', pacing(game).PREDRAW_COUNTDOWN_MS))) return;

    // Deck, startDraw, bot draws, and auto-draws for anyone who
    // left or disconnected during the countdown
    beginDraw(io, game);
}

/**
 * A removal from a lobby of more than 4 (a leave, an expired or evicted held
 * seat, a sign-out, a removed bot) readied the bots it brought onto the
 * table (GameManager.readyTableBotsIfFull: the table is full with every seat
 * ready): every member gets the list (unless the caller just sent it) and
 * the lobby starts through the ready path's tail, as if the last human had
 * readied now. Without this the lobby sat with every human ready and
 * nothing started it.
 */
function tableBotsReadied(io, lobby, { sendState = true } = {}) {
    if (!lobby) return;
    if (sendState) sendLobbyState(io, lobby);
    startLobbyIfAllReady(io, lobby).catch((err) => {
        socketLogger.error('Lobby start after a removal failed', { lobbyId: lobby.id, error: err?.message });
    });
}

/**
 * The extras of a family lobby (members who did not get a seat; always
 * capable clients, since a lobby holds more than 4 only then) watch the new
 * game, in the same tick as the table's allPlayersReady: pure spectators
 * (spectatorJoined full state at CREATED, no room notice per extra: the
 * badge lists them), then voice spectators. Their lobby calls to the table
 * and to each other carry on (no new announcement at start): spectators
 * always may talk (owner 2026-11-18).
 */
function startExtras(io, game, extras) {
    if (extras.length === 0) return;
    const { sendSpectatorJoin } = require('./snapshotHandlers');
    let admitted = 0;
    for (const { socketId, username } of extras) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        if (!gameManager.addSpectator(io, game, socketId, username, null)) continue;
        socket.leave('mainRoom');
        gameManager.leaveMainRoom(socketId);
        sendSpectatorJoin(game, socket, username, { notice: false });
        if (gameVoice.admitVoiceSpectator(io, game, socketId, { fromLobby: true, announce: false })) admitted++;
    }
    socketLogger.info('Lobby extras now watch the game', { gameId: game.gameId, extras: extras.length, voice: admitted });
}

/**
 * Handle lobby chat message
 */
function lobbyChat(socket, io, data) {
    const { message } = data;
    // (a chat line carries no list: the others are told it settled)
    playAgain.announceSettled(io, playAgain.settle(socket.id), socket.id);

    if (!message || message.trim().length === 0) {
        return;
    }

    const { filterProfanity } = require('../utils/profanityFilter');
    const result = gameManager.addLobbyMessage(socket.id, filterProfanity(message.trim()));

    if (!result.success) {
        socketLogger.debug('Lobby chat rejected', { socketId: socket.id, error: result.error });
        return;
    }

    const lobby = result.lobby;
    const chatMessage = result.chatMessage;

    // Broadcast message to all lobby members
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('lobbyMessage', {
            lobbyId: lobby.id,
            username: chatMessage.username,
            message: chatMessage.message,
            timestamp: chatMessage.timestamp
        });
    });

    socketLogger.debug('Lobby chat message', {
        lobbyId: lobby.id,
        username: chatMessage.username
    });
}

/**
 * Handle player unmarking themselves as ready
 */
function playerUnready(socket, io) {
    const settled = playAgain.settle(socket.id);
    const result = gameManager.unsetPlayerReady(socket.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'playerUnready');
        playAgain.announceSettled(io, settled, socket.id);
        return;
    }

    const lobby = result.lobby;

    // Broadcast ready status update to all lobby members
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('playerReadyUpdate', gameManager.lobbyWire(lobby, { unreadySocketId: socket.id }, { to: player.socketId }));
    });

    socketLogger.info('Player marked unready', {
        socketId: socket.id,
        lobbyId: lobby.id,
        readyCount: lobby.readyPlayers.size
    });
}

/**
 * Handle player leaving lobby
 */
function leaveLobby(socket, io) {
    const result = gameManager.leaveLobby(socket.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'leaveLobby');
        return;
    }

    const user = gameManager.getUserBySocketId(socket.id);

    // Auto-rejoin main room
    const lists = clientInfo.listOpts(socket);
    const mainRoomResult = gameManager.joinMainRoom(socket.id, lists);
    socket.join('mainRoom');

    // Compute online users once so count and list always agree
    const onlineUsers = gameManager.getOnlineUsernames();

    // Notify leaving player they're back to main room
    socket.emit('leftLobby', {});
    socket.emit('mainRoomJoined', {
        messages: mainRoomResult.messages,
        lobbies: mainRoomResult.lobbies,
        onlineCount: onlineUsers.length,
        onlineUsers,
        inProgressGames: gameManager.getInProgressGames(mainRoomResult.username, { gyb: lists.gyb }),
        tournaments: gameManager.getAllTournaments()
    });

    // Notify main room of updated lobby list
    emitLobbiesUpdated(io);

    // If lobby was deleted (no players left), nothing more to do
    if (result.lobbyDeleted) {
        socketLogger.info('Player left lobby (lobby deleted)', {
            socketId: socket.id,
            username: user?.username
        });
        return;
    }

    const lobby = result.lobby;

    socketLogger.info('Player left lobby', {
        socketId: socket.id,
        username: user?.username,
        lobbyId: lobby.id,
        remainingPlayers: lobby.players.length
    });

    // Notify remaining players
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('lobbyPlayerLeft', gameManager.lobbyWire(lobby, {
            leftUsername: user?.username || 'Unknown',
            needsMorePlayers: result.needsMorePlayers
        }, { withReconnecting: false, to: player.socketId }));

        // Notify remaining human players that this peer left voice
        if (!gameManager.isBot(player.socketId)) {
            io.to(player.socketId).emit('voicePeerLeft', {
                socketId: socket.id
            });
        }
    });

    // A lobby of more than 4 whose table the leave filled with bots
    if (result.botsReadied) tableBotsReadied(io, lobby);
}

/**
 * A user's lobby seat left an older socket of theirs (GameManager
 * takeOverLobbySeat moved it to the new socket, or evictStaleLobbySeat gave
 * up a seat in another lobby). Existing events only: the old socket gets
 * leftLobby (a half-open socket never receives it; a second live tab of the
 * same device goes back to the main room), and the lobby's other humans drop
 * the old socket's voice peer. On an eviction the remaining players also get
 * lobbyPlayerLeft, as for a leave. The caller sends lobbiesUpdated and the
 * join notifications.
 *
 * @param {Object} io
 * @param {Object} change { oldSocketId, newSocketId, lobby } for a takeover,
 *   { oldSocketId, newSocketId, leaveResult, username } for an eviction
 */
function releaseStaleLobbySeat(io, change) {
    if (!change || !change.oldSocketId) return;
    const { oldSocketId, newSocketId } = change;

    // tellOld false: the old socket is someone else now (it switched
    // accounts). A play-again hold (`away:` id) never had a socket: nobody
    // to tell, and no voice peer to drop
    const away = playAgain.isAwayId(oldSocketId);
    if (change.tellOld !== false && !away) io.to(oldSocketId).emit('leftLobby', {});

    const leave = change.leaveResult;
    const lobby = leave ? (leave.lobbyDeleted ? null : leave.lobby) : change.lobby;
    if (!lobby) return;

    lobby.players.forEach(player => {
        if (player.socketId === newSocketId || playAgain.isAwayId(player.socketId)) return;
        if (leave) {
            io.to(player.socketId).emit('lobbyPlayerLeft', gameManager.lobbyWire(lobby, {
                leftUsername: change.username || 'Unknown',
                needsMorePlayers: leave.needsMorePlayers
            }, { withReconnecting: false, to: player.socketId }));
        }
        if (!gameManager.isBot(player.socketId) && !away) {
            io.to(player.socketId).emit('voicePeerLeft', { socketId: oldSocketId });
        }
    });

    // A lobby of more than 4 whose table the eviction / expiry filled with bots
    if (leave?.botsReadied) tableBotsReadied(io, lobby);

    socketLogger.info(leave ? 'Stale lobby seat given up' : 'Lobby seat moved to new socket', {
        oldSocketId,
        newSocketId,
        lobbyId: lobby.id
    });
}

/**
 * A lobby seat's socket dropped and the seat is held for its grace
 * (GameManager.suspendLobbySeat): the lobby's other humans get the player
 * list (playerReadyUpdate: both clients redraw the seats from it; iOS
 * 1.1.0 shows the player as not ready) with `reconnecting` naming the
 * held seats (additive: every playerReadyUpdate carries it while a seat
 * is held; web shows "Reconnecting…") and drop the old socket's voice
 * peer. The caller sends lobbiesUpdated.
 */
function lobbySeatSuspended(io, lobby, oldSocketId) {
    lobby.players.forEach(player => {
        if (player.socketId === oldSocketId || gameManager.isBot(player.socketId)) return;
        io.to(player.socketId).emit('playerReadyUpdate', gameManager.lobbyWire(lobby, {}, { to: player.socketId }));
        io.to(player.socketId).emit('voicePeerLeft', { socketId: oldSocketId });
    });
    socketLogger.info('Lobby seat held for reconnection', {
        lobbyId: lobby.id, oldSocketId, graceMs: gameManager.constructor.LOBBY_SEAT_GRACE_MS
    });
}

/**
 * A held seat's own socket is live again as the same player
 * (GameManager.resumeHeldLobbySeat): the lobby's other humans get the list
 * without it under `reconnecting` and its voice peer back, the main room
 * the lobby list.
 */
function lobbySeatResumed(io, lobby, socketId, username) {
    lobby.players.forEach(player => {
        if (player.socketId === socketId || gameManager.isBot(player.socketId)) return;
        io.to(player.socketId).emit('playerReadyUpdate', gameManager.lobbyWire(lobby, {}, { to: player.socketId }));
        io.to(player.socketId).emit('voicePeerJoined', { socketId, username });
    });
    emitLobbiesUpdated(io);
    socketLogger.info('Held lobby seat resumed by its own socket', { lobbyId: lobby.id, socketId });
}

/**
 * Nobody came back for a held seat (GameManager.expireLobbySeat): it left,
 * as a leave (lobbyPlayerLeft to the rest; the lobby is gone when no human
 * is left), and the main room's list updates.
 */
function lobbySeatExpired(io, expired, { tellOld = true } = {}) {
    if (!expired) return;
    releaseStaleLobbySeat(io, { oldSocketId: expired.oldSocketId, newSocketId: null, leaveResult: expired.leaveResult, username: expired.username, tellOld });
    emitLobbiesUpdated(io);
    socketLogger.info('Held lobby seat expired', {
        lobbyId: expired.lobbyId, lobbyDeleted: Boolean(expired.leaveResult?.lobbyDeleted)
    });
}

/**
 * Handle adding a bot to the lobby. When the bot fills a lobby whose humans
 * are all ready already (Ready first, then Add Bot), the bots are readied
 * before the player list goes out, so that playerReadyUpdate shows all 4
 * ready, and the game starts through the ready path's tail, exactly as if
 * the last human had readied now (owner report 2026-11-13: the lobby sat
 * full until a human unreadied and readied again).
 */
async function addBot(socket, io) {
    const settled = playAgain.settle(socket.id);
    const lobby = gameManager.getPlayerLobby(socket.id);

    if (!lobby) {
        emitError(socket, { message: 'Not in a lobby' }, 'addBot');
        return;
    }

    // (a place saved for the last game's player counts: play again)
    if (lobby.players.length >= seatsOf(lobby) || playAgain.reservationBlocks(lobby)) {
        emitError(socket, { message: 'Lobby is full' }, 'addBot');
        playAgain.announceSettled(io, settled, socket.id);
        return;
    }

    const result = gameManager.addBotToLobby(lobby.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'addBot');
        playAgain.announceSettled(io, settled, socket.id);
        return;
    }

    socketLogger.info('Bot added to lobby', {
        lobbyId: lobby.id,
        botName: result.botPlayer.username,
        playerCount: lobby.players.length
    });

    // A full lobby whose humans are all ready: ready its bots now
    const allReady = gameManager.readyBotsIfHumansReady(lobby.id);

    // Broadcast updated player list to all human lobby members
    sendLobbyState(io, lobby);

    // Also update main room lobby list
    emitLobbiesUpdated(io);

    if (allReady) await startLobbyIfAllReady(io, lobby);
}

/**
 * Handle removing a bot from the lobby
 */
function removeBot(socket, io, data) {
    const { botSocketId } = data;
    const settled = playAgain.settle(socket.id);

    const lobby = gameManager.getPlayerLobby(socket.id);

    if (!lobby) {
        emitError(socket, { message: 'Not in a lobby' }, 'removeBot');
        return;
    }

    const result = gameManager.removeBotFromLobby(lobby.id, botSocketId);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'removeBot');
        playAgain.announceSettled(io, settled, socket.id);
        return;
    }

    socketLogger.info('Bot removed from lobby', {
        lobbyId: lobby.id,
        botSocketId,
        playerCount: lobby.players.length
    });

    // Broadcast updated player list to all human lobby members
    sendLobbyState(io, lobby);

    // Also update main room lobby list
    emitLobbiesUpdated(io);

    // A lobby of more than 4 whose table another bot filled again
    if (result.botsReadied) tableBotsReadied(io, lobby, { sendState: false });
}

/**
 * setSpectatorsCanTalk in a lobby (shipped iOS 12-15 and cached web tabs
 * still show the old host switch): ignored since 2026-11-18, spectators
 * always may talk. The sender alone gets the list with the unchanged
 * settings ({spectatorsCanTalk: true}, playerReadyUpdate); no error,
 * whoever sends it. The echo repeats the value the client holds, which
 * those clients do not take as the answer, so their switch shows Off until
 * their own 5 s echo timeout puts it back On. It still counts as acting in
 * the lobby (play again: settle).
 * @returns {boolean} handled (the socket is in a lobby)
 */
function setLobbySpectatorsCanTalk(socket, io) {
    const lobby = gameManager.getPlayerLobby(socket.id);
    if (!lobby) return false;
    const settled = playAgain.settle(socket.id);
    sendLobbyState(io, lobby, { onlyTo: socket.id });
    playAgain.announceSettled(io, settled, socket.id);
    return true;
}

module.exports = {
    setLobbySpectatorsCanTalk,
    tableBotsReadied,
    playerReady,
    playerUnready,
    lobbyChat,
    leaveLobby,
    releaseStaleLobbySeat,
    lobbySeatSuspended,
    lobbySeatExpired,
    lobbySeatResumed,
    addBot,
    removeBot
};
