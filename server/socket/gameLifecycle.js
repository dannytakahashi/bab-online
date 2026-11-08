/**
 * Game lifecycle entry points shared by every handler: the single draw
 * start, the single abort path and the main-room lobby refresh.
 *
 * abortGame is the only way a live game is aborted from a socket path. It is
 * idempotent (false on an already-terminal game) and does the teardown in a
 * fixed order: final abortGame broadcast to the room (seats, spectators and
 * pending humans) while the game is still live -> ABORTED + epoch bump +
 * timer cancellation -> synchronous retire (bots, room, every playerGames
 * entry, spectators) -> lobbiesUpdated -> DB clears and tournament follow-up.
 */

const gameManager = require('../game/GameManager');
const Deck = require('../game/Deck');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const { socketLogger } = require('../utils/logger');

/** Refresh the main room's lobby / in-progress / tournament lists. */
function emitLobbiesUpdated(io) {
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });
}

/**
 * Abort a live game.
 * @param {Object} io
 * @param {GameState} game
 * @param {string} reason - sent to clients as abortGame { reason }
 * @returns {Promise<boolean>} false if the game was already ended/aborted
 */
async function abortGame(io, game, reason) {
    if (!game || game.isTerminal()) return false;
    const gameId = game.gameId;
    game.terminate(io, Phase.ABORTED, 'abortGame', { reason });
    gameManager.abortGame(gameId, io);   // synchronous retire
    emitLobbiesUpdated(io);
    try {
        await gameManager.clearActiveGameForAll(gameId, game);
        // Tournament games must still count toward round completion
        const { handleAbortedTournamentGame } = require('./tournamentHandlers');
        await handleAbortedTournamentGame(io, gameId, game);
    } catch (err) {
        socketLogger.error('Abort follow-up failed', { gameId, error: err.message, stack: err.stack });
    }
    return true;
}

/**
 * Open the draw (CREATED -> DRAWING): shuffle a deck, announce startDraw,
 * schedule every registered bot's draw, and replay departures that happened
 * while the game sat in CREATED (lobby/tournament countdown): each departed
 * socket auto-draws now, and handleDrawComplete later seats it as a resign
 * bot (left) or a disconnected seat — or aborts if every human left.
 * Used by the lobby, tournament and ambient start paths.
 * @param {Object} io
 * @param {GameState} game
 * @param {Object} [opts]
 * @param {boolean} [opts.announce=true] - broadcast startDraw (the ambient
 *   bot game has no audience for it)
 * @returns {boolean} false if the game was no longer in CREATED
 */
function beginDraw(io, game, { announce = true } = {}) {
    if (!game.transition(Phase.CREATED, Phase.DRAWING)) return false;

    const deck = new Deck();
    deck.shuffle();
    game.deck = deck;

    if (announce) game.broadcast(io, 'startDraw', { start: true });

    // Bots draw on staggered timers, in registration order
    let drawOrder = 0;
    for (const bot of botController.getGameBots(game.gameId)) {
        drawOrder++;
        botController.scheduleBotDraw(io, game, bot.socketId, drawOrder);
    }

    // Sockets that left or disconnected during the countdown draw now
    const { autoDraw, handleDrawComplete } = require('./gameHandlers');
    for (const e of game.entrants ? game.entrants.values() : []) {
        if (e.presence === 'connected' || game.drawIDs.includes(e.socketId)) continue;
        autoDraw(io, game, e.socketId, e.username || 'Player');
    }
    if (game.drawIndex === 4) {
        handleDrawComplete(io, game).catch(err =>
            socketLogger.error('handleDrawComplete failed', { gameId: game.gameId, error: err.message, stack: err.stack })
        );
    }
    return true;
}

module.exports = {
    abortGame,
    beginDraw,
    emitLobbiesUpdated
};
