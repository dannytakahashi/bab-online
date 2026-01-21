/**
 * Profile socket event handlers
 * Handles fetching and updating user profiles
 */

const { getUsersCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');

/**
 * Get user profile with stats
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 */
async function getProfile(socket, io) {
    const usersCollection = getUsersCollection();
    const user = gameManager.getUserBySocketId(socket.id);

    if (!user) {
        socket.emit('profileResponse', {
            success: false,
            message: 'User not found'
        });
        authLogger.warn('getProfile: User not found for socket', { socketId: socket.id });
        return;
    }

    try {
        const dbUser = await usersCollection.findOne({ username: user.username });

        if (!dbUser) {
            socket.emit('profileResponse', {
                success: false,
                message: 'User not found in database'
            });
            authLogger.warn('getProfile: User not found in database', { username: user.username });
            return;
        }

        // Return profile data with stats
        socket.emit('profileResponse', {
            success: true,
            profile: {
                username: dbUser.username,
                profilePic: dbUser.profilePic || 1,
                customProfilePic: dbUser.customProfilePic || null,
                stats: dbUser.stats || {
                    wins: 0,
                    losses: 0,
                    gamesPlayed: 0,
                    totalPoints: 0,
                    totalTricksBid: 0,
                    totalTricksTaken: 0,
                    totalHands: 0,
                    totalSets: 0
                }
            }
        });

        authLogger.debug('Profile fetched', { username: user.username });
    } catch (error) {
        authLogger.error('Error fetching profile', { username: user.username, error: error.message });
        socket.emit('profileResponse', {
            success: false,
            message: 'Database error'
        });
    }
}

/**
 * Update user's profile picture
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} data - Contains profilePic number
 */
async function updateProfilePic(socket, io, data) {
    const usersCollection = getUsersCollection();
    const user = gameManager.getUserBySocketId(socket.id);

    if (!user) {
        socket.emit('profilePicUpdateResponse', {
            success: false,
            message: 'User not found'
        });
        authLogger.warn('updateProfilePic: User not found for socket', { socketId: socket.id });
        return;
    }

    const { profilePic } = data;

    // Validate profilePic range (1-82)
    if (!profilePic || profilePic < 1 || profilePic > 82) {
        socket.emit('profilePicUpdateResponse', {
            success: false,
            message: 'Invalid profile picture number (must be 1-82)'
        });
        return;
    }

    try {
        await usersCollection.updateOne(
            { username: user.username },
            { $set: { profilePic: profilePic } }
        );

        socket.emit('profilePicUpdateResponse', {
            success: true,
            profilePic: profilePic
        });

        authLogger.info('Profile picture updated', { username: user.username, profilePic });
    } catch (error) {
        authLogger.error('Error updating profile picture', { username: user.username, error: error.message });
        socket.emit('profilePicUpdateResponse', {
            success: false,
            message: 'Database error'
        });
    }
}

/**
 * Upload custom profile picture (base64)
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} data - Contains imageData (base64 string)
 */
async function uploadProfilePic(socket, io, data) {
    const usersCollection = getUsersCollection();
    const user = gameManager.getUserBySocketId(socket.id);

    if (!user) {
        socket.emit('profilePicUploadResponse', {
            success: false,
            message: 'User not found'
        });
        authLogger.warn('uploadProfilePic: User not found for socket', { socketId: socket.id });
        return;
    }

    const { imageData } = data;

    // Validate base64 image
    if (!imageData || typeof imageData !== 'string') {
        socket.emit('profilePicUploadResponse', {
            success: false,
            message: 'Invalid image data'
        });
        return;
    }

    // Check if it's a valid base64 image (data:image/...;base64,...)
    const base64Regex = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/;
    if (!base64Regex.test(imageData)) {
        socket.emit('profilePicUploadResponse', {
            success: false,
            message: 'Invalid image format. Use PNG, JPEG, GIF, or WebP.'
        });
        return;
    }

    // Check size (roughly 500KB limit - base64 is ~1.37x larger than binary)
    const sizeInBytes = (imageData.length * 3) / 4;
    const maxSize = 500 * 1024; // 500KB
    if (sizeInBytes > maxSize) {
        socket.emit('profilePicUploadResponse', {
            success: false,
            message: 'Image too large. Maximum size is 500KB.'
        });
        return;
    }

    try {
        await usersCollection.updateOne(
            { username: user.username },
            { $set: { customProfilePic: imageData } }
        );

        socket.emit('profilePicUploadResponse', {
            success: true,
            customProfilePic: imageData
        });

        authLogger.info('Custom profile picture uploaded', { username: user.username });
    } catch (error) {
        authLogger.error('Error uploading profile picture', { username: user.username, error: error.message });
        socket.emit('profilePicUploadResponse', {
            success: false,
            message: 'Database error'
        });
    }
}

/**
 * Record game statistics for all players after a game ends
 * @param {Object} game - The completed game object
 * @param {boolean} team1Won - Whether team 1 won (positions 1 & 3)
 */
async function recordGameStats(game) {
    const usersCollection = getUsersCollection();

    // Determine winner based on final scores
    const team1Won = game.score.team1 > game.score.team2;

    // Get all players
    const players = [
        { position: 1, player: game.getPlayerByPosition(1) },
        { position: 2, player: game.getPlayerByPosition(2) },
        { position: 3, player: game.getPlayerByPosition(3) },
        { position: 4, player: game.getPlayerByPosition(4) }
    ];

    for (const { position, player } of players) {
        if (!player || !player.username) continue;

        const isTeam1 = position === 1 || position === 3;
        const isWinner = (isTeam1 && team1Won) || (!isTeam1 && !team1Won);
        const teamScore = isTeam1 ? game.score.team1 : game.score.team2;
        const totalHands = game.handStats.totalHands;

        // Use per-player stats for individual bids/tricks (accumulated across all hands)
        const playerStats = game.playerStats?.[position] || { totalBids: 0, totalTricks: 0, setsCaused: 0 };
        const playerBids = playerStats.totalBids;
        const playerTricks = playerStats.totalTricks;
        const playerSets = playerStats.setsCaused;

        try {
            await usersCollection.updateOne(
                { username: player.username },
                {
                    $inc: {
                        'stats.gamesPlayed': 1,
                        'stats.wins': isWinner ? 1 : 0,
                        'stats.losses': isWinner ? 0 : 1,
                        'stats.totalPoints': teamScore,
                        'stats.totalTricksBid': playerBids,
                        'stats.totalTricksTaken': playerTricks,
                        'stats.totalHands': totalHands,
                        'stats.totalSets': playerSets
                    }
                }
            );

            authLogger.info('Game stats recorded', {
                username: player.username,
                won: isWinner,
                score: teamScore,
                tricks: playerTricks,
                bids: playerBids,
                hands: totalHands,
                sets: playerSets
            });
        } catch (error) {
            authLogger.error('Error recording game stats', {
                username: player.username,
                error: error.message
            });
        }
    }
}

/**
 * Get user's saved profile pic from database
 * @param {string} username - Username to look up
 * @returns {Promise<number>} Profile pic number (1-82) or random if not set
 */
async function getUserProfilePic(username) {
    const usersCollection = getUsersCollection();

    if (!username) {
        authLogger.warn('getUserProfilePic called with no username, returning random pic');
        return Math.floor(Math.random() * 82) + 1;
    }

    try {
        const user = await usersCollection.findOne({ username }, { projection: { profilePic: 1, customProfilePic: 1 } });
        authLogger.debug('getUserProfilePic lookup', {
            username,
            found: !!user,
            profilePic: user?.profilePic,
            hasCustomPic: !!user?.customProfilePic
        });

        // Return custom profile pic (base64 string) if set
        if (user && user.customProfilePic) {
            return user.customProfilePic;
        }

        // Return numbered profile pic if set
        if (user && user.profilePic) {
            return user.profilePic;
        }
    } catch (error) {
        authLogger.error('Error fetching user profile pic', { username, error: error.message });
    }

    // Return random if not set or error
    authLogger.warn('getUserProfilePic: No profilePic found for user, returning random', { username });
    return Math.floor(Math.random() * 82) + 1;
}

module.exports = {
    getProfile,
    updateProfilePic,
    uploadProfilePic,
    recordGameStats,
    getUserProfilePic
};
