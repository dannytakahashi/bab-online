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
const { ambientAudience, seesAmbientGame } = require('../utils/ambientChatUsers');
const clientInfo = require('./clientInfo');

/**
 * Refresh the main room's lobby / in-progress / tournament lists. Every
 * lobbiesUpdated goes through here.
 *
 * The ambient demo game is listed only for the AMBIENT_CHAT_USERS audience
 * (owner, 2026-11-14; server/utils/ambientChatUsers.js, default test1). While
 * every main-room member gets the same list (no demo game listed, audience
 * `*`, or no audience socket in the room) it is the one io.to('mainRoom')
 * broadcast; otherwise each main-room socket gets its own copy (io.to(socketId),
 * like ambientBots.postAmbientChat): the full list for an audience account,
 * the list without the demo game for everyone else. Same wire shape either way.
 *
 * Family lobbies (2026-11-16): a main-room socket that sent the
 * casualSpectators cap gets lobby entries with the additive memberCount /
 * capacity / memberUsernames (GameManager.getAllLobbies wide). While none
 * is in the main room nothing above changes; with one in, the lists go per
 * socket (one broadcast still when every member is capable and nobody's
 * demo view differs).
 * @returns {string[]|null} the socket ids that got the full list when it was
 *   sent per socket (null: one broadcast)
 */
function emitLobbiesUpdated(io) {
    const lobbies = gameManager.getAllLobbies();
    const tournaments = gameManager.getAllTournaments();
    const full = gameManager.getInProgressGames(null, { includeDemo: true });
    const withoutDemo = full.length === 0 ? full : gameManager.getInProgressGames(null, { includeDemo: false });
    const payload = (inProgressGames) => ({ lobbies, inProgressGames, tournaments });

    const audience = ambientAudience();
    const demoSplit = !(audience.all || withoutDemo.length === full.length);
    const capable = new Set([...gameManager.mainRoomSocketIds].filter((sid) => clientInfo.socketHasCap(io, sid, 'casualSpectators')));
    if (capable.size > 0) return emitLobbiesUpdatedWide(io, { capable, demoSplit, lobbies, tournaments, full, withoutDemo });
    if (!demoSplit) {
        io.to('mainRoom').emit('lobbiesUpdated', payload(full));
        return null;
    }
    const seeing = [];
    const others = [];
    for (const socketId of gameManager.mainRoomSocketIds) {
        const user = gameManager.getUserBySocketId(socketId);
        (user && seesAmbientGame(user.username) ? seeing : others).push(socketId);
    }
    if (seeing.length === 0) {
        io.to('mainRoom').emit('lobbiesUpdated', payload(withoutDemo));
        return null;
    }
    const fullPayload = payload(full);
    const filteredPayload = payload(withoutDemo);
    for (const socketId of seeing) io.to(socketId).emit('lobbiesUpdated', fullPayload);
    for (const socketId of others) io.to(socketId).emit('lobbiesUpdated', filteredPayload);
    return seeing;
}

/** emitLobbiesUpdated with a capable socket in the main room (wide lobby entries for it). */
function emitLobbiesUpdatedWide(io, { capable, demoSplit, lobbies, tournaments, full, withoutDemo }) {
    const wideLobbies = gameManager.getAllLobbies({ wide: true });
    const everyoneCapable = [...gameManager.mainRoomSocketIds].every((sid) => capable.has(sid));
    if (everyoneCapable && !demoSplit) {
        io.to('mainRoom').emit('lobbiesUpdated', { lobbies: wideLobbies, inProgressGames: full, tournaments });
        return null;
    }
    const seeing = [];
    for (const socketId of gameManager.mainRoomSocketIds) {
        const user = gameManager.getUserBySocketId(socketId);
        const sees = !demoSplit || (user && seesAmbientGame(user.username));
        if (sees) seeing.push(socketId);
        io.to(socketId).emit('lobbiesUpdated', {
            lobbies: capable.has(socketId) ? wideLobbies : lobbies,
            inProgressGames: sees ? full : withoutDemo,
            tournaments
        });
    }
    return seeing;
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
 * arm the 30s draw watchdog (seatLifecycle.startDrawWatchdog), schedule
 * every registered bot's draw, and replay departures that happened
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

    // The draw ends within DRAW_WATCHDOG_MS whatever the sockets do
    require('./seatLifecycle').startDrawWatchdog(io, game);

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
