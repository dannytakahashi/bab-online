/**
 * Tournament socket event handlers.
 * Manages tournament lifecycle: create, join, ready, rounds, chat, spectating.
 */

const gameManager = require('../game/GameManager');
const TournamentState = require('../game/TournamentState');
const Deck = require('../game/Deck');
const { socketLogger } = require('../utils/logger');
const { delay } = require('../utils/timing');
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

    // Leave tournament room
    tournament.leaveRoom(io, socket.id);

    const result = gameManager.leaveTournament(socket.id);
    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
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

    // Flip the phase synchronously before any awaits so a double-click or
    // retry can't pass the phase guard and start round 1 twice.
    tournament.phase = 'starting';

    try {
        // Set active tournament in DB for all players
        for (const [, player] of tournament.players) {
            await gameManager.setActiveTournament(player.username, tournament.tournamentId);
        }

        await startTournamentRound(io, tournament, 1);
    } catch (error) {
        if (tournament.phase === 'starting') {
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
    tournament.phase = 'starting';

    try {
        await startTournamentRound(io, tournament, nextRound);
    } catch (error) {
        if (tournament.phase === 'starting') {
            tournament.phase = 'between_rounds';
        }
        throw error;
    }
}

/**
 * Start a tournament round — creates games, assigns players, starts draw phase
 */
async function startTournamentRound(io, tournament, roundNumber) {
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
    const roundData = tournament.startRound(roundNumber);

    // Broadcast round start
    tournament.broadcast(io, 'tournamentRoundStart', {
        roundNumber,
        totalRounds: tournament.totalRounds,
        assignments: assignments.map(a => ({ humanCount: a.humans.length, botCount: a.botCount }))
    });

    await delay(1500);

    // Create each game
    for (const assignment of assignments) {
        // Collect human socket IDs. A player may have left/disconnected during
        // the delays above — back-fill their seat with a bot so the game still
        // has 4 participants and the draw phase can complete.
        const humanSocketIds = [];
        const presentHumans = [];
        for (const username of assignment.humans) {
            const playerInfo = tournament.getPlayerByUsername(username);
            if (playerInfo && playerInfo.connected !== false &&
                io.sockets.sockets.get(playerInfo.socketId)) {
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
            continue;
        }

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

        // Set active game in DB for humans
        for (const username of presentHumans) {
            await gameManager.setActiveGame(username, game.gameId);
        }

        // Join human players to game room
        for (const socketId of humanSocketIds) {
            const playerSocket = io.sockets.sockets.get(socketId);
            if (playerSocket) {
                playerSocket.join(game.roomName);
            }
        }

        // Emit game assignment to humans
        for (const socketId of humanSocketIds) {
            io.to(socketId).emit('tournamentGameAssignment', {
                gameId: game.gameId,
                tournamentId: tournament.tournamentId,
                roundNumber
            });
        }

        // Emit allPlayersReady to humans (triggers transition to draw)
        for (const socketId of humanSocketIds) {
            io.to(socketId).emit('allPlayersReady', {
                gameId: game.gameId
            });
        }

        // Start draw phase after delay
        await delay(2000);

        game.deck = new Deck();
        game.deck.shuffle();
        game.phase = 'drawing';
        game.broadcast(io, 'startDraw', { start: true });

        // Schedule bot draws
        let botDrawOrder = 0;
        for (const botInfo of botSocketIds) {
            botDrawOrder++;
            botController.scheduleBotDraw(io, game, botInfo.socketId, botDrawOrder);
        }
    }

    // If every table was skipped (everyone left during the start delays),
    // roll the round back so the tournament isn't stuck in round_active
    // waiting on games that don't exist.
    const startedRound = tournament.getCurrentRound();
    if (startedRound && startedRound.roundNumber === roundNumber && startedRound.games.size === 0) {
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
        return;
    }

    // Update main room
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    socketLogger.info('Tournament round started', {
        tournamentId: tournament.tournamentId,
        roundNumber,
        gameCount: assignments.length
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

    // Add as spectator to the game
    game.addSpectator(socket.id, user.username, null);
    game.joinToRoom(io, socket.id);

    // Build player info
    const playerInfo = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) {
            playerInfo.push({
                position: pos,
                username: player.username,
                pic: player.pic,
                socketId: player.socketId
            });
        }
    }

    // Send spectator join success with game state
    socket.emit('spectatorJoined', {
        gameId: game.gameId,
        players: playerInfo,
        trump: game.trump,
        currentHand: game.currentHand,
        dealer: game.dealer,
        phase: game.phase,
        bidding: game.bidding,
        currentTurn: game.currentTurn,
        bids: game.bids,
        playerBids: game.playerBids,
        tricks: game.tricks,
        score: game.score,
        playedCards: game.playedCards,
        isTrumpBroken: game.isTrumpBroken,
        gameLog: game.getGameLog(),
        spectatorCount: game.getSpectators().length
    });

    game.broadcast(io, 'spectatorJoined', {
        username: user.username,
        spectatorCount: game.getSpectators().length
    });
}

/**
 * Cancel a tournament (creator only).
 * Broadcasts tournamentCancelled to all players, clears DB state, deletes tournament.
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

    // Notify all players in tournament room
    tournament.broadcast(io, 'tournamentCancelled', {});

    // Clear active tournament in DB for all players
    await gameManager.clearActiveTournamentForAll(tournamentId);

    // Remove all players and spectators from tournament room
    for (const [playerSocketId] of tournament.players) {
        tournament.leaveRoom(io, playerSocketId);
    }
    for (const [spectatorSocketId] of tournament.spectators) {
        tournament.leaveRoom(io, spectatorSocketId);
    }

    // Delete tournament and clean up maps
    gameManager.deleteTournament(tournamentId);

    // Update main room
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    socketLogger.info('Tournament cancelled by creator', {
        socketId: socket.id,
        tournamentId
    });
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

    // Remove from any game spectator lists
    for (const [, game] of gameManager.games) {
        if (game.isSpectator(socket.id)) {
            game.removeSpectator(socket.id);
            game.leaveRoom(io, socket.id);
        }
    }

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
async function handleAbortedTournamentGame(io, gameId) {
    const game = gameManager.getGameById(gameId);
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
