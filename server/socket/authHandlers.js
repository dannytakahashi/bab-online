/**
 * Authentication socket event handlers
 */

const bcrypt = require('bcryptjs');
const { getUsersCollection } = require('../database');
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

        // Update MongoDB with the new socket ID
        await usersCollection.updateOne(
            { username },
            { $set: { socketId: socket.id } }
        );

        // Register with game manager
        gameManager.registerUser(socket.id, username);

        // Check if user has an active game they can rejoin
        const activeGameId = user.activeGameId;
        const activeGame = activeGameId ? gameManager.getGameById(activeGameId) : null;

        if (activeGame) {
            // User has an active game - notify client
            socket.emit('signInResponse', {
                success: true,
                username,
                activeGameId: activeGameId
            });
            authLogger.info('User signed in with active game', { username, socketId: socket.id, gameId: activeGameId });
        } else {
            // No active game (or game no longer exists) - clear stale activeGameId if present
            if (activeGameId) {
                await gameManager.clearActiveGame(username);
            }
            socket.emit('signInResponse', { success: true, username });
            authLogger.info('User signed in', { username, socketId: socket.id });
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

        const hashedPassword = await bcrypt.hash(password, 10);
        // Generate random profile pic (1-82)
        const profilePic = Math.floor(Math.random() * 82) + 1;
        await usersCollection.insertOne({
            username,
            password: hashedPassword,
            socketId: socket.id,  // Set socketId immediately for auto-login
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

        // Auto-login: register with game manager (same as signIn)
        gameManager.registerUser(socket.id, username);

        socket.emit('signUpResponse', { success: true, username, autoLoggedIn: true });
        authLogger.info('New user registered and auto-logged in', { username, socketId: socket.id });

    } catch (error) {
        authLogger.error('Database error during sign-up', { username, error: error.message });
        socket.emit('signUpResponse', {
            success: false,
            message: 'Database error. Try again.'
        });
    }
}

module.exports = {
    signIn,
    signUp
};
