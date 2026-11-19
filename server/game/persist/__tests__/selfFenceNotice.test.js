/**
 * The holder self-fence tells the table (owner 2026-11-19, "Pause with a
 * notice"; LIVE_PERSIST=on only, persist/liveStore.js): a Mongo outage
 * longer than SELF_FENCE_MS suspends every casual table, and its room gets
 *   - PAUSE_NOTICE once when the table is suspended (not again while it
 *     stays suspended, however many beats fail),
 *   - RESUME_NOTICE once when the re-take finds the doc still ours and the
 *     table is unsuspended,
 *   - nothing more when the re-take finds it adopted elsewhere (fenced: its
 *     sockets close and the players reconnect to the adopter).
 * Each line is game.unsavedNotice: a system gameLogEntry to the room with
 * the next seq (like the shutdown notice to a frozen table), never in the
 * game log, so in no snapshot and no saved doc. Write mode sends nothing.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, mulberry32 } = require('../../../testUtils/gameDriver');
const { watchSeq } = require('../../../testUtils/seqCheck');
const gameManager = require('../../GameManager');
const GameState = require('../../GameState');
const { botController } = require('../../bot');
const persistHooks = require('../hooks');
const liveStore = require('../liveStore');
const snapshotHandlers = require('../../../socket/snapshotHandlers');
const profileHandlers = require('../../../socket/profileHandlers');
const { buildSnapshotV2 } = require('../../snapshotV2');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

const { PAUSE_NOTICE, RESUME_NOTICE } = liveStore;

let realRandom;
let io;
let log;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(5);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    log = [];
    io = makeIo(log);
});

afterEach(() => {
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const NOTICES = [PAUSE_NOTICE, RESUME_NOTICE];
/** The self-fence lines the room got, in order: [message, seq]. */
const notices = (game) => log
    .filter((e) => e.event === 'gameLogEntry' && e.to === game.roomName && NOTICES.includes(e.data?.message))
    .map((e) => [e.data.message, e.data.seq]);

/** The seq of the last sequenced room emit before log index `i` (0: none). */
const roomSeqBefore = (game, i) => {
    const prev = log.slice(0, i).filter((e) => e.to === game.roomName && Number.isInteger(e.data?.seq));
    return prev.length ? prev.at(-1).data.seq : 0;
};
const indexOfNotice = (line) => log.findIndex((e) => e.event === 'gameLogEntry' && e.data?.message === line);

async function onTable() {
    const mono = h.createMonoClock();
    const store = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io, monoNow: mono.now });
    await store.start({ io });
    const { game, sockets } = await kit.startGame(io, log, { humans: ['Hal'] });
    await db().users.updateOne({ username: 'Hal' }, { $set: { activeGameId: game.gameId } });
    await h.flushStore(store);
    return { store, game, sockets, id: game.gameId };
}

/** Stall the heartbeat until the table is suspended. */
async function suspendIt(t) {
    db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
    await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS + liveStore.HEARTBEAT_MS);
    expect(t.store.suspendCalls).toEqual([['suspend', t.id]]);
    expect(t.game.isSuspended).toBe(true);
}

async function recover(t) {
    db().faults.release();
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
    await h.flushStore(t.store);
}

test('the exact lines (owner 2026-11-19)', () => {
    expect(PAUSE_NOTICE).toBe('Game paused: the server is reconnecting. It will resume on its own.');
    expect(RESUME_NOTICE).toBe('Game resumed.');
});

test('suspended: the room gets the pause line once, with the next seq, and nothing else while it stays suspended', async () => {
    const t = await onTable();
    await suspendIt(t);
    // The next seq after the last room broadcast; the game's counter counts it
    const seqBefore = roomSeqBefore(t.game, indexOfNotice(PAUSE_NOTICE));
    expect(seqBefore).toBeGreaterThan(0);
    expect(notices(t.game)).toEqual([[PAUSE_NOTICE, seqBefore + 1]]);
    expect(t.game.eventSeq).toBe(seqBefore + 1);
    const logBefore = t.game.getGameLog().length;
    const sent = log.filter((e) => e.event === 'gameLogEntry' && e.data?.message === PAUSE_NOTICE);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: t.game.roomName, data: { message: PAUSE_NOTICE, type: 'system', seq: seqBefore + 1 } });
    expect(Object.keys(sent[0].data).sort()).toEqual(['message', 'seq', 'type']);
    // Not kept: the game log (snapshots, the saved doc) never has it
    expect(t.game.getGameLog().some((e) => NOTICES.includes(e.message))).toBe(false);
    // Beats keep failing, more checks run: no second line
    const emitted = log.length;
    await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS * 3);
    expect(log.length).toBe(emitted);
    expect(t.game.getGameLog()).toHaveLength(logBefore);
    expect(t.store.selfFenced).toBe(true);
    db().faults.release();
});

test('unsuspended: the resume line follows; neither line is in the next snapshot or the saved doc; the seq gate stays whole', async () => {
    const t = await onTable();
    const watch = watchSeq(io);
    const revBefore = kit.savedGame(db(), t.id).rev;
    await suspendIt(t);
    const seqBefore = roomSeqBefore(t.game, indexOfNotice(PAUSE_NOTICE));
    // A snapshot asked for while suspended counts the pause line's seq
    snapshotHandlers.requestSnapshot(t.sockets[0], io, {});
    const during = log.filter((e) => e.event === 'stateSnapshot').at(-1).data.snapshot;
    expect(during.seq).toBe(seqBefore + 1);
    await recover(t);
    expect(t.store.suspendCalls).toEqual([['suspend', t.id], ['unsuspend', t.id]]);
    expect(t.game.isSuspended).toBe(false);
    expect(notices(t.game)).toEqual([[PAUSE_NOTICE, seqBefore + 1], [RESUME_NOTICE, seqBefore + 2]]);

    // The next snapshot: the seq the client already holds (R5), no notice line
    const snap = buildSnapshotV2(t.game, t.sockets[0].id);
    expect(snap.seq).toBe(t.game.eventSeq);
    expect(snap.log.some((e) => NOTICES.includes(e.message))).toBe(false);
    snapshotHandlers.requestSnapshot(t.sockets[0], io, {});
    const after = log.filter((e) => e.event === 'stateSnapshot').at(-1).data.snapshot;
    expect(after.seq).toBe(t.game.eventSeq);
    expect(after.log.some((e) => NOTICES.includes(e.message))).toBe(false);

    // The game plays on: later broadcasts continue the seq with no gap or repeat
    await jest.advanceTimersByTimeAsync(60000);
    expect(t.game.eventSeq).toBeGreaterThan(seqBefore + 2);
    const { failures } = watch.stop();
    expect(failures).toEqual([]);

    // The saved doc: no notice line, its log total is the game's own
    await h.flushStore(t.store);
    const saved = kit.savedGame(db(), t.id);
    expect(saved.rev).toBeGreaterThan(revBefore);
    expect(saved.log.some((e) => NOTICES.includes(e.message))).toBe(false);
    expect(saved.logTotal).toBe(t.game.getGameLog().length);
});

test('a re-take that fails first: still one pause line, then one resume line once it lands', async () => {
    const t = await onTable();
    await suspendIt(t);
    db().faults.fail({ collections: 'liveGames', ops: 'findOneAndUpdate' });
    db().faults.release();
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
    expect(t.store.selfFenced).toBe(true);
    expect(notices(t.game).map(([m]) => m)).toEqual([PAUSE_NOTICE]);
    db().faults.clear();
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
    await h.flushStore(t.store);
    expect(t.store.selfFenced).toBe(false);
    expect(notices(t.game).map(([m]) => m)).toEqual([PAUSE_NOTICE, RESUME_NOTICE]);
});

test('a second outage later: a new pause line and a new resume line', async () => {
    const t = await onTable();
    await suspendIt(t);
    await recover(t);
    db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
    await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS + liveStore.HEARTBEAT_MS);
    await recover(t);
    expect(notices(t.game).map(([m]) => m)).toEqual([PAUSE_NOTICE, RESUME_NOTICE, PAUSE_NOTICE, RESUME_NOTICE]);
});

test('fenced at recovery (adopted elsewhere): no resume line, nothing after the pause line', async () => {
    const t = await onTable();
    await suspendIt(t);
    const emitted = log.length;
    db().liveGames.docs.find((d) => d._id === t.id).owner = 'boot-B';
    db().serverInstances._insert({ _id: 'boot-B', mode: 'on', startedAt: new Date(), beatAt: new Date(), beatSeq: 1, shuttingDown: false });
    await recover(t);
    expect(t.game.frozen).toBe(true);
    expect(t.sockets[0].conn.close).toHaveBeenCalledTimes(1);
    expect(notices(t.game).map(([m]) => m)).toEqual([PAUSE_NOTICE]);
    expect(log.length).toBe(emitted);
});

test('write mode: no self-fence, no line', async () => {
    const store = kit.installStore(mockDb, { bootId: 'boot-A', getIo: () => io });
    await store.start({ io });
    const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
    db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
    await jest.advanceTimersByTimeAsync(30000);
    expect(store.selfFenced).toBe(false);
    expect(log.some((e) => e.event === 'gameLogEntry' && NOTICES.includes(e.data?.message))).toBe(false);
    expect(game.isSuspended).toBe(false);
    db().faults.release();
});

describe('GameState.unsavedNotice', () => {
    test('the next seq to the room; not in the log; no persist hook; no RNG; works while suspended', () => {
        const game = new GameState('g-notice');
        game.eventSeq = 41;
        const changed = jest.spyOn(persistHooks, 'gameChanged');
        const rng = jest.spyOn(Math, 'random');
        game._suspended = { at: Date.now(), timers: new Map(), deferred: [] };
        expect(game.unsavedNotice(io, 'line')).toBe(true);
        expect(log.at(-1)).toMatchObject({ to: 'game:g-notice', event: 'gameLogEntry', data: { message: 'line', type: 'system', seq: 42 } });
        expect(game.eventSeq).toBe(42);
        expect(game.getGameLog().some((e) => e.message === 'line')).toBe(false);
        expect(changed).not.toHaveBeenCalled();
        expect(rng).not.toHaveBeenCalled();
        game._suspended = null;
    });

    test('a terminal game, or no io: nothing sent, no seq used', () => {
        const game = new GameState('g-notice-2');
        game.eventSeq = 7;
        expect(game.unsavedNotice(null, 'line')).toBe(false);
        jest.spyOn(game, 'isTerminal').mockReturnValue(true);
        expect(game.unsavedNotice(io, 'line')).toBe(false);
        expect(game.eventSeq).toBe(7);
        expect(log).toEqual([]);
    });
});
