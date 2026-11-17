/**
 * Deploy measurement in server/socket/index.js: every connection is counted
 * (utils/connectionStats.js, read by the SIGTERM line), gated old iOS
 * builds included, and the process's first connection is logged once with
 * its time. Nothing else about the connection changes.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const { setupSocketHandlers } = require('../index');
const { makeSocket } = require('../../testUtils/gameDriver');
const { socketLogger } = require('../../utils/logger');
const connectionStats = require('../../utils/connectionStats');

let n = 0;
function connect(ua = 'Mozilla/5.0 (Macintosh)') {
    const socket = makeSocket(`fc-${++n}`, []);
    socket.handshake = { headers: { 'user-agent': ua }, address: '203.0.113.9' };
    socket.on = () => {};
    socket.disconnect = jest.fn();
    setupSocketHandlers({ on: (ev, cb) => cb(socket) });
    return socket;
}

beforeEach(() => {
    mockDb.current = createMemoryDb();
    connectionStats._resetForTests();
    for (const m of ['debug', 'warn']) jest.spyOn(socketLogger, m).mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('the first connection is logged once with an ISO time; every connection is counted', () => {
    const info = jest.spyOn(socketLogger, 'info').mockImplementation(() => {});
    connect();
    connect();
    connect('BAB%20Online/1 CFNetwork/3896.200.61 Darwin/27.2.0'); // a gated 1.0.0 still counts
    const lines = info.mock.calls.filter(([msg]) => msg === 'First socket connection');
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0][1])).toEqual(['at']);
    expect(lines[0][1].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(connectionStats.connectionStats()).toMatchObject({ connectionsInLast60s: 3, connectionsTotal: 3 });
});
