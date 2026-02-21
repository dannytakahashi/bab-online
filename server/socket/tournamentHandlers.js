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
function joinTournament(socket, io, data) {
    const { tournamentId } = data;
    if (!tournamentId) {
        socket.emit('error', { message: 'Tournament ID required' });
        return;
    }

    const result = gameManager.joinTournament(socket.id, tournamentId);
    if (!result.success) {
        socket.emit('error', { message: result.error });
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
 * Leave a tournament
 */
function leaveTournament(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    if (!tournament) {
        socket.emit('error', { message: 'Not in a tournament' });
        return;
    }

    const user = gameManager.getUserBySocketId(socket.id);
    const tournamentId = tournament.tournamentId;

    // Leave tournament room
    tournament.leaveRoom(io, socket.id);

    const result = gameManager.leaveTournament(socket.id);
    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    // Notify leaving player
    socket.emit('tournamentLeft', {});

    // Auto-rejoin main room
    const mainRoomResult = gameManager.joinMainRoom(socket.id);
    socket.join('mainRoom');
    socket.emit('mainRoomJoined', {
        messages: mainRoomResult.messages,
        lobbies: mainRoomResult.lobbies,
        onlineCount: mainRoomResult.onlineCount,
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

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

    // Set active tournament in DB for all players
    for (const [, player] of tournament.players) {
        await gameManager.setActiveTournament(player.username, tournament.tournamentId);
    }

    await startTournamentRound(io, tournament, 1);
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

    await startTournamentRound(io, tournament, nextRound);
}

/**
 * Start a tournament round — creates games, assigns players, starts draw phase
 */
async function startTournamentRound(io, tournament, roundNumber) {
    // Shuffle player usernames
    const usernames = [];
    for (const [, player] of tournament.players) {
        usernames.push(player.username);
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
        // Collect human socket IDs
        const humanSocketIds = [];
        for (const username of assignment.humans) {
            const playerInfo = tournament.getPlayerByUsername(username);
            if (playerInfo) {
                humanSocketIds.push(playerInfo.socketId);
            }
        }

        // Create bot socket IDs
        const botSocketIds = [];
        const usedPersonalities = [];
        for (let i = 0; i < assignment.botCount; i++) {
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
        tournament.addGameToRound(game.gameId, assignment.humans, assignment.botCount);

        // Set active game in DB for humans
        for (const username of assignment.humans) {
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

    const user = gameManager.getUserBySocketId(socket.id);
    const chatMessage = foundTournament.addMessage(
        user?.username || 'Unknown',
        message.trim(),
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
 * Return to tournament lobby from game/spectating
 */
function returnToTournament(socket, io) {
    const tournament = gameManager.getPlayerTournament(socket.id);
    if (!tournament) {
        socket.emit('error', { message: 'Not in a tournament' });
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

module.exports = {
    createTournament,
    joinTournament,
    leaveTournament,
    tournamentReady,
    tournamentUnready,
    beginTournament,
    beginNextRound,
    tournamentChat,
    spectateTournament,
    spectateTournamentGame,
    returnToTournament
};
