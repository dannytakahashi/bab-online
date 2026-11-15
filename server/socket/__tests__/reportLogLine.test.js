/**
 * reportUser's log line names who reported whom but never the reason: the
 * reason is free text that can quote chat, and the privacy policy says chat
 * never reaches the logs (the reports row keeps it for moderation).
 */

jest.mock('../../database', () => ({
    getUsersCollection: jest.fn(() => null),
    getReportsCollection: jest.fn()
}));
jest.mock('../../game/GameManager', () => ({ getUserBySocketId: jest.fn() }));

const database = require('../../database');
const gameManager = require('../../game/GameManager');
const { socketLogger } = require('../../utils/logger');
const { reportUser } = require('../safetyHandlers');

test('the stored row keeps the reason, the log line does not', async () => {
    const inserted = [];
    database.getReportsCollection.mockReturnValue({ insertOne: async (doc) => { inserted.push(doc); } });
    gameManager.getUserBySocketId.mockReturnValue({ username: 'alice' });
    const info = jest.spyOn(socketLogger, 'info').mockImplementation(() => {});
    const socket = { id: 's1', emit: jest.fn() };

    await reportUser(socket, null, { username: 'bob', reason: 'quoted chat: some words', context: 'game chat' });

    expect(socket.emit).toHaveBeenCalledWith('reportUserResponse', { success: true });
    expect(inserted[0].reason).toBe('quoted chat: some words');
    const line = info.mock.calls.find(([msg]) => msg === 'User report filed');
    expect(line[1]).toEqual({ reporter: 'alice', reported: 'bob' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('quoted chat');
    info.mockRestore();
});
