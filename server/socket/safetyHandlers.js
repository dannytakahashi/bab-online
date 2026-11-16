/**
 * User-safety socket event handlers: reporting and blocking other users.
 * Required for App Store Guideline 1.2 (UGC apps need a mechanism to report
 * offensive content and block abusive users).
 */

const { getUsersCollection, getReportsCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { rememberBlockList } = require('./voiceHandlers');

// Enough for any real list; bounds the document and every sign-in payload
const BLOCK_LIST_MAX = 200;
const BLOCK_LIST_FULL = `Your block list is full (${BLOCK_LIST_MAX} players). Unblock someone first.`;

// Bot personas chat too (lazy bots, the ambient game, '🤖 Bot 2' labels):
// iOS 1.2.0 offers Block on any chat line, so a 🤖 name counts as existing
// (no account can have one: sign-up names have no emoji, usernameRules)
const isBotName = (name) => typeof name === 'string' && name.startsWith('🤖 ');

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
        // Not the reason: it is free text that can quote the chat, which the
        // privacy policy says never reaches the logs (the row holds it)
        socketLogger.info('User report filed', {
            reporter: reporter.username, reported: username
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
    if (!(await updateBlockList(socket, data.username, '$addToSet'))) return;
    // A live call between the two (same lobby or game voice room) ends now:
    // voice signaling refuses new signals between them, but an established
    // P2P call used to survive the block (gameVoice.endBlockedCall)
    const target = gameManager.currentUsers.find(u => u.username === data.username);
    if (target) require('../voice/gameVoice').endBlockedCall(io, socket.id, target.socketId);
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
        if (op === '$addToSet') {
            const refusal = await checkBlockTarget(usersCollection, user.username, targetUsername);
            if (refusal) {
                socket.emit('blockListUpdated', { success: false, message: refusal });
                return;
            }
        }
        // A block only while the list has room (an unblock always works);
        // a name already on the list is a no-op either way
        const filter = op === '$addToSet'
            ? { username: user.username, $or: [{ [`blockedUsers.${BLOCK_LIST_MAX - 1}`]: { $exists: false } }, { blockedUsers: targetUsername }] }
            : { username: user.username };
        const result = await usersCollection.updateOne(filter, { [op]: { blockedUsers: targetUsername } });
        if (op === '$addToSet' && result.matchedCount === 0) {
            socket.emit('blockListUpdated', { success: false, message: BLOCK_LIST_FULL });
            return;
        }
        const updated = await usersCollection.findOne(
            { username: user.username },
            { projection: { blockedUsers: 1 } }
        );

        // Voice signaling refuses blocked peers from now on (voiceHandlers)
        rememberBlockList(socket, updated?.blockedUsers || []);
        socket.emit('blockListUpdated', {
            success: true,
            blockedUsers: updated?.blockedUsers || []
        });
        socketLogger.info('Block list updated', {
            username: user.username, target: targetUsername, op
        });
        return true;
    } catch (error) {
        socketLogger.error('Failed to update block list', { error: error.message });
        socket.emit('blockListUpdated', { success: false, message: 'Failed to update block list. Try again.' });
    }
    return false;
}

/**
 * Why `target` cannot be blocked by `username`, or null: it must name an
 * account (any, a tombstone included: the name is still shown in old chat)
 * or a bot persona, and the list must have room.
 */
async function checkBlockTarget(usersCollection, username, target) {
    if (!isBotName(target)) {
        const exists = await usersCollection.findOne({ username: target }, { projection: { _id: 1 } });
        if (!exists) return 'No player by that name.';
    }
    const own = await usersCollection.findOne({ username }, { projection: { blockedUsers: 1 } });
    const list = own?.blockedUsers || [];
    if (!list.includes(target) && list.length >= BLOCK_LIST_MAX) return BLOCK_LIST_FULL;
    return null;
}

module.exports = {
    BLOCK_LIST_MAX,
    reportUser,
    blockUser,
    unblockUser
};
