/**
 * Adoption (deploy survival PR 5; persist/adopt.js through the 'on'
 * store, the plan's 2.1 adoption rule, 2.5 and 2.6), over persistHarness's
 * liveDb and real games. Instance A saves a table and "dies" (its store
 * closed, its process memory reset: GameManager / BotController), then B
 * (another bootId, its own monotonic clock) sweeps:
 *   - adoptable: released (at once); not released with an owner seen dead
 *     (beat unchanged for 12 s on B's clock); same deployment + seen dead
 *     (no age limit)
 *   - never: a live owner's doc (whatever its mode), B's own docs
 *   - discarded (deleted, pointers cleared): ownerMode 'write', older than
 *     15 min, an unreadable codec version, a crash loop; dropped:
 *     gameRecords has the game; not restorable: adoptGame throws
 *   - accounts: a deleted owner's or a merged owner's seat becomes
 *     resignBot/gone, a deleted sender's chat is dropped, a merged
 *     sender's and a bot quip stay, the name hold's deletedAt is learnt
 *   - adoptAttempts: a deploy then a crash 20 min later still resumes; a
 *     doc that killed two adopters within 60 s each is discarded
 *   - the ENDED tombstone: recorded once, stats once, pointers cleared,
 *     deleted
 *   - single flight; an adopt race has one winner; resolve() answers
 * restoreGame.adoptGame and isGated are the real ones (liveStoreKit
 * installOnStore records each adoptGame call; a test may treat a gate as
 * open by id with store.openGates).
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const liveStore = require('../liveStore');
const adopt = require('../adopt');
const accountDelete = require('../../../admin/accountDelete');
const chatHandlers = require('../../../socket/chatHandlers');
const profileHandlers = require('../../../socket/profileHandlers');
const shutdown = require('../../../utils/shutdown');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;
let io;
let log;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(21);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    log = [];
    io = makeIo(log);
});

afterEach(() => {
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    gameManager.deletedUsernames?.clear?.();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const users = () => db().users;
const doc = (id) => kit.savedGame(db(), id);
const pointer = (u) => users().docs.find((d) => d.username === u)?.activeGameId ?? null;

/** Instance A (an 'on' store) with a dealt casual table, saved; its humans' pointers set. */
async function savedByA({ humans = ['Hal'], mode = 'on', deploymentId = 'dep-A' } = {}) {
    const A = mode === 'on'
        ? kit.installOnStore(mockDb, { bootId: 'boot-A', deploymentId, getIo: () => io })
        : kit.installStore(mockDb, { bootId: 'boot-A', mode, deploymentId, getIo: () => io });
    await A.start({ io });
    const { game, sockets } = await kit.startGame(io, log, { humans });
    for (const u of humans) await users().updateOne({ username: u }, { $set: { activeGameId: game.gameId } });
    await h.flushStore(A);
    const before = h.authoritative(game);
    const memory = Object.fromEntries(botController.getGameBots(game.gameId).map((b) => [b.socketId, kit.plain(b.getMemorySnapshot())]));
    return { A, game, sockets, before, memory, id: game.gameId };
}

/** The process behind `store` is gone: no more writes or beats, and its memory is reset. */
function dies(store) {
    store.close();
    profileHandlers._resetStatsWritesForTests();
    gameManager._resetForTests();
    botController._resetForTests();
}

async function release(id, { kind = 'handoff', at = new Date() } = {}) {
    await db().liveGames.updateOne({ _id: id }, { $set: { released: true, releasedAt: at, releaseKind: kind } });
}

/** Instance B: an 'on' store with its own monotonic clock, the process's store from now on. */
async function startB({ bootId = 'boot-B', deploymentId = 'dep-B', advance = 1000, ...opts } = {}) {
    // B boots later than A
    if (advance) await jest.advanceTimersByTimeAsync(advance);
    const clock = h.createMonoClock();
    const B = kit.installOnStore(mockDb, { bootId, deploymentId, monoNow: clock.now, getIo: () => io, ...opts });
    B.clock = clock;
    await B.start({ io });
    await B.whenBootSwept();
    await h.flushStore(B);
    return B;
}

/** Keep `bootId`'s instance doc beating (a live owner) for `ms` of fake time. */
async function liveOwnerFor(bootId, ms) {
    for (let t = 0; t < ms; t += 3000) {
        await db().serverInstances.updateOne({ _id: bootId }, { $inc: { beatSeq: 1 }, $set: { beatAt: new Date() } });
        await jest.advanceTimersByTimeAsync(3000);
    }
}

describe('adoptable', () => {
    test('released: adopted by the boot sweep at once, the same game (hands, score, seats, bots and their card memory), one adoptGame call', async () => {
        const { A, id, before, memory } = await savedByA();
        const rev = doc(id).rev;
        await release(id);
        dies(A);
        const B = await startB();
        const game = gameManager.games.get(id);
        expect(game).toBeTruthy();
        expect(h.authoritative(game)).toEqual(before);
        for (const b of botController.getGameBots(id)) expect(kit.plain(b.getMemorySnapshot())).toEqual(memory[b.socketId]);
        expect(B.adoptCalls).toHaveLength(1);
        expect(B.adoptCalls[0].opts).toEqual({ now: expect.any(Number), abandonMs: adopt.RESTORE_ABANDON_MS, ownerPics: {} });
        expect(adopt.RESTORE_ABANDON_MS).toBe(10 * 60 * 1000);
        expect(B.adoptCalls[0].doc).toMatchObject({ gameId: id, v: expect.any(Number), stage: expect.any(String) });
        expect(game.gameLog.filter((e) => e.message === adopt.RESUMED_LINE)).toHaveLength(1);
        expect(doc(id)).toMatchObject({ owner: 'boot-B', ownerMode: 'on', released: false, releasedAt: null, adoptedBy: 'boot-B', adoptAttempts: 1 });
        expect(doc(id).rev).toBeGreaterThan(rev);
        expect(B.health()).toMatchObject({ effectiveMode: 'on', adopted: 1, bootSwept: true, lastSweepAt: expect.any(String) });
        // From now on B's writes are updates of that doc (never an insert), the
        // first one with the whole log (the resumed line included)
        expect(db().faults.calls.filter((c) => c.collection === 'liveGames' && c.op === 'insertOne' && c.instance === undefined)).toHaveLength(1);
        expect(doc(id).log.at(-1).message).toBe(adopt.RESUMED_LINE);
        expect(kit.comparable(doc(id))).toEqual(kit.comparable(require('../gameCodec').serialize(game)));
    });

    test("an owner's custom picture (never in the doc) reaches adoptGame from the users lookup and is the restored seat's", async () => {
        const { A, id, game: gameA } = await savedByA();
        const pos = gameA.seatList().find((s) => s.ownerUsername === 'Hal').position;
        await release(id);
        dies(A);
        const pic = ['data:image/png;base64', 'iVBORw0KGgo='].join(',');
        await users().updateOne({ username: 'Hal' }, { $set: { customProfilePic: pic } });
        // Hal played with that custom picture: the codec saved none for the seat
        doc(id).state.seats[pos].ownerPic = null;
        const B = await startB();
        const game = gameManager.games.get(id);
        expect(B.adoptCalls[0].opts.ownerPics).toEqual({ Hal: pic });
        expect(game.seat(pos).ownerPic).toBe(pic);
        // The real gate: closed until the humans are back
        expect(require('../restoreGame').isGated(game)).toBe(true);
        expect(doc(id).state.seats[pos].ownerPic).toBeNull();
    });

    test('the gate: adoptAttempts stays while gated, and the first write once it opens sets it to 0', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        await jest.advanceTimersByTimeAsync(1000);
        const clock = h.createMonoClock();
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', monoNow: clock.now, getIo: () => io });
        await B.start({ io });
        await B.whenBootSwept();
        await h.flushStore(B);
        const game = gameManager.games.get(id);
        game.addLogEntry('a change while gated', null, 'system');
        await h.flushStore(B);
        expect(doc(id).adoptAttempts).toBe(1);
        B.openGates.add(id);
        game.addLogEntry('a change once open', null, 'system');
        await h.flushStore(B);
        expect(doc(id).adoptAttempts).toBe(0);
    });

    test('not released, owner seen dead: pending while its beat is unchanged for under 12 s on B\'s clock, adopted after', async () => {
        const { A, id } = await savedByA();
        dies(A);
        const B = await startB();
        expect(doc(id).owner).toBe('boot-A');
        await jest.advanceTimersByTimeAsync(adopt.STALE_MS - 2000);
        await h.flushStore(B);
        expect(doc(id).owner).toBe('boot-A');
        expect(B.adoptCalls).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(3000);
        await h.flushStore(B);
        expect(doc(id)).toMatchObject({ owner: 'boot-B', adoptAttempts: 1 });
        expect(gameManager.games.get(id)).toBeTruthy();
    });

    test('a frozen monotonic clock on B never sees the owner die (no cross-clock comparison)', async () => {
        const { A, id } = await savedByA();
        dies(A);
        const B = await startB();
        B.clock.freeze();
        await jest.advanceTimersByTimeAsync(60000);
        await h.flushStore(B);
        expect(doc(id).owner).toBe('boot-A');
        B.clock.thaw();
        await jest.advanceTimersByTimeAsync(adopt.STALE_MS + 2000);
        await h.flushStore(B);
        expect(doc(id).owner).toBe('boot-B');
    });

    test('same deploymentId (a crash restart) and seen dead: adopted even with a last beat older than 15 min; another deployment discards it', async () => {
        for (const same of [true, false]) {
            const { A, id } = await savedByA({ deploymentId: 'dep-1' });
            dies(A);
            const old = new Date(Date.now() - 16 * 60 * 1000);
            await db().serverInstances.updateOne({ _id: 'boot-A' }, { $set: { beatAt: old, startedAt: old } });
            const B = await startB({ deploymentId: same ? 'dep-1' : 'dep-2', bootId: `boot-B-${same}` });
            await jest.advanceTimersByTimeAsync(adopt.STALE_MS + 2000);
            await h.flushStore(B);
            if (same) {
                expect(doc(id)).toMatchObject({ owner: 'boot-B-true' });
            } else {
                expect(doc(id)).toBeNull();
                expect(pointer('Hal')).toBeNull();
            }
            dies(B);
            db().liveGames.docs.length = 0;
            db().serverInstances.docs.length = 0;
        }
    });
});

describe('never adopted, never deleted', () => {
    test('a live owner\'s doc (beat changing), whatever its ownerMode, stays put for 30 s', async () => {
        for (const mode of ['on', 'write']) {
            const { A, id } = await savedByA({ mode });
            dies(A);
            const B = await startB({ bootId: `boot-B-${mode}` });
            await liveOwnerFor('boot-A', 30000);
            await h.flushStore(B);
            expect(doc(id)).toMatchObject({ owner: 'boot-A', ownerMode: mode });
            expect(B.adoptCalls).toHaveLength(0);
            dies(B);
            db().liveGames.docs.length = 0;
            db().serverInstances.docs.length = 0;
        }
    });

    test('B\'s own docs are never read by its sweep, released or not', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        await db().liveGames.updateOne({ _id: id }, { $set: { owner: 'boot-B' } });
        const B = await startB();
        await jest.advanceTimersByTimeAsync(20000);
        expect(B.adoptCalls).toHaveLength(0);
        expect(doc(id)).toMatchObject({ owner: 'boot-B', released: true });
        // The sweep's query excludes them
        expect(db().faults.calls.some((c) => c.collection === 'liveGames' && c.op === 'find')).toBe(true);
    });
});

describe('discarded (deleted, pointers cleared)', () => {
    test.each([
        ['ownerMode write (released)', async (id) => { await db().liveGames.updateOne({ _id: id }, { $set: { ownerMode: 'write' } }); await release(id); }],
        ['released more than 15 min ago', async (id) => { await release(id, { at: new Date(Date.now() - 16 * 60 * 1000) }); }],
        ['a codec version this process cannot read', async (id) => { await db().liveGames.updateOne({ _id: id }, { $set: { v: 99 } }); await release(id); }],
    ])('%s', async (_why, prepare) => {
        const { A, id } = await savedByA();
        await prepare(id);
        dies(A);
        expect(pointer('Hal')).toBe(id);
        const B = await startB();
        expect(doc(id)).toBeNull();
        expect(pointer('Hal')).toBeNull();
        expect(B.adoptCalls).toHaveLength(0);
        expect(gameManager.games.has(id)).toBe(false);
    });

    test('gameRecords already has the game: dropped, never hydrated', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        await db().gameRecords.insertOne({ gameId: id });
        const B = await startB();
        expect(doc(id)).toBeNull();
        expect(pointer('Hal')).toBeNull();
        expect(B.adoptCalls).toHaveLength(0);
    });

    test('adoptGame throws (not restorable): the doc goes and so do its pointers; resolve answers gone', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        const B = await startB({ adoption: { adoptGame: () => { throw Object.assign(new Error('gameCodec: invalid'), { name: 'CodecError', reason: 'invalid' }); } } });
        expect(doc(id)).toBeNull();
        expect(pointer('Hal')).toBeNull();
        // A (an older 'on' instance) is not seen dead yet: still pending
        await expect(B.resolve(id, { waitMs: 100 })).resolves.toEqual({ state: 'pending' });
        await jest.advanceTimersByTimeAsync(adopt.STALE_MS + 2000);
        await expect(B.resolve(id, { waitMs: 100 })).resolves.toEqual({ state: 'gone' });
    });

    test('adoptGame throws and the cleanup delete fails too: a later sweep retries it (doc and pointers gone); resolve answers gone, never pending for good', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        // The cleanup and its retry in the same boot pass both fail
        db().faults.fail({ collections: 'liveGames', ops: 'deleteOne', times: 2 });
        const B = await startB({ adoption: { adoptGame: () => { throw Object.assign(new Error('gameCodec: invalid'), { name: 'CodecError', reason: 'invalid' }); } } });
        expect(db().faults.calls.filter((c) => c.collection === 'liveGames' && c.op === 'deleteOne' && c.outcome === 'failed')).toHaveLength(2);
        // Left ours, live, unreleased, in no memory; Hal's pointer still names it
        expect(doc(id)).toMatchObject({ owner: 'boot-B', kind: 'live', released: false });
        expect(gameManager.games.has(id)).toBe(false);
        expect(pointer('Hal')).toBe(id);
        // The next sweep (every second) removes it, then the pointer
        await jest.advanceTimersByTimeAsync(adopt.SWEEP_FAST_MS + 10);
        await h.flushStore(B);
        expect(doc(id)).toBeNull();
        expect(pointer('Hal')).toBeNull();
        await jest.advanceTimersByTimeAsync(adopt.STALE_MS + 2000);
        await expect(B.resolve(id, { waitMs: 100 })).resolves.toEqual({ state: 'gone' });
    });

    test('the same orphan asked for by a rejoin before any sweep retried it: resolve removes it and answers gone', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        db().faults.fail({ collections: 'liveGames', ops: 'deleteOne', times: 2 });
        const B = await startB({ adoption: { adoptGame: () => { throw Object.assign(new Error('gameCodec: invalid'), { name: 'CodecError', reason: 'invalid' }); } }, sweepFastMs: 60000 });
        expect(doc(id)).toMatchObject({ owner: 'boot-B', kind: 'live' });
        await expect(B.resolve(id, { waitMs: 100 })).resolves.toEqual({ state: 'gone' });
        expect(doc(id)).toBeNull();
        expect(pointer('Hal')).toBeNull();
    });

    test('an own live doc nothing here holds (an abort whose delete failed): resolve answers gone and removes it; while the abort is still pending: pending', async () => {
        const gameLifecycle = require('../../../socket/gameLifecycle');
        const { A, id, game } = await savedByA();
        await jest.advanceTimersByTimeAsync(1000);
        // The abort's delete stalls: still held here (its claim pending)
        db().faults.stall({ collections: 'liveGames', ops: 'deleteOne' });
        const aborting = gameLifecycle.abortGame(io, game, 'test');
        await jest.advanceTimersByTimeAsync(5);
        await expect(A.resolve(id, { waitMs: 100 })).resolves.toEqual({ state: 'pending' });
        // It fails: the doc is left, and nothing here holds it any more
        db().faults.clear();
        db().faults.fail({ collections: 'liveGames', ops: 'deleteOne', times: 1 });
        db().faults.release();
        await jest.advanceTimersByTimeAsync(10);
        await aborting;
        expect(doc(id)).toMatchObject({ owner: 'boot-A', kind: 'live' });
        await expect(A.resolve(id, { waitMs: 100 })).resolves.toEqual({ state: 'gone' });
        await h.flushStore(A);
        expect(doc(id)).toBeNull();
    });
});

describe('accounts at adoption', () => {
    test('deleted and merged owners: resignBot/gone seats; a deleted sender\'s chat dropped, a merged sender\'s and a bot quip kept; the name hold learnt', async () => {
        const { A, id, game, sockets } = await savedByA({ humans: ['Hal', 'Ann', 'Cy'] });
        await chatHandlers.chatMessage(sockets[0], io, { message: 'hello from hal' });
        await chatHandlers.chatMessage(sockets[1], io, { message: 'hello from ann' });
        const bot = botController.getGameBots(id)[0];
        game.addLogEntry(`${bot.username}: quip`, bot.position, 'chat', { from: bot.username });
        await h.flushStore(A);
        const posOf = (u) => game.seatList().find((s) => s.ownerUsername === u).position;
        const [halPos, annPos, cyPos] = ['Hal', 'Ann', 'Cy'].map(posOf);
        const createdAt = game.createdAt;
        await release(id);
        dies(A);
        const deletedAt = new Date(Date.now() - 1000);
        await users().updateOne({ username: 'Hal' }, { $set: { mergedInto: '[deleted]', deletedAt } });
        await users().updateOne({ username: 'Ann' }, { $set: { mergedInto: 'Annie' } });
        const B = await startB();
        const sent = B.adoptCalls[0].doc;
        for (const pos of [halPos, annPos]) {
            expect(sent.state.seats[pos]).toMatchObject({ controller: 'resignBot', presence: 'gone', gone: true, bot: { socketId: expect.stringMatching(/^bot:/) } });
            expect(sent.bots.some((b) => b.position === pos && b.socketId === sent.state.seats[pos].bot.socketId)).toBe(true);
        }
        expect(sent.state.seats[cyPos]).toMatchObject({ controller: 'human', ownerUsername: 'Cy' });
        const lines = sent.log.map((e) => e.message);
        expect(lines.some((m) => m.includes('hello from hal'))).toBe(false);
        expect(lines.some((m) => m.includes('hello from ann'))).toBe(true);
        expect(lines).toContain(`${bot.username}: quip`);
        expect(accountDelete.deletedSince('Hal', createdAt)).toBe(true);
        expect(gameManager.deletedUsernames.has('Hal')).toBe(true);
        // The adopted game plays those seats with bots
        const adopted = gameManager.games.get(id);
        expect(adopted.seat(halPos)).toMatchObject({ controller: 'resignBot', presence: 'gone' });
        expect(adopted.seat(cyPos)).toMatchObject({ controller: 'human', presence: 'grace' });
        // One users.find for owners and senders together (bot personas never looked up)
        const finds = db().faults.calls.filter((c) => c.collection === 'users' && c.op === 'find');
        expect(finds).toHaveLength(1);
    });
});

describe('adoptAttempts', () => {
    test('a deploy, then a crash of the adopter 20 min later: the game still resumes', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        const B = await startB();
        expect(doc(id).adoptAttempts).toBe(1);
        // B ran it for 20 minutes, then crashed (its crash release)
        await db().liveGames.updateOne({ _id: id }, { $set: { adoptedAt: new Date(Date.now() - 20 * 60 * 1000) } });
        await release(id, { kind: 'crash' });
        dies(B);
        const C = await startB({ bootId: 'boot-C' });
        expect(doc(id)).toMatchObject({ owner: 'boot-C', adoptAttempts: 1 });
        expect(C.adoptCalls).toHaveLength(1);
    });

    test('a doc that kills two adopters within 60 s each is discarded by the third', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        let next = 'boot-B';
        for (const [i, expected] of [[1, 1], [2, 2]]) {
            const S = await startB({ bootId: next });
            expect(doc(id)).toMatchObject({ owner: next, adoptAttempts: expected });
            // Dies 10 s after adopting (its crash release)
            await jest.advanceTimersByTimeAsync(10000);
            await release(id, { kind: 'crash' });
            dies(S);
            next = `boot-${i + 2}`;
        }
        const last = await startB({ bootId: next });
        expect(last.adoptCalls).toHaveLength(0);
        expect(doc(id)).toBeNull();
        expect(pointer('Hal')).toBeNull();
    });
});

describe('the ENDED tombstone', () => {
    /** A finished game whose record insert never landed (A killed between the claim and the insert). */
    async function tombstoneByA() {
        const { A, id, sockets, game } = await savedByA();
        await chatHandlers.chatMessage(sockets[0], io, { message: '/lazy' });
        await h.flushStore(A);
        db().faults.stall({ collections: 'gameRecords', ops: 'insertOne' });
        await kit.advanceUntil(() => game.isTerminal(), { step: 1000, cap: 3 * 3600000 });
        expect(game.stage).toBe(Phase.ENDED);
        await kit.advanceUntil(() => doc(id)?.kind === 'ended', { step: 10, cap: 10000 });
        // SIGKILL: the stalled insert never applies
        db().faults.abandon();
        db().faults.release();
        dies(A);
        // gameEnd's clear ran before the kill; the pointer a stale client still has
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: id } });
        expect(db().gameRecords.docs).toHaveLength(0);
        return { id };
    }

    test('adopted once its owner is seen dead: recorded once, stats once, pointers cleared, deleted', async () => {
        const { id } = await tombstoneByA();
        const tomb = kit.plain(doc(id));
        const B = await startB();
        await jest.advanceTimersByTimeAsync(adopt.STALE_MS + 2000);
        await h.flushStore(B);
        expect(doc(id)).toBeNull();
        expect(db().gameRecords.docs.map((r) => r.gameId)).toEqual([id]);
        expect(users().docs.find((u) => u.username === 'Hal').botStats.gamesPlayed).toBe(1);
        expect(pointer('Hal')).toBeNull();
        expect(B.adoptCalls).toHaveLength(0);
        // The same tombstone adopted again (a second copy, a replay): no second record, no second count
        db().liveGames._insert({ ...tomb, ended: { ...tomb.ended, record: { ...tomb.ended.record, completedAt: new Date(tomb.ended.record.completedAt) } }, released: true, releasedAt: new Date(), releaseKind: 'handoff' });
        await B.sweep();
        await h.flushStore(B);
        expect(doc(id)).toBeNull();
        expect(db().gameRecords.docs).toHaveLength(1);
        expect(users().docs.find((u) => u.username === 'Hal').botStats.gamesPlayed).toBe(1);
    }, 60000);

    test('a record insert that fails keeps the tombstone (held) and the next sweep finishes it', async () => {
        const { id } = await tombstoneByA();
        await release(id);
        db().faults.fail({ collections: 'gameRecords', ops: ['insertOne', 'findOne'], times: 12 });
        profileHandlers._setStatsRetryDelaysForTests([1, 1]);
        await jest.advanceTimersByTimeAsync(1000);
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', monoNow: h.createMonoClock().now, getIo: () => io });
        await B.start({ io });
        await kit.advanceUntil(() => B.health().bootSwept, { step: 1, cap: 5000 });
        expect(doc(id)).toMatchObject({ owner: 'boot-B', kind: 'ended' });
        expect(db().gameRecords.docs).toHaveLength(0);
        db().faults.clear();
        await jest.advanceTimersByTimeAsync(2000);
        await h.flushStore(B);
        expect(doc(id)).toBeNull();
        expect(db().gameRecords.docs).toHaveLength(1);
        profileHandlers._setStatsRetryDelaysForTests();
    }, 60000);
});

describe('single flight, races, resolve', () => {
    test('a sweep and two resolves at once adopt once', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        await jest.advanceTimersByTimeAsync(1000);
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', monoNow: h.createMonoClock().now, getIo: () => io });
        await B.start({ io });
        const [r1, r2] = await Promise.all([B.resolve(id), B.resolve(id), B.sweep()]);
        expect(B.adoptCalls).toHaveLength(1);
        // Each waited for the boot sweep, which adopted it
        for (const r of [r1, r2]) expect(['memory', 'adopted']).toContain(r.state);
        expect(r1.game).toBe(gameManager.games.get(id));
        expect(r2.game).toBe(gameManager.games.get(id));
    });

    test('two adopters race for one doc: exactly one wins the compare-and-set', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        await jest.advanceTimersByTimeAsync(1000);
        const make = (bootId) => {
            const calls = [];
            const s = liveStore.createLiveStore({
                mode: 'on', bootId, gameIdIndexUnique: () => true, getCollections: () => db(), getIo: () => io,
                logger: kit.recordingLogger().logger, monoNow: h.createMonoClock().now,
                adoption: { adoptGame: kit.recordingAdoptGame(calls), isGated: () => false }
            });
            s.calls = calls;
            return s;
        };
        const B = make('boot-B');
        const C = make('boot-C');
        await Promise.all([B.start({ io }), C.start({ io })]);
        await Promise.all([B.sweep(), C.sweep(), B.whenBootSwept(), C.whenBootSwept()]);
        expect(B.calls.length + C.calls.length).toBe(1);
        expect(['boot-B', 'boot-C']).toContain(doc(id).owner);
        B.close();
        C.close();
    });

    test('resolve: memory, adopted, pending (live owner), pending (an older live on instance), gone, pending while shutting down; whenAdopted', async () => {
        const { A, id } = await savedByA();
        await expect(A.resolve(id)).resolves.toMatchObject({ state: 'memory', game: gameManager.games.get(id) });
        dies(A);
        let shuttingDown = false;
        const B = await startB({ isShuttingDown: () => shuttingDown });
        // A's instance doc still beats: its unreleased doc is pending, and so
        // is an id nobody knows (A is an older live 'on' instance)
        await db().serverInstances.updateOne({ _id: 'boot-A' }, { $inc: { beatSeq: 1 } });
        await expect(B.resolve(id, { waitMs: 100 })).resolves.toEqual({ state: 'pending' });
        await expect(B.resolve('g-nobody', { waitMs: 100 })).resolves.toEqual({ state: 'pending' });
        const waiting = B.whenAdopted(id, 30000);
        await release(id);
        const r = await B.resolve(id, { waitMs: 100 });
        expect(r).toMatchObject({ state: 'adopted', game: gameManager.games.get(id) });
        await expect(waiting).resolves.toBe(gameManager.games.get(id));
        await expect(B.resolve(id)).resolves.toMatchObject({ state: 'memory' });
        // A is seen dead now: an unknown id is gone
        await jest.advanceTimersByTimeAsync(adopt.STALE_MS + 2000);
        await expect(B.resolve('g-nobody', { waitMs: 100 })).resolves.toEqual({ state: 'gone' });
        // A table a live instance lists (started there during the overlap, not written yet) is pending
        db().serverInstances._insert({ _id: 'boot-Z', mode: 'on', startedAt: new Date(Date.now() + 1000), beatAt: new Date(), beatSeq: 1, gameIds: ['g-new'] });
        await expect(B.resolve('g-new', { waitMs: 100 })).resolves.toEqual({ state: 'pending' });
        shuttingDown = true;
        await expect(B.resolve('g-nobody', { waitMs: 100 })).resolves.toEqual({ state: 'pending' });
        expect(B.whenAdopted('g-nobody', 50)).resolves.toBeNull();
        await jest.advanceTimersByTimeAsync(100);
    });

    test("'on' before start (a cold start, no healthcheck gate): resolve never answers gone; once started it answers", async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        await jest.advanceTimersByTimeAsync(1000);
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', monoNow: h.createMonoClock().now, getIo: () => io });
        const early = B.resolve(id, { waitMs: 200 });
        await jest.advanceTimersByTimeAsync(250);
        await expect(early).resolves.toEqual({ state: 'pending' });
        const later = B.resolve(id, { waitMs: 5000 });
        await B.start({ io });
        await expect(later).resolves.toMatchObject({ state: expect.stringMatching(/^(adopted|memory)$/), game: expect.anything() });
    });

    test('write and off never adopt: resolve answers memory or gone, the sweep never runs', async () => {
        const { A, id } = await savedByA({ mode: 'write' });
        await release(id);
        dies(A);
        const W = kit.installStore(mockDb, { bootId: 'boot-W', mode: 'write' });
        await W.start({ io });
        await jest.advanceTimersByTimeAsync(5000);
        await expect(W.resolve(id)).resolves.toEqual({ state: 'gone' });
        expect(doc(id)).toMatchObject({ owner: 'boot-A' });
        expect(db().faults.calls.filter((c) => c.collection === 'liveGames' && c.op === 'find')).toEqual([]);
        expect(W.ready()).toBe(true);
    });
});

describe('classify (the adoption rule, pure)', () => {
    const base = { _id: 'g', owner: 'boot-A', ownerMode: 'on', kind: 'live', v: 3, released: true, releasedAt: new Date(1e12), rev: 4 };
    const ctx = { ownerState: 'dead', ownerInst: null, me: 'boot-B', myStartedAt: new Date(1e12), myDeploymentId: 'd', now: 1e12 + 1000, readVersions: [1, 2, 3] };
    test.each([
        ['released', {}, {}, 'adopt'],
        ['mine', { owner: 'boot-B' }, {}, 'pending'],
        ['tournament table, ownerMode on (PR 6)', { tournamentId: 't1' }, {}, 'tournament'],
        ['tournament table, ownerMode write (PR 5), owner dead', { tournamentId: 't1', ownerMode: 'write' }, {}, 'discard'],
        ['tournament table, owner alive', { tournamentId: 't1', ownerMode: 'write', released: false }, { ownerState: 'alive' }, 'pending'],
        ['unreleased, owner alive', { released: false }, { ownerState: 'alive' }, 'pending'],
        ['write mode, owner dead', { ownerMode: 'write', released: false, updatedAt: new Date(1e12) }, {}, 'discard'],
        ['version', { v: 9 }, {}, 'discard'],
        ['age', { releasedAt: new Date(1e12 - 16 * 60000) }, {}, 'discard'],
        ['tombstone', { kind: 'ended', v: null }, {}, 'tombstone'],
    ])('%s', (_name, over, ctxOver, act) => {
        expect(adopt.classify({ ...base, ...over }, { ...ctx, ...ctxOver }).act).toBe(act);
    });
});
