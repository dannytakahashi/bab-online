/**
 * User-safety socket event handlers: reporting and blocking other users.
 * Required for App Store Guideline 1.2 (UGC apps need a mechanism to report
 * offensive content and block abusive users).
 */

const { getUsersCollection, getReportsCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');

/**
 * File a report against another user. Stored in the reports collection for
 * review; reporters get an acknowledgement immediately.
 */
async function reportUser(socket, io, data) {
    const reporter = gameManager.getUserBySocketId(socket.id);
    if (!reporter) {
        socket.emit('reportUserResponse', { success: false, message: 'Not signed in' });
        return;
    }

    const { username, reason, context } = data;
    if (username === reporter.username) {
        socket.emit('reportUserResponse', { success: false, message: 'You cannot report yourself' });
        return;
    }

    const reports = getReportsCollection();
    if (!reports) {
        socket.emit('reportUserResponse', { success: false, message: 'Service unavailable. Try again.' });
        return;
    }

    try {
        await reports.insertOne({
            reporter: reporter.username,
            reported: username,
            reason,
            context: context || '',
            createdAt: new Date()
        });

        socket.emit('reportUserResponse', { success: true });
        socketLogger.info('User report filed', {
            reporter: reporter.username, reported: username, reason
        });
    } catch (error) {
        socketLogger.error('Failed to store user report', { error: error.message });
        socket.emit('reportUserResponse', { success: false, message: 'Failed to submit report. Try again.' });
    }
}

/**
 * Block a user: their chat messages are hidden on this account's clients.
 * The block list persists on the user document and is sent at sign-in.
 */
async function blockUser(socket, io, data) {
    await updateBlockList(socket, data.username, '$addToSet');
}

async function unblockUser(socket, io, data) {
    await updateBlockList(socket, data.username, '$pull');
}

async function updateBlockList(socket, targetUsername, op) {
    const user = gameManager.getUserBySocketId(socket.id);
    if (!user) {
        socket.emit('blockListUpdated', { success: false, message: 'Not signed in' });
        return;
    }
    if (targetUsername === user.username) {
        socket.emit('blockListUpdated', { success: false, message: 'You cannot block yourself' });
        return;
    }

    const usersCollection = getUsersCollection();
    if (!usersCollection) {
        socket.emit('blockListUpdated', { success: false, message: 'Service unavailable. Try again.' });
        return;
    }

    try {
        await usersCollection.updateOne(
            { username: user.username },
            { [op]: { blockedUsers: targetUsername } }
        );
        const updated = await usersCollection.findOne(
            { username: user.username },
            { projection: { blockedUsers: 1 } }
        );

        socket.emit('blockListUpdated', {
            success: true,
            blockedUsers: updated?.blockedUsers || []
        });
        socketLogger.info('Block list updated', {
            username: user.username, target: targetUsername, op
        });
    } catch (error) {
        socketLogger.error('Failed to update block list', { error: error.message });
        socket.emit('blockListUpdated', { success: false, message: 'Failed to update block list. Try again.' });
    }
}

module.exports = {
    reportUser,
    blockUser,
    unblockUser
};
