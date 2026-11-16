/**
 * blockUser hardening: the target must be an account (a tombstone counts)
 * or a bot persona (they chat, and iOS 1.2.0 offers Block on every chat
 * line), and the list holds at most BLOCK_LIST_MAX names. Unblock always
 * works, also for a name that no longer exists.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const safety = require('../safetyHandlers');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { socketLogger } = require('../../utils/logger');

const { BLOCK_LIST_MAX } = safety;
let log;
let io;
let me;

beforeEach(() => {
    mockDb.current = createMemoryDb({ users: [] });
    jest.spyOn(socketLogger, 'info').mockImplementation(() => {});
    log = [];
    io = makeIo(log);
    me = makeSocket('bl-me', log, io);
    gameManager.registerUser(me.id, 'blocker');
    mockDb.current.users._insert({ username: 'blocker', profilePic: 1 });
    mockDb.current.users._insert({ username: 'bob', profilePic: 2 });
    mockDb.current.users._insert({ username: 'oldname', mergedInto: 'bob', mergedAt: new Date() });
});

afterEach(() => {
    gameManager.removeUserSocket(me.id);
    jest.restoreAllMocks();
});

const last = () => events(log, 'blockListUpdated').pop().data;
const stored = () => mockDb.current.users.docs.find((d) => d.username === 'blocker').blockedUsers || [];

test('an account, a tombstone and a bot persona can be blocked; an unknown name cannot', async () => {
    await safety.blockUser(me, io, { username: 'bob' });
    expect(last()).toEqual({ success: true, blockedUsers: ['bob'] });
    await safety.blockUser(me, io, { username: 'oldname' });
    await safety.blockUser(me, io, { username: '🤖 Mary' });
    expect(last()).toEqual({ success: true, blockedUsers: ['bob', 'oldname', '🤖 Mary'] });

    await safety.blockUser(me, io, { username: 'nobody' });
    expect(last()).toEqual({ success: false, message: 'No player by that name.' });
    expect(stored()).toEqual(['bob', 'oldname', '🤖 Mary']);
});

test('unblock works for a name that no longer exists', async () => {
    mockDb.current.users.docs.find((d) => d.username === 'blocker').blockedUsers = ['gone', 'bob'];
    await safety.unblockUser(me, io, { username: 'gone' });
    expect(last()).toEqual({ success: true, blockedUsers: ['bob'] });
});

test(`at ${BLOCK_LIST_MAX} names a new block is refused; a repeat and an unblock still work`, async () => {
    const full = Array.from({ length: BLOCK_LIST_MAX }, (_, i) => `p${i}`);
    mockDb.current.users.docs.find((d) => d.username === 'blocker').blockedUsers = [...full];
    await safety.blockUser(me, io, { username: 'bob' });
    expect(last()).toEqual({ success: false, message: `Your block list is full (${BLOCK_LIST_MAX} players). Unblock someone first.` });
    expect(stored()).toHaveLength(BLOCK_LIST_MAX);

    mockDb.current.users._insert({ username: 'p7', profilePic: 4 });
    await safety.blockUser(me, io, { username: 'p7' }); // already on the list
    expect(last()).toMatchObject({ success: true });
    expect(stored()).toHaveLength(BLOCK_LIST_MAX);

    await safety.unblockUser(me, io, { username: 'p0' });
    await safety.blockUser(me, io, { username: 'bob' });
    expect(last()).toMatchObject({ success: true });
    expect(stored()).toHaveLength(BLOCK_LIST_MAX);
    expect(stored()).toContain('bob');
});

test('a block that races to the cap is refused by the guarded write', async () => {
    const almost = Array.from({ length: BLOCK_LIST_MAX - 1 }, (_, i) => `p${i}`);
    const doc = mockDb.current.users.docs.find((d) => d.username === 'blocker');
    doc.blockedUsers = [...almost];
    const users = mockDb.current.users;
    const realFindOne = users.findOne.bind(users);
    // Another block lands between the check and the write
    jest.spyOn(users, 'findOne').mockImplementation(async (filter, opts) => {
        const out = await realFindOne(filter, opts);
        if (filter.username === 'blocker' && opts?.projection?.blockedUsers && doc.blockedUsers.length < BLOCK_LIST_MAX) {
            doc.blockedUsers.push('racer');
        }
        return out;
    });
    await safety.blockUser(me, io, { username: 'bob' });
    expect(last().success).toBe(false);
    expect(doc.blockedUsers).toHaveLength(BLOCK_LIST_MAX);
    expect(doc.blockedUsers).not.toContain('bob');
});
