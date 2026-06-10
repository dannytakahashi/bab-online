/**
 * Authentication socket event handlers
 */

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getUsersCollection, getGameRecordsCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');

async function signIn(socket, io, data) {
    const usersCollection = getUsersCollection();
    const { username, password } = data;

    try {
        const user = await usersCollection.findOne({ username });

        if (!user) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            authLogger.warn('Sign-in failed: user not found', { username });
            return;
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            authLogger.warn('Sign-in failed: incorrect password', { username });
            return;
        }

        // If user is already logged in, disconnect the old session
        if (user.socketId) {
            const oldSocket = io.sockets.sockets.get(user.socketId);
            if (oldSocket) {
                oldSocket.emit('forceLogout');
                gameManager.handleDisconnect(user.socketId);
                oldSocket.disconnect();
                authLogger.info('User logged out from another device', { username });
            }
        }

        // Generate a session token for reconnection
        const sessionToken = uuidv4();

        // Update MongoDB with the new socket ID and session token
        await usersCollection.updateOne(
            { username },
            { $set: { socketId: socket.id, sessionToken } }
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
            if (activeGameId) {
                await gameManager.clearActiveGame(username);
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
                    await gameManager.clearActiveTournament(username);
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
    const usersCollection = getUsersCollection();

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
        const existingUser = await usersCollection.findOne({ username });

        if (existingUser) {
            socket.emit('signUpResponse', {
                success: false,
                message: 'Username already taken!'
            });
            authLogger.warn('Sign-up failed: username taken', { username });
            return;
        }

        // Generate a session token for reconnection
        const sessionToken = uuidv4();

        const hashedPassword = await bcrypt.hash(password, 10);
        // Generate random profile pic (1-82)
        const profilePic = Math.floor(Math.random() * 82) + 1;
        await usersCollection.insertOne({
            username,
            password: hashedPassword,
            socketId: socket.id,  // Set socketId immediately for auto-login
            sessionToken,
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

        // The name now belongs to a fresh account — stop anonymizing it in
        // new game records (only relevant if a deleted name is re-registered)
        gameManager.deletedUsernames.delete(username);

        // Auto-login: register with game manager (same as signIn)
        gameManager.registerUser(socket.id, username);

        socket.emit('signUpResponse', { success: true, username, sessionToken, autoLoggedIn: true });
        authLogger.info('New user registered and auto-logged in', { username, socketId: socket.id });

    } catch (error) {
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
    const usersCollection = getUsersCollection();
    const { username, sessionToken } = data;

    try {
        // Find user and validate session token
        const user = await usersCollection.findOne({ username });

        if (!user) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: 'User not found'
            });
            authLogger.warn('Session restore failed: user not found', { username });
            return;
        }

        if (!user.sessionToken || user.sessionToken !== sessionToken) {
            socket.emit('restoreSessionResponse', {
                success: false,
                message: 'Invalid session token'
            });
            authLogger.warn('Session restore failed: invalid token', { username });
            return;
        }

        // Session token is valid - update socket ID
        await usersCollection.updateOne(
            { username },
            { $set: { socketId: socket.id } }
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
            if (activeGameId) {
                await gameManager.clearActiveGame(username);
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
                    await gameManager.clearActiveTournament(username);
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
        const user = await usersCollection.findOne({ username });
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
