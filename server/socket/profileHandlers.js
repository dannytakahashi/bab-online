/**
 * Profile socket event handlers
 * Handles fetching and updating user profiles
 */

const { getUsersCollection, getGameRecordsCollection } = require('../database');
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
                    draws: 0,
                    gamesPlayed: 0,
                    totalPoints: 0,
                    totalTricksBid: 0,
                    totalTricksTaken: 0,
                    totalHands: 0,
                    totalSets: 0,
                    totalSetPoints: 0,
                    totalFaults: 0,
                    totalHSI: 0
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
 * Record a completed game's results into the gameRecords collection
 * @param {Object} game - The completed game object
 */
async function recordGameResult(game) {
    const gameRecordsCollection = getGameRecordsCollection();
    if (!gameRecordsCollection) return;

    try {
        const team1Players = [game.getOriginalPlayer(1), game.getOriginalPlayer(3)]
            .filter(p => p && p.username)
            .map(p => p.username);
        const team2Players = [game.getOriginalPlayer(2), game.getOriginalPlayer(4)]
            .filter(p => p && p.username)
            .map(p => p.username);

        // Calculate team-level bags (total tricks taken minus total tricks bid)
        const ps = game.playerStats || {};
        const team1Bags = ((ps[1]?.totalTricks || 0) + (ps[3]?.totalTricks || 0))
            - ((ps[1]?.totalBids || 0) + (ps[3]?.totalBids || 0));
        const team2Bags = ((ps[2]?.totalTricks || 0) + (ps[4]?.totalTricks || 0))
            - ((ps[2]?.totalBids || 0) + (ps[4]?.totalBids || 0));

        await gameRecordsCollection.insertOne({
            gameId: game.gameId,
            team1Score: game.score.team1,
            team2Score: game.score.team2,
            team1Players,
            team2Players,
            team1Bags,
            team2Bags,
            completedAt: new Date()
        });

        authLogger.info('Game result recorded', { gameId: game.gameId });
    } catch (error) {
        authLogger.error('Error recording game result', { gameId: game.gameId, error: error.message });
    }
}

/**
 * Record game statistics for all players after a game ends
 * @param {Object} game - The completed game object
 * @param {boolean} team1Won - Whether team 1 won (positions 1 & 3)
 */
async function recordGameStats(game) {
    const usersCollection = getUsersCollection();

    // Skip stat recording if any player is a bot
    const hasBots = [1, 2, 3, 4].some(pos => game.isBot(game.positions[pos]));
    if (hasBots) {
        authLogger.info('Skipping stat recording — game contains bots', { gameId: game.gameId });
        return;
    }

    // Record the game result for records page
    await recordGameResult(game);

    // Determine winner based on final scores
    const team1Won = game.score.team1 > game.score.team2;
    const isTie = game.score.team1 === game.score.team2;

    // Get all players — use original human player info for resigned positions
    const players = [
        { position: 1, player: game.getOriginalPlayer(1) },
        { position: 2, player: game.getOriginalPlayer(2) },
        { position: 3, player: game.getOriginalPlayer(3) },
        { position: 4, player: game.getOriginalPlayer(4) }
    ];

    for (const { position, player } of players) {
        if (!player || !player.username) continue;

        // Skip bots (they don't have DB records)
        // But don't skip resigned positions — those have original human usernames
        if (!game.isResigned(position) && game.isBot(game.positions[position])) continue;

        const isTeam1 = position === 1 || position === 3;
        const isWinner = (isTeam1 && team1Won) || (!isTeam1 && !team1Won);
        const teamScore = isTeam1 ? game.score.team1 : game.score.team2;
        const totalHands = game.handStats.totalHands;

        // Use per-player stats for individual bids/tricks (accumulated across all hands)
        const playerStats = game.playerStats?.[position] || { totalBids: 0, totalTricks: 0, setsCaused: 0, totalHSI: 0 };
        const playerBids = playerStats.totalBids;
        const playerTricks = playerStats.totalTricks;
        const playerFaults = playerStats.setsCaused || 0;
        const playerHSI = playerStats.totalHSI || 0;
        // Total sets is team-based, not fault-based
        const teamSets = isTeam1 ? game.handStats.team1Sets : game.handStats.team2Sets;
        // Total set points (negative points lost to sets) - for "drag" stat
        const teamSetPoints = isTeam1 ? (game.handStats.team1SetPoints || 0) : (game.handStats.team2SetPoints || 0);

        try {
            await usersCollection.updateOne(
                { username: player.username },
                {
                    $inc: {
                        'stats.gamesPlayed': 1,
                        'stats.wins': isTie ? 0 : (isWinner ? 1 : 0),
                        'stats.losses': isTie ? 0 : (isWinner ? 0 : 1),
                        'stats.draws': isTie ? 1 : 0,
                        'stats.totalPoints': teamScore,
                        'stats.totalTricksBid': playerBids,
                        'stats.totalTricksTaken': playerTricks,
                        'stats.totalHands': totalHands,
                        'stats.totalSets': teamSets,
                        'stats.totalSetPoints': teamSetPoints,
                        'stats.totalFaults': playerFaults,
                        'stats.totalHSI': playerHSI
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
                sets: teamSets,
                setPoints: teamSetPoints,
                faults: playerFaults,
                hsi: playerHSI
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

/**
 * Get leaderboard data with computed stats for all players
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 */
async function getLeaderboard(socket, io) {
    const usersCollection = getUsersCollection();

    try {
        // Find all users with at least one game played
        const users = await usersCollection.find(
            { 'stats.gamesPlayed': { $gt: 0 } }
        ).toArray();

        // Compute derived stats and format response
        const leaderboard = users.map(user => {
            const stats = user.stats || {};
            const gamesPlayed = stats.gamesPlayed || 0;
            const wins = stats.wins || 0;
            const totalPoints = stats.totalPoints || 0;
            const totalTricksBid = stats.totalTricksBid || 0;
            const totalTricksTaken = stats.totalTricksTaken || 0;
            const totalHands = stats.totalHands || 0;
            const totalSets = stats.totalSets || 0;
            const totalSetPoints = stats.totalSetPoints || 0;
            const totalFaults = stats.totalFaults || 0;
            const totalHSI = stats.totalHSI || 0;

            return {
                username: user.username,
                profilePic: user.profilePic || 1,
                customProfilePic: user.customProfilePic || null,
                gamesPlayed,
                winRate: gamesPlayed > 0 ? (wins / gamesPlayed) * 100 : 0,
                pointsPerGame: gamesPlayed > 0 ? totalPoints / gamesPlayed : 0,
                bidsPerGame: gamesPlayed > 0 ? totalTricksBid / gamesPlayed : 0,
                tricksPerBid: totalTricksBid > 0 ? totalTricksTaken / totalTricksBid : 0,
                setRate: totalHands > 0 ? (totalSets / totalHands) * 100 : 0,
                drag: gamesPlayed > 0 ? totalSetPoints / gamesPlayed : 0,
                faultsPerGame: gamesPlayed > 0 ? totalFaults / gamesPlayed : 0,
                avgHSI: totalHands > 0 ? totalHSI / totalHands : 0
            };
        });

        // Compute population averages
        if (leaderboard.length > 0) {
            const n = leaderboard.length;
            const sum = (key) => leaderboard.reduce((acc, p) => acc + p[key], 0);
            leaderboard.push({
                username: 'Population',
                isPopulation: true,
                gamesPlayed: Math.round(sum('gamesPlayed') / n),
                winRate: sum('winRate') / n,
                pointsPerGame: sum('pointsPerGame') / n,
                bidsPerGame: sum('bidsPerGame') / n,
                tricksPerBid: sum('tricksPerBid') / n,
                setRate: sum('setRate') / n,
                drag: sum('drag') / n,
                faultsPerGame: sum('faultsPerGame') / n,
                avgHSI: sum('avgHSI') / n
            });
        }

        // Sort by win rate descending by default
        leaderboard.sort((a, b) => b.winRate - a.winRate);

        socket.emit('leaderboardResponse', {
            success: true,
            leaderboard
        });

        authLogger.debug('Leaderboard fetched', { playerCount: leaderboard.length });
    } catch (error) {
        authLogger.error('Error fetching leaderboard', { error: error.message });
        socket.emit('leaderboardResponse', {
            success: false,
            message: 'Database error'
        });
    }
}

/**
 * Search for players by username
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} data - Contains query string
 */
async function searchPlayers(socket, io, data) {
    const usersCollection = getUsersCollection();

    const { query } = data || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
        socket.emit('searchPlayersResponse', {
            success: false,
            message: 'Search query is required'
        });
        return;
    }

    try {
        // Escape regex special characters
        const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const users = await usersCollection.find(
            { username: { $regex: escaped, $options: 'i' } },
            { projection: { username: 1, profilePic: 1, customProfilePic: 1, stats: 1 } }
        ).limit(20).toArray();

        const players = users.map(u => ({
            username: u.username,
            profilePic: u.profilePic || 1,
            customProfilePic: u.customProfilePic || null,
            gamesPlayed: u.stats?.gamesPlayed || 0,
            wins: u.stats?.wins || 0
        }));

        socket.emit('searchPlayersResponse', { success: true, players });
        authLogger.debug('Player search', { query: query.trim(), resultCount: players.length });
    } catch (error) {
        authLogger.error('Error searching players', { query, error: error.message });
        socket.emit('searchPlayersResponse', { success: false, message: 'Database error' });
    }
}

/**
 * Get another player's profile by username
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} data - Contains username string
 */
async function getPlayerProfile(socket, io, data) {
    const usersCollection = getUsersCollection();

    const { username } = data || {};
    if (!username || typeof username !== 'string' || !username.trim()) {
        socket.emit('playerProfileResponse', {
            success: false,
            message: 'Username is required'
        });
        return;
    }

    try {
        const dbUser = await usersCollection.findOne({ username: username.trim() });

        if (!dbUser) {
            socket.emit('playerProfileResponse', {
                success: false,
                message: 'Player not found'
            });
            return;
        }

        socket.emit('playerProfileResponse', {
            success: true,
            profile: {
                username: dbUser.username,
                profilePic: dbUser.profilePic || 1,
                customProfilePic: dbUser.customProfilePic || null,
                stats: dbUser.stats || {
                    wins: 0,
                    losses: 0,
                    draws: 0,
                    gamesPlayed: 0,
                    totalPoints: 0,
                    totalTricksBid: 0,
                    totalTricksTaken: 0,
                    totalHands: 0,
                    totalSets: 0,
                    totalSetPoints: 0,
                    totalFaults: 0,
                    totalHSI: 0
                }
            }
        });

        authLogger.debug('Player profile fetched', { username: username.trim() });
    } catch (error) {
        authLogger.error('Error fetching player profile', { username, error: error.message });
        socket.emit('playerProfileResponse', { success: false, message: 'Database error' });
    }
}

/**
 * Get game records (highest score, lowest score, biggest win) for 3 time periods
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 */
async function getRecords(socket, io) {
    const gameRecordsCollection = getGameRecordsCollection();

    if (!gameRecordsCollection) {
        socket.emit('recordsResponse', { success: false, message: 'Database not available' });
        return;
    }

    try {
        const now = new Date();
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const filters = {
            allTime: {},
            thisYear: { completedAt: { $gte: startOfYear } },
            thisMonth: { completedAt: { $gte: startOfMonth } }
        };

        const records = {};

        for (const [period, filter] of Object.entries(filters)) {
            const games = await gameRecordsCollection.find(filter).toArray();

            if (games.length === 0) {
                records[period] = null;
                continue;
            }

            let highestScore = null;
            let lowestScore = null;
            let biggestWin = null;
            let mostBags = null;
            let leastBags = null;

            for (const game of games) {
                // Check both teams for highest/lowest individual team score
                const entries = [
                    { score: game.team1Score, players: game.team1Players },
                    { score: game.team2Score, players: game.team2Players }
                ];

                for (const entry of entries) {
                    if (!highestScore || entry.score > highestScore.score) {
                        highestScore = { score: entry.score, players: entry.players };
                    }
                    if (!lowestScore || entry.score < lowestScore.score) {
                        lowestScore = { score: entry.score, players: entry.players };
                    }
                }

                // Biggest win margin
                const margin = Math.abs(game.team1Score - game.team2Score);
                if (!biggestWin || margin > biggestWin.margin) {
                    const winnerIsTeam1 = game.team1Score > game.team2Score;
                    biggestWin = {
                        margin,
                        winnerScore: winnerIsTeam1 ? game.team1Score : game.team2Score,
                        loserScore: winnerIsTeam1 ? game.team2Score : game.team1Score,
                        winnerPlayers: winnerIsTeam1 ? game.team1Players : game.team2Players,
                        loserPlayers: winnerIsTeam1 ? game.team2Players : game.team1Players
                    };
                }

                // Most/least bags — skip legacy records without bags data
                if (game.team1Bags != null && game.team2Bags != null) {
                    const bagsEntries = [
                        { bags: game.team1Bags, players: game.team1Players },
                        { bags: game.team2Bags, players: game.team2Players }
                    ];

                    for (const entry of bagsEntries) {
                        if (!mostBags || entry.bags > mostBags.bags) {
                            mostBags = { bags: entry.bags, players: entry.players };
                        }
                        if (!leastBags || entry.bags < leastBags.bags) {
                            leastBags = { bags: entry.bags, players: entry.players };
                        }
                    }
                }
            }

            records[period] = { highestScore, lowestScore, biggestWin, mostBags, leastBags };
        }

        // Total games played (all time count)
        const totalGames = (await gameRecordsCollection.countDocuments({}));

        socket.emit('recordsResponse', { success: true, records, totalGames });
        authLogger.debug('Records fetched');
    } catch (error) {
        authLogger.error('Error fetching records', { error: error.message });
        socket.emit('recordsResponse', { success: false, message: 'Database error' });
    }
}

module.exports = {
    getProfile,
    updateProfilePic,
    uploadProfilePic,
    recordGameStats,
    getUserProfilePic,
    getLeaderboard,
    searchPlayers,
    getPlayerProfile,
    getRecords
};
