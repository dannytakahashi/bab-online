/**
 * Authentication socket event handlers
 */

const bcrypt = require('bcryptjs');
const { getUsersCollection, getGameRecordsCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');
const { issueSession, verifySession } = require('../utils/sessionTokens');

/**
 * Accounts merged by scripts/merge-accounts.js stay behind as tombstones
 * ({ username, mergedInto }). Tell the player which account to use instead
 * of a generic "wrong password", since they likely forgot which one is theirs.
 */
function mergedAccountMessage(username, mergedInto) {
    return `"${username}" was combined into your account "${mergedInto}". Please sign in as ${mergedInto}.`;
}

/**
 * One live connection per user: kick the previous socket (another device or
 * tab) so a game never has two sockets for the same player.
 */
function disconnectPreviousSocket(io, previousSocketId, currentSocketId, username) {
    if (!previousSocketId || previousSocketId === currentSocketId) return;
    const oldSocket = io.sockets.sockets.get(previousSocketId);
    if (!oldSocket) return;
    oldSocket.emit('forceLogout');
    gameManager.handleDisconnect(previousSocketId);
    oldSocket.disconnect();
    authLogger.info('User logged out from another device', { username });
}

/**
 * signIn/restoreSession read everything on the user document except the
 * big or unused fields: the custom picture (up to ~500 KB base64), stats
 * and the merge audit log. Exclusion keeps password, mergedInto, socketId,
 * sessionTokens, the legacy sessionToken, activeGameId, activeTournamentId
 * and blockedUsers.
 */
const SIGN_IN_PROJECTION = { customProfilePic: 0, stats: 0, mergedFrom: 0 };
const RESTORE_PROJECTION = { ...SIGN_IN_PROJECTION, password: 0 };

/**
 * The users collection, waiting up to 10 s on a cold start: connectDB runs
 * after listen(), and a reconnect storm right after a deploy must not get
 * 'Database error' (a failed restoreSession makes both clients forget their
 * saved token). Still missing after the wait: the caller's usual reply.
 * whenReady is optional so test mocks of ../database without it still work.
 */
async function usersCollectionWhenReady() {
    let usersCollection = getUsersCollection();
    if (!usersCollection) {
        await require('../database').whenReady?.(10000);
        usersCollection = getUsersCollection();
    }
    return usersCollection;
}

async function signIn(socket, io, data) {
    const usersCollection = await usersCollectionWhenReady();
    const { username, password } = data;

    try {
        const user = await usersCollection.findOne({ username }, { projection: SIGN_IN_PROJECTION });

        if (!user) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            authLogger.warn('Sign-in failed: user not found', { username });
            return;
        }

        if (user.mergedInto) {
            socket.emit('signInResponse', {
                success: false,
                message: mergedAccountMessage(username, user.mergedInto)
            });
            authLogger.info('Sign-in to merged account redirected', { username, mergedInto: user.mergedInto });
            return;
        }

        // No password hash (a malformed legacy document): a normal failure,
        // not a throw inside compare
        const passwordMatch = typeof user.password === 'string'
            && await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            authLogger.warn('Sign-in failed: incorrect password', { username });
            return;
        }

        // If user is already logged in, disconnect the old session
        disconnectPreviousSocket(io, user.socketId, socket.id, username);

        // New per-device session token; other devices' tokens stay valid
        const session = issueSession(user);
        const sessionToken = session.token;
        socket.data.sessionHash = session.hash;

        await usersCollection.updateOne(
            { username },
            {
                $set: { socketId: socket.id, ...session.update.$set },
                $unset: session.update.$unset
            }
        );

        // Register with game manager
        gameManager.registerUser(socket.id, username);

        // Check if user has an active game they can rejoin
        const activeGameId = user.activeGameId;
        const activeGame = activeGameId ? gameManager.getGameById(activeGameId) : null;

        const blockedUsers = user.blockedUsers || [];

        if (activeGame) {
            // User has an active game - notify client
            socket.emit('signInResponse', {
                success: true,
                username,
                sessionToken,
                activeGameId: activeGameId,
                blockedUsers
            });
            authLogger.info('User signed in with active game', { username, socketId: socket.id, gameId: activeGameId });
        } else {
            // No active game (or game no longer exists) - clear stale activeGameId if present
            // Scoped to the stale id: a game that starts meanwhile and
            // writes a new pointer must keep it
            if (activeGameId) {
                await gameManager.clearActiveGame(username, activeGameId);
            }

            // Check for active tournament
            const activeTournamentId = user.activeTournamentId;
            const activeTournament = activeTournamentId ? gameManager.getTournamentById(activeTournamentId) : null;

            if (activeTournament) {
                socket.emit('signInResponse', {
                    success: true,
                    username,
                    sessionToken,
                    activeTournamentId,
                    blockedUsers
                });
                authLogger.info('User signed in with active tournament', { username, socketId: socket.id, tournamentId: activeTournamentId });
            } else {
                if (activeTournamentId) {
                    await gameManager.clearActiveTournament(username, activeTournamentId);
                }
                socket.emit('signInResponse', { success: true, username, sessionToken, blockedUsers });
                authLogger.info('User signed in', { username, socketId: socket.id });
            }
        }

    } catch (error) {
        authLogger.error('Database error during sign-in', { username, error: error.message });
        socket.emit('signInResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    }
}

async function signUp(socket, io, data) {
    const usersCollection = await usersCollectionWhenReady();

    if (!usersCollection) {
        socket.emit('signUpResponse', {
            success: false,
            message: 'Database not ready. Try again.'
        });
        authLogger.error('Database not ready: usersCollection is undefined');
        return;
    }

    const { username, password } = data;

    // Substring matching for usernames — embedded slurs in handles like
    // "xX_slur_Xx" must be rejected, not just standalone words
    const { containsProfanitySubstring } = require('../utils/profanityFilter');
    if (containsProfanitySubstring(username)) {
        socket.emit('signUpResponse', {
            success: false,
            message: 'That username is not allowed.'
        });
        authLogger.warn('Sign-up failed: username rejected by filter', { username });
        return;
    }

    try {
        const existingUser = await usersCollection.findOne({ username }, { projection: { mergedInto: 1 } });

        if (existingUser) {
            socket.emit('signUpResponse', {
                success: false,
                message: existingUser.mergedInto
                    ? mergedAccountMessage(username, existingUser.mergedInto)
                    : 'Username already taken!'
            });
            authLogger.warn('Sign-up failed: username taken', { username });
            return;
        }

        // Session token for reconnection (this device's first session)
        const session = issueSession(null);
        const sessionToken = session.token;

        const hashedPassword = await bcrypt.hash(password, 10);
        // Generate random profile pic (1-82)
        const profilePic = Math.floor(Math.random() * 82) + 1;
        await usersCollection.insertOne({
            username,
            password: hashedPassword,
            socketId: socket.id,  // Set socketId immediately for auto-login
            sessionTokens: session.update.$set.sessionTokens,
            profilePic,
            stats: {
                wins: 0,
                losses: 0,
                gamesPlayed: 0,
                totalPoints: 0,
                totalTricksBid: 0,
                totalTricksTaken: 0
            }
        });
        socket.data.sessionHash = session.hash;

        // The name now belongs to a fresh account — stop anonymizing it in
        // new game records (only relevant if a deleted name is re-registered)
        gameManager.deletedUsernames.delete(username);

        // Auto-login: register with game manager (same as signIn)
        gameManager.registerUser(socket.id, username);

        socket.emit('signUpResponse', { success: true, username, sessionToken, autoLoggedIn: true });
        authLogger.info('New user registered and auto-logged in', { username, socketId: socket.id });

    } catch (error) {
        // Lost a race with a concurrent sign-up for the same name: the unique
        // index on users.username rejects the second insert
        if (error && error.code === 11000) {
            socket.emit('signUpResponse', { success: false, message: 'Username already taken!' });
            authLogger.warn('Sign-up failed: username taken (duplicate key)', { username });
            return;
        }
        authLogger.error('Database error during sign-up', { username, error: error.message });
        socket.emit('signUpResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    }
}

/**
 * Restore session after page refresh using session token
 */
async function restoreSession(socket, io, data) {
    const usersCollection = await usersCollectionWhenReady();
    const { username, sessionToken } = data;

    try {
        // Find user and validate session token
        const user = await usersCollection.findOne({ username }, { projection: RESTORE_PROJECTION });

        if (!user) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: 'User not found'
            });
            authLogger.warn('Session restore failed: user not found', { username });
            return;
        }

        if (user.mergedInto) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: mergedAccountMessage(username, user.mergedInto)
            });
            return;
        }

        const session = verifySession(user, sessionToken);
        if (!session) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: 'Invalid session token'
            });
            authLogger.warn('Session restore failed: invalid token', { username });
            return;
        }

        // A different device resuming its saved session takes over the one
        // live connection. The same device reconnecting (same token, e.g. a
        // network blip or page refresh) is left to the normal disconnect flow.
        const previousSocket = user.socketId ? io.sockets.sockets.get(user.socketId) : null;
        if (previousSocket && previousSocket.data?.sessionHash !== session.hash) {
            disconnectPreviousSocket(io, user.socketId, socket.id, username);
        }
        socket.data.sessionHash = session.hash;

        // Session token is valid - update socket ID and session last-used time
        await usersCollection.updateOne(
            { username },
            {
                $set: { socketId: socket.id, ...session.update.$set },
                $unset: session.update.$unset
            }
        );

        // Register with game manager
        gameManager.registerUser(socket.id, username);

        // Check if user has an active game they can rejoin
        const activeGameId = user.activeGameId;
        const activeGame = activeGameId ? gameManager.getGameById(activeGameId) : null;
        const blockedUsers = user.blockedUsers || [];

        if (activeGame) {
            socket.emit('restoreSessionResponse', {
                success: true,
                username,
                activeGameId: activeGameId,
                blockedUsers
            });
            authLogger.info('Session restored with active game', { username, socketId: socket.id, gameId: activeGameId });
        } else {
            // Clear stale activeGameId if present
            // Scoped to the stale id: a game that starts meanwhile and
            // writes a new pointer must keep it
            if (activeGameId) {
                await gameManager.clearActiveGame(username, activeGameId);
            }

            // Check for active tournament
            const activeTournamentId = user.activeTournamentId;
            const activeTournament = activeTournamentId ? gameManager.getTournamentById(activeTournamentId) : null;

            if (activeTournament) {
                socket.emit('restoreSessionResponse', {
                    success: true,
                    username,
                    activeTournamentId,
                    blockedUsers
                });
                authLogger.info('Session restored with active tournament', { username, socketId: socket.id, tournamentId: activeTournamentId });
            } else {
                if (activeTournamentId) {
                    await gameManager.clearActiveTournament(username, activeTournamentId);
                }
                socket.emit('restoreSessionResponse', { success: true, username, blockedUsers });
                authLogger.info('Session restored', { username, socketId: socket.id });
            }
        }

    } catch (error) {
        authLogger.error('Database error during session restore', { username, error: error.message });
        socket.emit('restoreSessionResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    }
}

/**
 * Permanently delete the signed-in user's account (App Store Guideline
 * 5.1.1(v) requires in-app deletion). Requires password re-confirmation.
 * Removes the user document and anonymizes the username in historical game
 * records, which are shared documents describing other players' games too.
 */
async function deleteAccount(socket, io, data) {
    const usersCollection = getUsersCollection();
    const { password } = data;

    if (!usersCollection) {
        socket.emit('deleteAccountResponse', {
            success: false,
            message: 'Database not ready. Try again.'
        });
        return;
    }

    // Only the authenticated session may delete its own account — never
    // accept a client-supplied username here
    const sessionUser = gameManager.getUserBySocketId(socket.id);
    if (!sessionUser) {
        socket.emit('deleteAccountResponse', {
            success: false,
            message: 'Not signed in'
        });
        return;
    }
    const username = sessionUser.username;

    try {
        const user = await usersCollection.findOne({ username }, { projection: { password: 1, socketId: 1 } });
        if (!user) {
            socket.emit('deleteAccountResponse', {
                success: false,
                message: 'Account not found'
            });
            return;
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            socket.emit('deleteAccountResponse', {
                success: false,
                message: 'Incorrect password'
            });
            authLogger.warn('Account deletion failed: incorrect password', { username });
            return;
        }

        const gameRecords = getGameRecordsCollection();
        if (gameRecords) {
            await gameRecords.updateMany(
                { team1Players: username },
                { $set: { 'team1Players.$[p]': '[deleted]' } },
                { arrayFilters: [{ p: username }] }
            );
            await gameRecords.updateMany(
                { team2Players: username },
                { $set: { 'team2Players.$[p]': '[deleted]' } },
                { arrayFilters: [{ p: username }] }
            );
        }

        // Removes password hash, session token, stats (and with them the
        // leaderboard entry), profile pictures, and active game/tournament
        // pointers in one shot — everything else is keyed by this document
        await usersCollection.deleteOne({ username });

        // Old accounts merged into this one only reserve their names; remove
        // them too so nothing tied to this person remains
        await usersCollection.deleteMany({ mergedInto: username });

        // Keep an in-flight game from re-inserting this username into a new
        // game record after the anonymization above
        gameManager.deletedUsernames.add(username);

        // Force-logout any other device signed into this account
        if (user.socketId && user.socketId !== socket.id) {
            const otherSocket = io.sockets.sockets.get(user.socketId);
            if (otherSocket) {
                otherSocket.emit('forceLogout');
                otherSocket.disconnect();
            }
        }

        socket.emit('deleteAccountResponse', { success: true });
        authLogger.info('Account deleted', { username, socketId: socket.id });

        // Disconnect after the response flushes; the normal disconnect flow
        // cleans up any lobby/queue/game/tournament state
        setTimeout(() => socket.disconnect(true), 500);

    } catch (error) {
        authLogger.error('Database error during account deletion', { username, error: error.message });
        socket.emit('deleteAccountResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    }
}

module.exports = {
    signIn,
    signUp,
    restoreSession,
    deleteAccount
};
