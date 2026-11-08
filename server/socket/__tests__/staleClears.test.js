/**
 * Stale activeGameId / activeTournamentId clears are scoped to the stale id,
 * so a pointer written meanwhile by a new game is never wiped. Real
 * GameManager + authHandlers + reconnectHandlers over the in-memory DB.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const auth = require('../authHandlers');
const reconnect = require('../reconnectHandlers');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');

let log;
let io;
let n = 0;

beforeEach(async () => {
    log = [];
    io = makeIo(log);
    mockDb.current = createMemoryDb({
        users: [{ username: 'Dee', password: await bcrypt.hash('pw', 4), activeGameId: 'G1', activeTournamentId: 'T1' }]
    });
});

afterEach(() => jest.restoreAllMocks());

const user = () => mockDb.current.users.findOne({ username: 'Dee' });
const last = (event) => log.filter(l => l.event === event).pop()?.data;

/** Run `before` against the real collection right before each matching $unset lands. */
function interceptUnset(field, before) {
    const real = mockDb.current.users.updateOne.bind(mockDb.current.users);
    jest.spyOn(mockDb.current.users, 'updateOne').mockImplementation(async (filter, update) => {
        if (update.$unset && field in update.$unset) await before(real);
        return real(filter, update);
    });
}

test('sign-in clears the stale G1 but keeps a G2 written before the clear lands', async () => {
    const real = mockDb.current.users.updateOne.bind(mockDb.current.users);
    jest.spyOn(mockDb.current.users, 'updateOne').mockImplementation(async (filter, update) => {
        // A new game / tournament starts for Dee between the read and the clear
        if (update.$unset && 'activeGameId' in update.$unset) {
            await real({ username: 'Dee' }, { $set: { activeGameId: 'G2' } });
        }
        if (update.$unset && 'activeTournamentId' in update.$unset) {
            await real({ username: 'Dee' }, { $set: { activeTournamentId: 'T2' } });
        }
        return real(filter, update);
    });
    const socket = makeSocket(`sc-${++n}`, log, io);
    await auth.signIn(socket, io, { username: 'Dee', password: 'pw' });
    expect(last('signInResponse')).toMatchObject({ success: true });
    const doc = await user();
    expect(doc.activeGameId).toBe('G2');
    expect(doc.activeTournamentId).toBe('T2');
});

test('without a race the stale pointers are cleared', async () => {
    await auth.signIn(makeSocket(`sc-${++n}`, log, io), io, { username: 'Dee', password: 'pw' });
    const doc = await user();
    expect(doc.activeGameId).toBeUndefined();
    expect(doc.activeTournamentId).toBeUndefined();
});

test('restoreSession clears only the stale id too', async () => {
    await auth.signIn(makeSocket(`sc-${++n}`, log, io), io, { username: 'Dee', password: 'pw' });
    const { sessionToken } = last('signInResponse');
    await mockDb.current.users.updateOne({ username: 'Dee' }, { $set: { activeGameId: 'G3' } });
    interceptUnset('activeGameId', (real) => real({ username: 'Dee' }, { $set: { activeGameId: 'G4' } }));
    await auth.restoreSession(makeSocket(`sc-${++n}`, log, io), io, { username: 'Dee', sessionToken });
    expect(last('restoreSessionResponse')).toMatchObject({ success: true });
    expect((await user()).activeGameId).toBe('G4');
});

test("rejoinFailed's clear leaves another game's pointer alone", async () => {
    await mockDb.current.users.updateOne({ username: 'Dee' }, { $set: { activeGameId: 'G2' } });
    const socket = makeSocket(`sc-${++n}`, log, io);
    gameManager.registerUser(socket.id, 'Dee');
    await reconnect.rejoinGame(socket, io, { gameId: 'G1', username: 'Dee' });
    expect(last('rejoinFailed')).toEqual({ reason: 'Game no longer exists' });
    expect((await user()).activeGameId).toBe('G2');

    // The pointer to the game that is gone is still cleared
    await reconnect.rejoinGame(socket, io, { gameId: 'G2', username: 'Dee' });
    expect((await user()).activeGameId).toBeUndefined();
});
