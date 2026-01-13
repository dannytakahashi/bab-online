/**
 * Authentication socket event handlers
 */

const bcrypt = require('bcryptjs');
const { getUsersCollection } = require('../database');
const gameManager = require('../game/GameManager');

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
            console.log(`❌ Sign-in failed: User ${username} not found.`);
            return;
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            socket.emit('signInResponse', {
                success: false,
                message: 'Invalid username or password!'
            });
            console.log(`❌ Sign-in failed: Incorrect password for ${username}`);
            return;
        }

        // If user is already logged in, disconnect the old session
        if (user.socketId) {
            const oldSocket = io.sockets.sockets.get(user.socketId);
            if (oldSocket) {
                oldSocket.emit('forceLogout');
                gameManager.handleDisconnect(user.socketId);
                oldSocket.disconnect();
                console.log(`🔄 ${username} was logged out from another device.`);
            }
        }

        // Update MongoDB with the new socket ID
        await usersCollection.updateOne(
            { username },
            { $set: { socketId: socket.id } }
        );

        // Register with game manager
        gameManager.registerUser(socket.id, username);

        socket.emit('signInResponse', { success: true, username });
        console.log(`✅ ${username} signed in successfully.`);

    } catch (error) {
        console.error('❌ Database error:', error);
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
        return console.error('❌ Database error: usersCollection is undefined.');
    }

    const { username, password } = data;

    try {
        const existingUser = await usersCollection.findOne({ username });

        if (existingUser) {
            socket.emit('signUpResponse', {
                success: false,
                message: 'Username already taken!'
            });
            return console.log(`❌ Sign-up failed: Username "${username}" is already in use.`);
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await usersCollection.insertOne({ username, password: hashedPassword });

        socket.emit('signUpResponse', { success: true });
        console.log(`✅ New user registered: ${username}`);

    } catch (error) {
        console.error('❌ Database error:', error);
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
