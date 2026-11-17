/**
 * Test kit for the live persist store (server/game/persist/liveStore.js;
 * deploy survival PR 4). The calling test mocks ../database with
 * persistHarness.databaseMock over a liveDb and uses fake timers.
 *
 *   installStore(holder, opts)  a write-mode store over holder.current
 *                               (the liveDb), made the process's store
 *                               (liveStore._setForTests), with a logger
 *                               that records every call (store.logs)
 *   startGame(io, log, opts)    a real table through the real lifecycle:
 *                               `humans` (usernames, each with a stub
 *                               socket carrying conn.close / disconnect
 *                               spies) and bots for the rest, drawn, and
 *                               played on to BIDDING
 *   savedGame(db, id)           the liveGames doc (or null)
 *   comparable(doc)             a codec doc's saved part, for "the stored
 *                               doc equals serialize(game)"
 *   advanceUntil(pred)          fake time in 100 ms steps until pred()
 *
 * Server modules are required lazily (tests mock ../database first).
 */

'use strict';

/** A logger whose calls are recorded: store.logs [{level, msg, meta}]. */
function recordingLogger() {
    const logs = [];
    const at = (level) => (msg, meta) => logs.push({ level, msg, meta });
    return { logs, logger: { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') } };
}

/**
 * @param {{current: Object}} holder - databaseMock's holder (current: a liveDb)
 * @param {Object} [opts] - createLiveStore options (mode 'write', bootId 'boot-A' by default)
 */
function installStore(holder, opts = {}) {
    const liveStore = require('../game/persist/liveStore');
    const { logs, logger } = recordingLogger();
    const store = liveStore.createLiveStore({
        mode: 'write',
        bootId: 'boot-A',
        getCollections: () => holder.current,
        logger,
        ...opts
    });
    store.logs = logs;
    liveStore._setForTests(store);
    return store;
}

async function advanceUntil(pred, { step = 100, cap = 120000 } = {}) {
    for (let t = 0; t < cap; t += step) {
        if (pred()) return true;
        await jest.advanceTimersByTimeAsync(step);
    }
    if (pred()) return true;
    throw new Error('advanceUntil: condition not met');
}

/**
 * A table with `humans` (usernames; the rest bots), through the real draw
 * and seating, played on until `until` (default: BIDDING).
 * @returns {Promise<{game: Object, sockets: Object[], bots: Object[]}>}
 */
async function startGame(io, log, { humans = [], until = null, personalities = ['mary', 'sharon', 'mike', 'danny'] } = {}) {
    const gameManager = require('../game/GameManager');
    const { botController } = require('../game/bot');
    const gameLifecycle = require('../socket/gameLifecycle');
    const gameHandlers = require('../socket/gameHandlers');
    const { makeSocket } = require('./gameDriver');
    const { Phase } = require('../game/GamePhase');
    const users = require('../database').getUsersCollection();
    const sockets = humans.map((username, i) => {
        const id = `h-${username}-${i}`;
        gameManager.registerUser(id, username);
        if (users && !users.docs.some((d) => d.username === username)) users._insert({ username, profilePic: 3 });
        const s = makeSocket(id, log, io);
        s.conn = { close: jest.fn() };
        s.disconnect = jest.fn();
        return s;
    });
    const bots = [];
    for (let i = sockets.length; i < 4; i++) bots.push(botController.createBot(`🤖 P${i}`, personalities[i]));
    const game = gameManager.createGame([...sockets.map((s) => s.id), ...bots.map((b) => b.socketId)]);
    bots.forEach((b) => botController.registerBot(game.gameId, b));
    gameLifecycle.beginDraw(io, game);
    sockets.forEach((s, i) => { gameHandlers.draw(s, io, { num: i }); });
    await advanceUntil(until || (() => game.stage === Phase.BIDDING || game.isTerminal()));
    return { game, sockets, bots };
}

function savedGame(db, id) {
    return db.liveGames.docs.find((d) => d._id === id) || null;
}

function savedTournament(db, id) {
    return db.liveTournaments.docs.find((d) => d._id === id) || null;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

/** The saved part of a game codec doc, or of a stored liveGames doc. */
function comparable(doc) {
    if (!doc) return null;
    return plain({ stage: doc.stage, tournamentId: doc.tournamentId ?? null, state: doc.state, log: doc.log, logTotal: doc.logTotal, bots: doc.bots });
}

module.exports = { recordingLogger, installStore, advanceUntil, startGame, savedGame, savedTournament, comparable, plain };
