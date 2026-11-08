/**
 * Game lifecycle entry points shared by every handler: the single abort
 * path and the main-room lobby refresh.
 *
 * abortGame is the only way a live game is aborted from a socket path. It is
 * idempotent (false on an already-terminal game) and does the teardown in a
 * fixed order: final abortGame broadcast to the room (seats, spectators and
 * pending humans) while the game is still live -> ABORTED + epoch bump +
 * timer cancellation -> synchronous retire (bots, room, every playerGames
 * entry, spectators) -> lobbiesUpdated -> DB clears and tournament follow-up.
 */

const gameManager = require('../game/GameManager');
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

module.exports = {
    abortGame,
    emitLobbiesUpdated
};
