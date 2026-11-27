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
const { PAIRINGS_CAP, teamsText } = require('../game/tournamentPartners');

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
    // A Get Your Bid lobby or table exists (gameMode.js): each main-room
    // socket gets its own lists, with those only for a client that can
    // show them. Otherwise everything below is exactly as before.
    if (gameManager.hasGybActivity()) return emitLobbiesUpdatedPerSocket(io);
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

/**
 * emitLobbiesUpdated, one emit per main-room socket, each list built for
 * that socket's caps (clientInfo.listOpts: wide entries, Get Your Bid) and
 * audience (the ambient demo game).
 * @returns {string[]} the socket ids that got the demo game listed
 */
function emitLobbiesUpdatedPerSocket(io) {
    const tournaments = gameManager.getAllTournaments();
    const lobbyLists = new Map();
    const gameLists = new Map();
    const seeing = [];
    for (const socketId of gameManager.mainRoomSocketIds) {
        const opts = clientInfo.listOpts(io?.sockets?.sockets?.get(socketId));
        const user = gameManager.getUserBySocketId(socketId);
        const sees = !!user && seesAmbientGame(user.username);
        const lobbyKey = `${opts.wide}|${opts.gyb}`;
        const gameKey = `${sees}|${opts.gyb}`;
        if (!lobbyLists.has(lobbyKey)) lobbyLists.set(lobbyKey, gameManager.getAllLobbies(opts));
        if (!gameLists.has(gameKey)) gameLists.set(gameKey, gameManager.getInProgressGames(null, { includeDemo: sees, gyb: opts.gyb }));
        const inProgressGames = gameLists.get(gameKey);
        if (sees && inProgressGames.some((g) => gameManager.getGameById(g.gameId)?.isDemo)) seeing.push(socketId);
        io.to(socketId).emit('lobbiesUpdated', { lobbies: lobbyLists.get(lobbyKey), inProgressGames, tournaments });
    }
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
 *
 * Deploy survival: a frozen game (GameState.freeze: handed off, or
 * suspended and then fenced) is not this process's any more, so this is a
 * no-op (false) and nothing is emitted, retired or cleared. A suspended
 * one (the holder self-fence, GameState.suspend) aborts when it thaws
 * (deferWhileSuspended), never while ownership is in doubt.
 * @param {Object} io
 * @param {GameState} game
 * @param {string} reason - sent to clients as abortGame { reason }
 * @returns {Promise<boolean>} false if the game was already ended/aborted
 *   (or frozen, or suspended: then the abort runs on unsuspend)
 */
async function abortGame(io, game, reason) {
    if (!game || game.isTerminal() || game.frozen) return false;
    if (game.isSuspended) {
        game.deferWhileSuspended(() => abortGame(io, game, reason), { ends: true });
        return false;
    }
    const gameId = game.gameId;
    // The tournament the table still counts for (a cancel unmaps its tables
    // before aborting them: those end like a casual game)
    const tournamentId = gameManager.tournamentGames.get(gameId) ?? null;
    game.terminate(io, Phase.ABORTED, 'abortGame', { reason });
    gameManager.abortGame(gameId, io);   // synchronous retire
    emitLobbiesUpdated(io);
    // Deploy survival (LIVE_PERSIST write; persist/liveStore.js): the saved
    // doc ends here, a casual game's deleted, a tournament table's turned
    // into an `aborted` tombstone until its tournament's doc lists it
    // complete. Awaited only when there is a doc; never fences in write
    const store = require('../game/persist/liveStore').getLiveStore();
    if (store.claimable(game) && (await store.claimEnded(game, { tournamentId })) === 'fenced') return true;
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
 *
 * A tournament table with planned teams (game.drawTeams, two or more
 * members) draws honestly (owner 2026-11-25): each player gets the card
 * they picked and the draw decides only the seats and who deals first.
 * startDraw carries the teams by name (`teams`: a client with the
 * clientHello cap tournamentPairings shows the draw for first deal), and
 * the room gets one stored system log line naming them. The staged draw
 * (cards chosen so the casual "two highest cards are partners" seated the
 * plan) is gone: every iOS build the upgrade gate lets in (41 and later)
 * has the cap. A cached web tab from before 2026-11-25 does not: it shows
 * its old casual copy over an honest draw, and the log line (in its game
 * log, and through the snapshot log for one who comes later) plus
 * teamsAnnounced say who is partnered. The "Tournament draw" log counts
 * those sockets (legacyHumans / legacySpectators) so their use is visible.
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

    let payload = { start: true };
    if (game.drawTeams) {
        const legacy = legacyAudience(io, game);
        game.drawTeamsWire = plannedTeamsWire(game);
        payload = { start: true, teams: game.drawTeamsWire };
        socketLogger.info('Tournament draw', {
            gameId: game.gameId, mode: 'firstDeal',
            legacyHumans: legacy.humans, legacySpectators: legacy.spectators,
        });
    }
    if (announce) game.broadcast(io, 'startDraw', payload);
    if (game.drawTeams && announce) {
        const line = `Partners this round: ${teamsText(game.drawTeamsWire)}. The draw decides who deals first.`;
        game.addLogEntry(line, null, 'system');
        game.broadcast(io, 'gameLogEntry', { message: line, type: 'system' });
    }

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
    if (game.drawIndex === game.seatCount) {
        handleDrawComplete(io, game).catch(err =>
            socketLogger.error('handleDrawComplete failed', { gameId: game.gameId, error: err.message, stack: err.stack })
        );
    }
    return true;
}

/**
 * Who at a planned table cannot show a draw for first deal (no
 * tournamentPairings cap: a cached web tab from before 2026-11-25):
 * {humans, spectators}, for the "Tournament draw" log only. A human
 * entrant who is not connected counts (it may come back on any client);
 * one who left is seated as a resign bot and is not at the table.
 */
function legacyAudience(io, game) {
    let humans = 0;
    let spectators = 0;
    for (const e of game.entrants ? game.entrants.values() : []) {
        if (e.isBot || e.presence === 'left') continue;
        if (e.presence !== 'connected' || !clientInfo.socketHasCap(io, e.socketId, PAIRINGS_CAP)) humans++;
    }
    for (const sid of game.spectators.keys()) {
        if (!clientInfo.socketHasCap(io, sid, PAIRINGS_CAP)) spectators++;
    }
    return { humans, spectators };
}

/**
 * game.drawTeams by name: always two teams of two complete
 * {username, isBot} entries (build 41 decodes snapshot draw.teams
 * strictly), in plan order.
 */
function plannedTeamsWire(game) {
    const entry = (sid) => {
        if (game.isBot(sid)) return { username: String(botController.getBot(game.gameId, sid)?.username || 'Bot'), isBot: true };
        return { username: String(game.entrant(sid)?.username || 'Player'), isBot: false };
    };
    return game.drawTeams.map((team) => team.map(entry));
}

module.exports = {
    abortGame,
    beginDraw,
    emitLobbiesUpdated,
    legacyAudience,
    plannedTeamsWire
};
