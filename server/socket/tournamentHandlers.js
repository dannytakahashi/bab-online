/**
 * Tournament socket event handlers.
 * Manages tournament lifecycle: create, join, ready, rounds, chat, spectating.
 */

const gameManager = require('../game/GameManager');
const TournamentState = require('../game/TournamentState');
const { socketLogger } = require('../utils/logger');
const { beginDraw, abortGame, emitLobbiesUpdated } = require('./gameLifecycle');
const { delay } = require('../utils/timing');
const { spectatorJoinState, snapshotFor } = require('./snapshotHandlers');
const { botController, BotPlayer, personalities } = require('../game/bot');
const { PERSONALITY_LIST, getDisplayName } = personalities;

/**
 * Create a new tournament from main room
 */
function createTournament(socket, io) {
    const user = gameManager.getUserBySocketId(socket.id);
    if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
    }

    const result = gameManager.createTournament(socket.id, `${user.username}'s Tournament`);
    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    const tournament = result.tournament;

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Join tournament room
    tournament.joinToRoom(io, socket.id);

    // Send tournament state to creator
    socket.emit('tournamentCreated', tournament.getClientState());

    // Notify main room
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    socketLogger.info('Tournament created', {
        socketId: socket.id,
        username: user.username,
        tournamentId: tournament.tournamentId
    });
}

/**
 * Join an existing tournament
 */
async function joinTournament(socket, io, data) {
    const { tournamentId } = data;
    if (!tournamentId) {
        socket.emit('error', { message: 'Tournament ID required' });
        return;
    }

    const result = gameManager.joinTournament(socket.id, tournamentId);
    if (!result.success) {
        socket.emit('error', { message: result.error });
        // An active member of another tournament stays where they are — only
        // genuinely unattached players get dropped into the main room (the
        // clients auto-emit joinTournament after sign-in, so a failure must
        // not strand them on a blank screen).
        if (result.error === 'Already in a tournament') {
            return;
        }
        const failedUser = gameManager.getUserBySocketId(socket.id);
        if (failedUser && !gameManager.getTournamentById(tournamentId)) {
            await gameManager.clearActiveTournament(failedUser.username);
        }
        sendToMainRoom(socket);
        return;
    }

    const tournament = result.tournament;
    const user = gameManager.getUserBySocketId(socket.id);

    // Leave main room
    socket.leave('mainRoom');

    // Join tournament room
    tournament.joinToRoom(io, socket.id);

    // Send full state to joining player
    socket.emit('tournamentJoined', tournament.getClientState());

    // Notify existing tournament players
    tournament.broadcast(io, 'tournamentPlayerJoined', {
        username: user.username,
        players: tournament.getClientState().players
    });

    // Notify main room
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    socketLogger.info('Player joined tournament', {
        socketId: socket.id,
        username: user.username,
        tournamentId
    });
}

/**
 * Send a player back to the main room (used after leaving a tournament or
 * when a tournament they reference no longer exists).
 */
function sendToMainRoom(socket) {
    const mainRoomResult = gameManager.joinMainRoom(socket.id);
    socket.join('mainRoom');
    const onlineUsers = gameManager.getOnlineUsernames();
    socket.emit('mainRoomJoined', {
        messages: mainRoomResult.messages,
        recentMessages: mainRoomResult.messages, // iOS reads this key
        lobbies: mainRoomResult.lobbies,
        onlineCount: onlineUsers.length,
        onlineUsers,
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });
}

/**
 * Leave a tournament
 */
async function leaveTournament(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    const user = gameManager.getUserBySocketId(socket.id);

    if (!tournament) {
        // Spectators aren't in playerTournaments — resolve via spectator maps
        for (const [, t] of gameManager.tournaments) {
            if (t.isSpectator(socket.id)) {
                t.removeSpectator(socket.id);
                t.leaveRoom(io, socket.id);
                socket.emit('tournamentLeft', {});
                sendToMainRoom(socket);
                socketLogger.info('Spectator left tournament', {
                    socketId: socket.id, tournamentId: t.tournamentId
                });
                return;
            }
        }

        // Nothing to leave (e.g. tournament already cleaned up) — still land
        // the player somewhere sane instead of erroring.
        socket.emit('tournamentLeft', {});
        sendToMainRoom(socket);
        return;
    }

    const tournamentId = tournament.tournamentId;

    // Leaving while their table is still before seating (the web client
    // shows the tournament lobby until startDraw) leaves that table too,
    // like /leave would: a bot takes the seat at the draw
    const tableId = gameManager.playerGames.get(socket.id);
    const table = tableId && gameManager.tournamentGames.get(tableId) === tournamentId
        ? gameManager.getGameById(tableId)
        : null;
    if (table && table.isPreSeating() && table.entrant(socket.id)) {
        require('./chatHandlers').handleDrawPhaseLeave(socket, io, table, { notify: false });
    }

    // Leave tournament room
    tournament.leaveRoom(io, socket.id);

    const result = gameManager.leaveTournament(socket.id);
    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    // The last member left: no game of a deleted tournament keeps running
    for (const game of result.orphanedGames || []) {
        abortGame(io, game, 'All players left').catch(err =>
            socketLogger.error('abortGame failed', { gameId: game.gameId, error: err.message }));
    }

    // Explicit leave is permanent — clear the DB pointer so future sign-ins
    // don't try to rejoin this tournament.
    if (user) {
        await gameManager.clearActiveTournament(user.username);
    }

    // Notify leaving player
    socket.emit('tournamentLeft', {});

    // Auto-rejoin main room
    sendToMainRoom(socket);

    if (result.deleted) {
        // Tournament was deleted — notify main room
        io.to('mainRoom').emit('lobbiesUpdated', {
            lobbies: gameManager.getAllLobbies(),
            inProgressGames: gameManager.getInProgressGames(),
            tournaments: gameManager.getAllTournaments()
        });
        socketLogger.info('Player left tournament (deleted)', {
            socketId: socket.id,
            username: user?.username,
            tournamentId
        });
        return;
    }

    // Notify remaining players
    tournament.broadcast(io, 'tournamentPlayerLeft', {
        username: user?.username,
        players: tournament.getClientState().players,
        newCreator: result.newCreator ? result.newCreator.username : null
    });

    // Notify main room
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    socketLogger.info('Player left tournament', {
        socketId: socket.id,
        username: user?.username,
        tournamentId
    });
}

/**
 * Toggle ready in tournament lobby
 */
function tournamentReady(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    if (!tournament) {
        socket.emit('error', { message: 'Not in a tournament' });
        return;
    }

    tournament.setReady(socket.id);

    tournament.broadcast(io, 'tournamentReadyUpdate', {
        players: tournament.getClientState().players,
        allReady: tournament.allPlayersReady()
    });
}

function tournamentUnready(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    if (!tournament) {
        socket.emit('error', { message: 'Not in a tournament' });
        return;
    }

    tournament.unsetReady(socket.id);

    tournament.broadcast(io, 'tournamentReadyUpdate', {
        players: tournament.getClientState().players,
        allReady: tournament.allPlayersReady()
    });
}

/**
 * Begin tournament (round 1) — creator only
 */
async function beginTournament(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    if (!tournament) {
        socket.emit('error', { message: 'Not in a tournament' });
        return;
    }

    if (tournament.createdBy !== socket.id) {
        socket.emit('error', { message: 'Only the creator can start the tournament' });
        return;
    }

    if (tournament.phase !== 'lobby') {
        socket.emit('error', { message: 'Tournament already started' });
        return;
    }

    if (!tournament.allPlayersReady()) {
        socket.emit('error', { message: 'Not all players are ready' });
        return;
    }

    // Flip the phase (and the start generation) synchronously before any
    // awaits so a double-click or retry can't pass the phase guard and start
    // round 1 twice, and so a cancel during the writes is noticed.
    const epoch = tournament.beginStart();
    const tournamentId = tournament.tournamentId;
    const usernames = Array.from(tournament.players.values(), p => p.username).filter(Boolean);

    try {
        // Set active tournament in DB for all players (one parallel batch)
        await Promise.all(usernames.map(u => gameManager.setActiveTournament(u, tournamentId)));

        // A leave or cancel may have cleared before one of these writes
        // landed: re-clear (scoped to this tournament) whoever is no longer in
        const members = new Set(tournament.isLive(epoch)
            ? Array.from(tournament.players.values(), p => p.username)
            : []);
        const gone = usernames.filter(u => !members.has(u));
        if (gone.length) await Promise.all(gone.map(u => gameManager.clearActiveTournament(u, tournamentId)));
        if (!tournament.isLive(epoch)) return;

        await startTournamentRound(io, tournament, 1, epoch);
    } catch (error) {
        if (tournament.phase === 'starting' && tournament.isLive(epoch)) {
            tournament.phase = 'lobby';
        }
        throw error;
    }
}

/**
 * Begin next round (rounds 2-4) — creator only
 */
async function beginNextRound(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    if (!tournament) {
        socket.emit('error', { message: 'Not in a tournament' });
        return;
    }

    if (tournament.createdBy !== socket.id) {
        socket.emit('error', { message: 'Only the creator can start the next round' });
        return;
    }

    if (tournament.phase !== 'between_rounds') {
        socket.emit('error', { message: 'Not between rounds' });
        return;
    }

    if (!tournament.allPlayersReady()) {
        socket.emit('error', { message: 'Not all players are ready' });
        return;
    }

    const nextRound = tournament.currentRound + 1;
    if (nextRound > tournament.totalRounds) {
        socket.emit('error', { message: 'Tournament is complete' });
        return;
    }

    // Same double-start protection as beginTournament
    const epoch = tournament.beginStart();

    try {
        await startTournamentRound(io, tournament, nextRound, epoch);
    } catch (error) {
        if (tournament.phase === 'starting' && tournament.isLive(epoch)) {
            tournament.phase = 'between_rounds';
        }
        throw error;
    }
}

// Round start timing: tournamentRoundStart is on screen this long before
// the tables exist, then every table shares one pre-draw countdown.
const ROUND_ANNOUNCE_MS = 1500;
const TABLE_COUNTDOWN_MS = 2000;

/** True while `tournament` is registered and generation `epoch` is current. */
function tournamentLive(tournament, epoch) {
    return tournament.isLive(epoch) &&
        gameManager.getTournamentById(tournament.tournamentId) === tournament;
}

/**
 * Start a tournament round: create every table, assign players, start every
 * draw together.
 *
 * Every table moves through each step at the same time:
 *   1. announce (tournamentRoundStart), wait ROUND_ANNOUNCE_MS
 *   2. create EVERY table synchronously (game, tournamentGames mapping, bots,
 *      round entry, game-room joins). The round's game set is final before
 *      any table can finish, and a cancel sees all of the tables or none
 *   3. one parallel batch of setActiveGame writes
 *   4. tournamentGameAssignment + allPlayersReady for every table
 *   5. one shared TABLE_COUNTDOWN_MS countdown (each table's game.pause)
 *   6. beginDraw for every table still alive
 * After every await the start re-checks the tournament generation: a cancel
 * or deletion stops it at once. The canceller has already aborted the tables
 * (any table still alive is aborted here); nothing more is created or sent.
 * @param {number} epoch - from tournament.beginStart()
 * @returns {Promise<boolean>} true if the round started
 */
async function startTournamentRound(io, tournament, roundNumber, epoch = tournament.epoch) {
    const live = () => tournamentLive(tournament, epoch);
    if (!live()) return false;

    // Shuffle player usernames (connected players only — disconnected members
    // keep their scores but sit out rounds until they reattach)
    const usernames = [];
    for (const [, player] of tournament.players) {
        if (player.connected !== false) {
            usernames.push(player.username);
        }
    }
    // Fisher-Yates shuffle
    for (let i = usernames.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [usernames[i], usernames[j]] = [usernames[j], usernames[i]];
    }

    const assignments = TournamentState.distributePlayersIntoGames(usernames);
    tournament.startRound(roundNumber);

    // Broadcast round start
    tournament.broadcast(io, 'tournamentRoundStart', {
        roundNumber,
        totalRounds: tournament.totalRounds,
        assignments: assignments.map(a => ({ humanCount: a.humans.length, botCount: a.botCount }))
    });

    await delay(ROUND_ANNOUNCE_MS);
    if (!live()) return false;

    // Create every table, no await in between
    const tables = [];
    for (const assignment of assignments) {
        const table = createRoundTable(io, tournament, assignment, roundNumber);
        if (table) tables.push(table);
    }

    // If every table was skipped (everyone left during the announce delay),
    // roll the round back so the tournament isn't stuck in round_active
    // waiting on games that don't exist.
    if (tables.length === 0) {
        rollbackRound(io, tournament, roundNumber);
        return false;
    }
    emitLobbiesUpdated(io);

    // The tournament is gone: abort whatever table is still alive (a cancel
    // already did; deletion stripped the mappings, so no tournament
    // follow-up runs) and stop
    const stop = () => {
        for (const { game } of tables) {
            if (game.isTerminal()) continue;
            abortGame(io, game, 'Tournament cancelled').catch(err =>
                socketLogger.error('abortGame failed', { gameId: game.gameId, error: err.message }));
        }
        socketLogger.info('Tournament round start stopped: tournament gone', {
            tournamentId: tournament.tournamentId, roundNumber
        });
        return false;
    };

    // Set active game in DB for every table's humans, one parallel batch
    await Promise.all(tables.flatMap(({ game, presentHumans }) =>
        presentHumans.map(u => gameManager.setActiveGame(u, game.gameId))));
    // A table aborted during the writes, or an entrant who left it during
    // them (leaveTournament / /leave), may have run its own clear before
    // the write landed: re-clear (scoped to that game). A disconnected
    // entrant keeps its pointer (it may still come back).
    const reclears = tables.flatMap(({ game, presentHumans, humanSocketIds }) =>
        presentHumans.filter((u, i) => game.isTerminal() ||
            game.entrant(humanSocketIds[i])?.presence === 'left')
            .map(u => gameManager.clearActiveGame(u, game.gameId)));
    if (reclears.length) await Promise.all(reclears);
    if (!live()) return stop();

    for (const { game, humanSocketIds: allSocketIds } of tables) {
        if (game.isTerminal()) continue;
        // Never assign a table to an entrant who already left it (or
        // dropped) during the writes: it already got tournamentLeft /
        // leftGame and the main room
        const humanSocketIds = allSocketIds.filter(id => game.entrant(id)?.presence === 'connected');
        for (const socketId of humanSocketIds) {
            io.to(socketId).emit('tournamentGameAssignment', {
                gameId: game.gameId,
                tournamentId: tournament.tournamentId,
                roundNumber
            });
        }
        // allPlayersReady to humans (iOS switches to the game screen)
        for (const socketId of humanSocketIds) {
            io.to(socketId).emit('allPlayersReady', {
                gameId: game.gameId
            });
        }
    }

    // One shared countdown (false: that table aborted meanwhile)
    const counted = await Promise.all(tables.map(({ game }) => game.pause(TABLE_COUNTDOWN_MS)));
    if (!live()) return stop();

    // Deck, startDraw, bot draws, and auto-draws for anyone who left or
    // disconnected during the countdown
    tables.forEach(({ game }, i) => {
        if (counted[i]) beginDraw(io, game);
    });

    socketLogger.info('Tournament round started', {
        tournamentId: tournament.tournamentId,
        roundNumber,
        gameCount: tables.length
    });
    return true;
}

/**
 * Create one table of a round (synchronous). A player who left or
 * disconnected during the announce delay is back-filled with a bot so the
 * game still has 4 participants; a table with no present human is skipped.
 * @returns {{ game: GameState, humanSocketIds: string[], presentHumans: string[] } | null}
 */
function createRoundTable(io, tournament, assignment, roundNumber) {
    const humanSocketIds = [];
    const presentHumans = [];
    for (const username of assignment.humans) {
        const playerInfo = tournament.getPlayerByUsername(username);
        if (playerInfo && playerInfo.connected !== false &&
            io.sockets.sockets.get(playerInfo.socketId) &&
            // Never steal a socket that is already mapped to another game
            !gameManager.playerGames.has(playerInfo.socketId)) {
            humanSocketIds.push(playerInfo.socketId);
            presentHumans.push(username);
        }
    }
    const botCount = assignment.botCount + (assignment.humans.length - presentHumans.length);

    if (humanSocketIds.length === 0) {
        // Nobody from this table is still here — skip it entirely
        socketLogger.warn('Skipping tournament game with no connected humans', {
            tournamentId: tournament.tournamentId, roundNumber
        });
        return null;
    }

    // A pure spectator (e.g. watching another tournament table) stops
    // spectating before it becomes an entrant
    for (const socketId of humanSocketIds) gameManager.leaveSpectating(io, socketId);

    // Create bot socket IDs
    const botSocketIds = [];
    const usedPersonalities = [];
    for (let i = 0; i < botCount; i++) {
        const available = PERSONALITY_LIST.filter(p => !usedPersonalities.includes(p));
        const personality = available[Math.floor(Math.random() * available.length)];
        usedPersonalities.push(personality);

        const realName = `🤖 ${getDisplayName(personality)}`;
        const bot = botController.createBot(realName, personality);
        botSocketIds.push({ socketId: bot.socketId, personality, bot });
    }

    const allSocketIds = [...humanSocketIds, ...botSocketIds.map(b => b.socketId)];

    // Create game via GameManager
    const game = gameManager.createGame(allSocketIds);

    // Map game to tournament
    gameManager.tournamentGames.set(game.gameId, tournament.tournamentId);

    // Register bots
    for (const botInfo of botSocketIds) {
        botInfo.bot.socketId = botInfo.socketId;
        botController.registerBot(game.gameId, botInfo.bot);
    }

    // Add game to tournament round
    tournament.addGameToRound(game.gameId, presentHumans, botCount);

    // Join the game room now, so an abort at any later point (a cancel
    // during the DB writes or the countdown) reaches every player here
    for (const socketId of humanSocketIds) {
        io.sockets.sockets.get(socketId)?.join(game.roomName);
    }

    return { game, humanSocketIds, presentHumans };
}

/** Undo startRound for a round that got no tables. */
function rollbackRound(io, tournament, roundNumber) {
    const startedRound = tournament.getCurrentRound();
    if (!startedRound || startedRound.roundNumber !== roundNumber || startedRound.games.size !== 0) return;
    tournament.rounds.pop();
    tournament.currentRound = roundNumber - 1;
    tournament.phase = roundNumber === 1 ? 'lobby' : 'between_rounds';
    tournament.broadcast(io, 'tournamentMessage', {
        username: 'System',
        message: 'Round could not start — no connected players.',
        isSpectator: false,
        timestamp: Date.now()
    });
    socketLogger.warn('Tournament round rolled back, no games created', {
        tournamentId: tournament.tournamentId, roundNumber
    });
}

/**
 * Tournament chat
 */
function tournamentChat(socket, io, data) {
    const { message } = data;
    if (!message || message.trim().length === 0) return;

    const tournament = gameManager.getPlayerTournament(socket.id);
    // Also check if they're a spectator
    let isSpectator = false;
    let foundTournament = tournament;

    if (!foundTournament) {
        // Check spectators
        for (const [, t] of gameManager.tournaments) {
            if (t.isSpectator(socket.id)) {
                foundTournament = t;
                isSpectator = true;
                break;
            }
        }
    }

    if (!foundTournament) {
        socket.emit('error', { message: 'Not in a tournament' });
        return;
    }

    const { filterProfanity } = require('../utils/profanityFilter');
    const user = gameManager.getUserBySocketId(socket.id);
    const chatMessage = foundTournament.addMessage(
        user?.username || 'Unknown',
        filterProfanity(message.trim()),
        isSpectator
    );

    foundTournament.broadcast(io, 'tournamentMessage', {
        username: chatMessage.username,
        message: chatMessage.message,
        isSpectator: chatMessage.isSpectator,
        timestamp: chatMessage.timestamp
    });
}

/**
 * Spectate a tournament (join tournament room to see games list)
 */
function spectateTournament(socket, io, data) {
    const { tournamentId } = data;
    const tournament = gameManager.getTournamentById(tournamentId);
    if (!tournament) {
        socket.emit('error', { message: 'Tournament not found' });
        return;
    }

    const user = gameManager.getUserBySocketId(socket.id);
    if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
    }

    // Leave main room
    socket.leave('mainRoom');
    gameManager.leaveMainRoom(socket.id);

    // Add as spectator
    tournament.addSpectator(socket.id, user.username, null);
    tournament.joinToRoom(io, socket.id);

    // Send tournament state
    socket.emit('tournamentJoined', {
        ...tournament.getClientState(),
        isSpectator: true
    });

    tournament.broadcast(io, 'tournamentMessage', {
        username: 'System',
        message: `${user.username} is now spectating`,
        isSpectator: false,
        timestamp: Date.now()
    });

    socketLogger.info('Player spectating tournament', {
        socketId: socket.id,
        username: user.username,
        tournamentId
    });
}

/**
 * Spectate a specific game within a tournament
 */
function spectateTournamentGame(socket, io, data) {
    const { gameId } = data;

    const game = gameManager.getGameById(gameId);
    if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
    }

    const user = gameManager.getUserBySocketId(socket.id);
    if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
    }

    // A pure spectator of this one game (leaves any other game it watched)
    if (!gameManager.addSpectator(io, game, socket.id, user.username, null)) {
        socketLogger.warn('Spectate refused: socket is in a game', { socketId: socket.id, gameId });
        socket.emit('error', { message: 'Leave your current game before spectating another' });
        return;
    }

    // Send spectator join success with game state, then the v2 snapshot
    // (additive), BEFORE the room notice
    socket.emit('spectatorJoined', {
        ...spectatorJoinState(game),
        snapshot: snapshotFor(game, socket.id, { customPics: false })
    });

    game.broadcast(io, 'spectatorJoined', {
        username: user.username,
        spectatorCount: game.getSpectators().length
    });
}

/**
 * Cancel a tournament (creator only), in any phase. While a round's tables
 * are starting or playing, the round's games end: every live table goes
 * through the single abort path (gameLifecycle.abortGame).
 *
 * The whole in-memory teardown is synchronous, before the first await:
 *   1. deleteTournament: retires the tournament (its epoch goes stale, so an
 *      in-flight round start stops at its next check), drops the
 *      tournamentGames / playerTournaments entries (so no abort follow-up or
 *      late gameEnd can score or advance it) and the tournament itself (so a
 *      returnToTournament gets tournamentLeft + mainRoomJoined)
 *   2. abortGame to every live table (players at the table and its
 *      spectators get abortGame { reason: 'Tournament cancelled' })
 *   3. tournamentCancelled to the tournament room, then everyone leaves it
 *   4. lobbiesUpdated
 * Then the DB: activeTournamentId (scoped) and each abort's activeGameId.
 * Clients: abortGame first and tournamentCancelled next leaves both web and
 * iOS in the main room (iOS answers abortGame with returnToTournament, which
 * now finds no tournament).
 */
async function cancelTournament(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    if (!tournament) {
        socket.emit('error', { message: 'Not in a tournament' });
        return;
    }

    if (tournament.createdBy !== socket.id) {
        socket.emit('error', { message: 'Only the creator can cancel the tournament' });
        return;
    }

    const tournamentId = tournament.tournamentId;
    const phase = tournament.phase;
    const usernames = Array.from(tournament.players.values(), p => p.username).filter(Boolean);

    // 1. Unresolvable before anything can await
    const tables = gameManager.deleteTournament(tournamentId);
    cancelTournamentCleanup(tournamentId);

    // 2. End the round's games
    const aborts = tables.map(game => abortGame(io, game, 'Tournament cancelled'));

    // 3. Notify everyone in the tournament room, then empty it
    tournament.broadcast(io, 'tournamentCancelled', {});
    for (const [playerSocketId] of tournament.players) {
        tournament.leaveRoom(io, playerSocketId);
    }
    for (const [spectatorSocketId] of tournament.spectators) {
        tournament.leaveRoom(io, spectatorSocketId);
    }

    // 4. Update main room
    emitLobbiesUpdated(io);

    socketLogger.info('Tournament cancelled by creator', {
        socketId: socket.id,
        tournamentId,
        phase,
        abortedGames: tables.length
    });

    // DB: clear active tournament for all players (scoped: a player may
    // already be in another one) while the aborts clear their games
    await Promise.all([
        ...aborts,
        ...usernames.map(u => gameManager.clearActiveTournament(u, tournamentId))
    ]);
}

/**
 * Return to tournament lobby from game/spectating
 */
function returnToTournament(socket, io) {
    let tournament = gameManager.getPlayerTournament(socket.id);

    // Tournament spectators aren't in playerTournaments
    if (!tournament) {
        for (const [, t] of gameManager.tournaments) {
            if (t.isSpectator(socket.id)) {
                tournament = t;
                break;
            }
        }
    }

    // Last resort: reattach by username (e.g. socket changed while in a game)
    if (!tournament) {
        const user = gameManager.getUserBySocketId(socket.id);
        if (user) {
            tournament = gameManager.reattachTournamentPlayer(socket.id, user.username);
        }
    }

    if (!tournament) {
        // Tournament is gone (completed and cleaned up, or cancelled) — land
        // the player in the main room instead of leaving them stranded.
        socket.emit('tournamentLeft', {});
        sendToMainRoom(socket);
        return;
    }

    // Stop spectating whatever game it watched
    gameManager.leaveSpectating(io, socket.id);

    // Make sure they're in tournament room
    tournament.joinToRoom(io, socket.id);

    // Send current tournament state
    socket.emit('tournamentJoined', tournament.getClientState());
}

// Completed tournaments stay in memory for a grace window so players coming
// from the game-end screen can still return and see the final standings.
const COMPLETED_TOURNAMENT_TTL_MS = 10 * 60 * 1000;
const cleanupTimers = new Map(); // tournamentId → timer

function scheduleTournamentCleanup(io, tournamentId, delayMs = COMPLETED_TOURNAMENT_TTL_MS) {
    if (cleanupTimers.has(tournamentId)) {
        clearTimeout(cleanupTimers.get(tournamentId));
    }
    const timer = setTimeout(() => {
        cleanupTimers.delete(tournamentId);
        const tournament = gameManager.getTournamentById(tournamentId);
        if (!tournament) return;

        for (const [playerSocketId] of tournament.players) {
            tournament.leaveRoom(io, playerSocketId);
        }
        for (const [spectatorSocketId] of tournament.spectators) {
            tournament.leaveRoom(io, spectatorSocketId);
        }
        gameManager.deleteTournament(tournamentId);

        io.to('mainRoom').emit('lobbiesUpdated', {
            lobbies: gameManager.getAllLobbies(),
            inProgressGames: gameManager.getInProgressGames(),
            tournaments: gameManager.getAllTournaments()
        });
        socketLogger.info('Completed tournament cleaned up', { tournamentId });
    }, delayMs);
    if (timer.unref) timer.unref();
    cleanupTimers.set(tournamentId, timer);
}

/** Drop a pending results-window cleanup (the tournament is deleted now). */
function cancelTournamentCleanup(tournamentId) {
    const timer = cleanupTimers.get(tournamentId);
    if (timer) {
        clearTimeout(timer);
        cleanupTimers.delete(tournamentId);
    }
}

/**
 * Broadcast the outcome of a finished round: either the between-rounds prompt
 * or the final standings. Shared by the normal game-end and abort paths.
 */
async function broadcastRoundOutcome(io, tournament) {
    if (tournament.isTournamentComplete()) {
        tournament.broadcast(io, 'tournamentComplete', {
            scoreboard: tournament.getScoreboard(),
            winners: tournament.getWinners()
        });
        await gameManager.clearActiveTournamentForAll(tournament.tournamentId);
        scheduleTournamentCleanup(io, tournament.tournamentId);
    } else {
        tournament.broadcast(io, 'tournamentRoundComplete', {
            scoreboard: tournament.getScoreboard(),
            currentRound: tournament.currentRound,
            totalRounds: tournament.totalRounds
        });
    }
}

/**
 * A tournament game ended without reaching gameEnd (aborted/abandoned).
 * Mark it complete with no scores recorded so the round can still advance —
 * otherwise the tournament is stuck in round_active forever.
 */
async function handleAbortedTournamentGame(io, gameId, game = gameManager.getGameById(gameId)) {
    const result = gameManager.handleTournamentGameEnd(gameId);
    if (!result) return;

    const tournament = result.tournament;
    tournament.broadcast(io, 'tournamentGameComplete', {
        gameId,
        score: game ? game.score : { team1: 0, team2: 0 },
        aborted: true,
        activeGames: tournament.getActiveGames(),
        scoreboard: tournament.getScoreboard(),
        currentRound: tournament.currentRound,
        totalRounds: tournament.totalRounds
    });

    if (result.roundComplete) {
        await broadcastRoundOutcome(io, tournament);
        // Everyone may be gone already (that's often why the game aborted)
        if (tournament.getConnectedPlayerCount() === 0) {
            gameManager.deleteTournament(tournament.tournamentId);
        }
    }

    socketLogger.info('Aborted tournament game resolved', {
        gameId, tournamentId: tournament.tournamentId, roundComplete: result.roundComplete
    });
}

module.exports = {
    createTournament,
    joinTournament,
    leaveTournament,
    cancelTournament,
    tournamentReady,
    tournamentUnready,
    beginTournament,
    beginNextRound,
    tournamentChat,
    spectateTournament,
    spectateTournamentGame,
    returnToTournament,
    broadcastRoundOutcome,
    handleAbortedTournamentGame,
    scheduleTournamentCleanup
};
