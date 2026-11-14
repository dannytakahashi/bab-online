/**
 * Profile socket event handlers
 * Handles fetching and updating user profiles
 */

const { getUsersCollection, getGameRecordsCollection } = require('../database');
const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');
const { createCache } = require('../utils/ttlCache');
const rateLimiter = require('./rateLimiter');
const avatarStore = require('../avatar/avatarStore');
const avatarWire = require('../avatar/avatarWire');
const image = require('../avatar/image');
const { SCOPES, emptyStats, pickStats, sumBuckets, normalizeScope } = require('../utils/statsScope');

// Leaderboard and records pages: 60 s caches, one per stats scope
// (server/utils/statsScope.js: human | bots | all), invalidated (every scope
// at once) on every write this process makes that changes them
// (recordGameStats, deleteAccount, profile picture changes, admin merge and
// rename). The owner CLIs (merge-accounts, set-password) run in another
// process: only the TTL covers them.
const CACHE_TTL_MS = 60000;
const leaderboardCache = Object.fromEntries(SCOPES.map(s => [s, createCache({ ttlMs: CACHE_TTL_MS })]));
const recordsCache = Object.fromEntries(SCOPES.map(s => [s, createCache({ ttlMs: CACHE_TTL_MS })]));
let recordsCacheKey = null;

/** Longest possible username (validators.js): a longer query matches nobody. */
const MAX_USERNAME_LENGTH = 50;

/** Fields a profile reply is built from (plus mergedInto / renamedAt / targetRenamedAt for the redirect). */
const PROFILE_PROJECTION = { username: 1, profilePic: 1, customProfilePic: 1, stats: 1, mergedInto: 1, renamedAt: 1, targetRenamedAt: 1 };
/** The same plus the bot-game bucket (scopes bots / all). */
const PROFILE_PROJECTION_WITH_BOTS = { ...PROFILE_PROJECTION, botStats: 1 };
const profileProjection = (scope) => (scope === 'human' ? PROFILE_PROJECTION : PROFILE_PROJECTION_WITH_BOTS);

/**
 * Get user profile with stats
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} [data] - optional {scope: 'human'|'bots'|'all'} (statsScope.js)
 */
async function getProfile(socket, io, data) {
    const { scope, echo } = normalizeScope(data);
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
        const dbUser = await usersCollection.findOne({ username: user.username }, { projection: profileProjection(scope) });

        if (!dbUser) {
            socket.emit('profileResponse', {
                success: false,
                message: 'User not found in database'
            });
            authLogger.warn('getProfile: User not found in database', { username: user.username });
            return;
        }

        // Return profile data with stats (custom picture per recipient:
        // docs/avatars.md)
        socket.emit('profileResponse', await profileReply(socket, dbUser, scope, echo));

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
        avatarStore.forgetUser(user.username);
        invalidateLeaderboard();

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
/** Usernames whose upload is being decoded (one at a time per account). */
const uploadsInFlight = new Set();

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

    // Pipeline on: only images we can decode safely are accepted, and what
    // is stored is our canonical rendition (WebP <= 256 px, metadata
    // stripped; a data URL the App Store iOS build decodes too). Existing
    // documents are never rewritten (docs/avatars.md). Off: today's bytes.
    let stored = imageData;
    let rendition = null;
    if (avatarStore.available()) {
        // One decode per account at a time, under avatarStore's shared
        // semaphore (at most 2 decodes process-wide; docs/avatars.md)
        if (uploadsInFlight.has(user.username)) {
            socket.emit('profilePicUploadResponse', { success: false, message: 'Busy, try again' });
            return;
        }
        const buf = image.parseDataUrl(imageData);
        let r = { status: 'undecodable' };
        if (buf) {
            uploadsInFlight.add(user.username);
            try {
                r = await avatarStore.deriveUpload(buf);
            } finally {
                uploadsInFlight.delete(user.username);
            }
        }
        if (r.status === 'busy' || r.status === 'error') {
            authLogger.warn('Custom profile picture not processed (busy)', { username: user.username, status: r.status });
            socket.emit('profilePicUploadResponse', { success: false, message: 'Busy, try again' });
            return;
        }
        if (r.status !== 'ok') {
            authLogger.warn('Custom profile picture refused', { username: user.username, status: r.status, reason: r.reason });
            socket.emit('profilePicUploadResponse', {
                success: false,
                message: 'Could not read that image. Please try a PNG, JPEG, GIF or WebP.'
            });
            return;
        }
        rendition = r.webp;
        stored = image.toInline(r.webp);
    }

    try {
        await usersCollection.updateOne(
            { username: user.username },
            { $set: { customProfilePic: stored } }
        );
        avatarStore.forgetUser(user.username);
        invalidateLeaderboard();

        const reply = { success: true, customProfilePic: stored };
        const v = rendition ? avatarStore.seed(user.username, stored, rendition) : null;
        if (v) reply.avatarUrl = avatarWire.avatarPath(user.username, v); // additive
        socket.emit('profilePicUploadResponse', reply);

        authLogger.info('Custom profile picture uploaded', { username: user.username });
    } catch (error) {
        authLogger.error('Error uploading profile picture', { username: user.username, error: error.message });
        socket.emit('profilePicUploadResponse', {
            success: false,
            message: 'Database error'
        });
    }
}

/** Seat controllers that make a finished game a bot game (statsScope.js). */
const BOT_CONTROLLERS = new Set(['bot', 'resignBot']);

/**
 * Record a completed game's results into the gameRecords collection
 * @param {Object} game - The completed game object
 * @param {{withBots?: boolean}} [options] - a bot game (any bot or
 *   resign-bot seat at the end): the entry gets `withBots: true`, its
 *   team1Players/team2Players hold ONLY the seats with a human owner (seat
 *   order, the same recordName mapping) and team1Bots/team2Bots the persona
 *   names of the seats without one ('🤖 Mary'). Bots are never in the
 *   teamNPlayers arrays, so merge / rename / delete (which touch only those)
 *   never see a bot name. A human game's document is exactly today's.
 */
async function recordGameResult(game, { withBots = false } = {}) {
    const gameRecordsCollection = getGameRecordsCollection();
    if (!gameRecordsCollection) return;

    try {
        // Users who deleted their account mid-game must not reappear in new
        // records — deletion already anonymized their historical ones
        const gameManager = require('../game/GameManager');
        const recordName = (p) => {
            if (!p || !p.username) return null;
            return gameManager.deletedUsernames.has(p.username) ? '[deleted]' : p.username;
        };

        // Calculate team-level bags (total tricks taken minus total tricks bid)
        const ps = game.playerStats || {};
        const team1Bags = ((ps[1]?.totalTricks || 0) + (ps[3]?.totalTricks || 0))
            - ((ps[1]?.totalBids || 0) + (ps[3]?.totalBids || 0));
        const team2Bags = ((ps[2]?.totalTricks || 0) + (ps[4]?.totalTricks || 0))
            - ((ps[2]?.totalBids || 0) + (ps[4]?.totalBids || 0));

        let doc;
        if (!withBots) {
            const team1Players = [game.getOriginalPlayer(1), game.getOriginalPlayer(3)]
                .map(recordName)
                .filter(Boolean);
            const team2Players = [game.getOriginalPlayer(2), game.getOriginalPlayer(4)]
                .map(recordName)
                .filter(Boolean);
            doc = {
                gameId: game.gameId,
                team1Score: game.score.team1,
                team2Score: game.score.team2,
                team1Players,
                team2Players,
                team1Bags,
                team2Bags,
                completedAt: new Date()
            };
        } else {
            const owned = (pos) => Boolean(game.seat(pos)?.ownerUsername);
            const humans = (positions) => positions.filter(owned)
                .map(pos => recordName(game.getOriginalPlayer(pos)))
                .filter(Boolean);
            const bots = (positions) => positions.filter(pos => !owned(pos))
                .map(pos => game.getOriginalPlayer(pos)?.username)
                .filter(name => typeof name === 'string' && name.length > 0);
            doc = {
                gameId: game.gameId,
                team1Score: game.score.team1,
                team2Score: game.score.team2,
                team1Players: humans([1, 3]),
                team2Players: humans([2, 4]),
                team1Bags,
                team2Bags,
                completedAt: new Date(),
                withBots: true,
                team1Bots: bots([1, 3]),
                team2Bots: bots([2, 4])
            };
        }

        await gameRecordsCollection.insertOne(doc);

        authLogger.info('Game result recorded', { gameId: game.gameId, withBots });
    } catch (error) {
        authLogger.error('Error recording game result', { gameId: game.gameId, error: error.message });
    }
}

/**
 * Record game statistics for all players after a game ends. Every seat with
 * a human owner is credited (getOriginalPlayer: lazy, resigned and /leave'd
 * owners included); bot seats never are (no accounts). A game with a bot or
 * resign-bot seat at the end (solo games, tournament tables with filler
 * bots, a resigned seat) goes to each owner's `botStats` and a `withBots`
 * record; a game whose only bots are lazy bots stays a human game
 * (`stats`). A game with no human owner at all (the ambient demo) records
 * nothing and leaves the caches alone.
 * @param {Object} game - The completed game object
 */
async function recordGameStats(game) {
    const usersCollection = getUsersCollection();

    // Every seat with a human owner, as the original human player (resigned
    // and lazy positions included)
    const players = [1, 2, 3, 4]
        .map(position => ({ position, player: game.getOriginalPlayer(position) }))
        .filter(({ position, player }) => player && player.username && game.seat(position)?.ownerUsername);

    if (players.length === 0) {
        authLogger.debug('Skipping stat recording — no human players', { gameId: game.gameId });
        return;
    }

    // A bot played a seat for good (native bot or resign bot): the bot-game
    // bucket. Lazy seats still count as human games for their owner.
    const withBots = game.seatList().some(s => BOT_CONTROLLERS.has(s.controller));
    const bucket = withBots ? 'botStats' : 'stats';

    // Record the game result for records page
    await recordGameResult(game, { withBots });
    invalidateRecords();

    // Determine winner based on final scores
    const team1Won = game.score.team1 > game.score.team2;
    const isTie = game.score.team1 === game.score.team2;

    try {
        // One $inc per human seat, written in parallel; each keeps its own
        // try/catch so one failure never hides the others
        await Promise.all(players.map(async ({ position, player }) => {
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
                            [`${bucket}.gamesPlayed`]: 1,
                            [`${bucket}.wins`]: isTie ? 0 : (isWinner ? 1 : 0),
                            [`${bucket}.losses`]: isTie ? 0 : (isWinner ? 0 : 1),
                            [`${bucket}.draws`]: isTie ? 1 : 0,
                            [`${bucket}.totalPoints`]: teamScore,
                            [`${bucket}.totalTricksBid`]: playerBids,
                            [`${bucket}.totalTricksTaken`]: playerTricks,
                            [`${bucket}.totalHands`]: totalHands,
                            [`${bucket}.totalSets`]: teamSets,
                            [`${bucket}.totalSetPoints`]: teamSetPoints,
                            [`${bucket}.totalFaults`]: playerFaults,
                            [`${bucket}.totalHSI`]: playerHSI
                        }
                    }
                );

                authLogger.info('Game stats recorded', {
                    username: player.username,
                    bucket,
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
        }));
    } finally {
        // Settled (each write logs its own failure): the pages re-read, so
        // the players who just played see this game
        invalidateLeaderboard();
        invalidateRecords();
    }
}

/**
 * Get user's saved profile pic from database
 * @param {string} username - Username to look up
 * @param {Object} [options]
 * @param {boolean} [options.randomFallback=true] - false: return null instead
 *   of a random pic (no username, user not found, no pic, DB error), so a
 *   caller running lookups in parallel can draw the random pics itself in a
 *   fixed order
 * @returns {Promise<number|string|null>} Profile pic number (1-82), custom
 *   pic data URL, or random (null when randomFallback is false) if not set
 */
async function getUserProfilePic(username, { randomFallback = true } = {}) {
    const usersCollection = getUsersCollection();

    if (!username) {
        authLogger.warn('getUserProfilePic called with no username, returning random pic');
        return randomFallback ? Math.floor(Math.random() * 82) + 1 : null;
    }

    try {
        const user = await usersCollection.findOne({ username }, { projection: { profilePic: 1, customProfilePic: 1 } });
        authLogger.debug('getUserProfilePic lookup', {
            username,
            found: !!user,
            profilePic: user?.profilePic,
            hasCustomPic: !!user?.customProfilePic
        });

        // Return custom profile pic (base64 string) if set. warm() only
        // starts deriving its small rendition in the background (no await,
        // no RNG): the value returned is unchanged
        if (user && user.customProfilePic) {
            avatarStore.warm(username, user.customProfilePic);
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
    return randomFallback ? Math.floor(Math.random() * 82) + 1 : null;
}

/** Leaderboard row fields every scope reads. */
const LEADERBOARD_FIELDS = { username: 1, profilePic: 1, customProfilePic: 1 };
const NOT_MERGED = { mergedInto: { $exists: false } };

/**
 * Per scope: which users have a row (at least one game in that scope; never
 * a merged-away tombstone), what is read, and the bucket the row math uses.
 * 'human' is today's query and projection exactly.
 */
const LEADERBOARD_QUERIES = {
    human: {
        filter: { 'stats.gamesPlayed': { $gt: 0 }, ...NOT_MERGED },
        projection: { ...LEADERBOARD_FIELDS, stats: 1 },
        bucket: (user) => user.stats || {}
    },
    bots: {
        filter: { 'botStats.gamesPlayed': { $gt: 0 }, ...NOT_MERGED },
        projection: { ...LEADERBOARD_FIELDS, botStats: 1 },
        bucket: (user) => user.botStats || {}
    },
    all: {
        filter: { $or: [{ 'stats.gamesPlayed': { $gt: 0 } }, { 'botStats.gamesPlayed': { $gt: 0 } }], ...NOT_MERGED },
        projection: { ...LEADERBOARD_FIELDS, stats: 1, botStats: 1 },
        bucket: (user) => sumBuckets(user.stats, user.botStats)
    }
};

/**
 * The leaderboard rows (one per player with a game in `scope`, plus the
 * Population average row over those players), sorted by win rate. Cached
 * for 60 s per scope; invalidated when stats change (recordGameStats,
 * account deletion, a profile picture change, an admin merge or rename).
 */
async function fillLeaderboard(scope = 'human') {
    const usersCollection = getUsersCollection();
    const query = LEADERBOARD_QUERIES[scope] || LEADERBOARD_QUERIES.human;

    // Find all users with at least one game played in this scope
    // (merged-away accounts are tombstones whose stats live on the kept
    // account)
    const users = await usersCollection.find(query.filter, { projection: query.projection }).toArray();

    // Compute derived stats and format response
    const leaderboard = users.map(user => {
        const stats = query.bucket(user);
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

    // Rows with customProfilePic null plus avatarUrls {username: url}
    // (V1_REMOVALS #19 B: no inline picture), cached together
    return avatarWire.mapProfileRows(leaderboard);
}

/** `out` plus the requested scope when the request named one (statsScope.js). */
function withScope(out, scope, echo) {
    if (echo) out.scope = scope;
    return out;
}

/** The leaderboard reply for `socket` from a cached fill. */
function leaderboardPayload(socket, value, scope = 'human', echo = false) {
    const out = { success: true, leaderboard: value.rows };
    if (value.avatarUrls) out.avatarUrls = value.avatarUrls;
    return withScope(out, scope, echo);
}

/** The stats a profile reply shows for `scope`. 'human' is the stored bucket as is. */
function profileStats(dbUser, scope) {
    if (scope === 'bots') return dbUser.botStats ? pickStats(dbUser.botStats) : emptyStats();
    if (scope === 'all') return sumBuckets(dbUser.stats, dbUser.botStats);
    return dbUser.stats || emptyStats();
}

/**
 * A profile reply (profileResponse / playerProfileResponse): today's keys,
 * customProfilePic always null (V1_REMOVALS #19 B), plus avatarUrl
 * (additive) for a custom picture whose rendition exists, and `scope` when
 * asked for one.
 */
async function profileReply(socket, dbUser, scope = 'human', echo = false) {
    const raw = dbUser.customProfilePic || null;
    const r = raw ? await avatarWire.resolveStored(raw, dbUser.username) : { url: null };
    const out = {
        success: true,
        profile: {
            username: dbUser.username,
            profilePic: dbUser.profilePic || 1,
            customProfilePic: null,
            stats: profileStats(dbUser, scope)
        }
    };
    if (r.url) out.avatarUrl = r.url;
    return withScope(out, scope, echo);
}

/**
 * Get leaderboard data with computed stats for all players
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} [data] - optional {scope: 'human'|'bots'|'all'} (statsScope.js)
 */
async function getLeaderboard(socket, io, data) {
    const { scope, echo } = normalizeScope(data);
    const cache = leaderboardCache[scope];

    // Soft limit (one budget for every scope): over it, this scope's
    // (possibly stale) cached rows, never serverError
    if (!rateLimiter.check(socket.id, 'getLeaderboard')) {
        await replyThrottled(socket, 'leaderboardResponse', cache,
            (value) => leaderboardPayload(socket, value, scope, echo),
            (fail) => withScope(fail, scope, echo));
        return;
    }

    try {
        const value = await cache.get(() => fillLeaderboard(scope));

        socket.emit('leaderboardResponse', leaderboardPayload(socket, value, scope, echo));

        authLogger.debug('Leaderboard fetched', { scope, playerCount: value.rows.length });
    } catch (error) {
        authLogger.error('Error fetching leaderboard', { scope, error: error.message });
        socket.emit('leaderboardResponse', withScope({
            success: false,
            message: 'Database error'
        }, scope, echo));
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

    // No username is longer than 50 characters, so a longer query matches
    // nobody: answer without a DB round trip
    if (query.trim().length > MAX_USERNAME_LENGTH) {
        socket.emit('searchPlayersResponse', { success: true, players: [] });
        return;
    }

    try {
        // Escape regex special characters. The unanchored case-insensitive
        // regex walks the username_1 index keys (no collection scan)
        const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const users = await usersCollection.find(
            { username: { $regex: escaped, $options: 'i' }, mergedInto: { $exists: false } },
            { projection: { username: 1, profilePic: 1, customProfilePic: 1, 'stats.gamesPlayed': 1, 'stats.wins': 1 } }
        ).limit(20).toArray();

        const rows = users.map(u => ({
            username: u.username,
            profilePic: u.profilePic || 1,
            customProfilePic: u.customProfilePic || null,
            gamesPlayed: u.stats?.gamesPlayed || 0,
            wins: u.stats?.wins || 0
        }));
        const mapped = await avatarWire.mapProfileRows(rows);
        const players = mapped.rows;
        const reply = { success: true, players };
        if (mapped.avatarUrls) reply.avatarUrls = mapped.avatarUrls;

        socket.emit('searchPlayersResponse', reply);
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
 * @param {Object} data - Contains username string, optional scope (statsScope.js)
 */
async function getPlayerProfile(socket, io, data) {
    const usersCollection = getUsersCollection();

    const { username } = data || {};
    const { scope, echo } = normalizeScope(data);
    if (!username || typeof username !== 'string' || !username.trim()) {
        socket.emit('playerProfileResponse', {
            success: false,
            message: 'Username is required'
        });
        return;
    }

    try {
        let dbUser = await usersCollection.findOne({ username: username.trim() }, { projection: profileProjection(scope) });

        // Old names from merged accounts (e.g. in game records) show the
        // account they were merged into. A rename's old name (or a merged
        // one a rename re-pointed) does not: it would tell anyone the new
        // name (authHandlers.hidesNewName)
        if (dbUser?.mergedInto) {
            dbUser = dbUser.renamedAt || dbUser.targetRenamedAt
                ? null
                : await usersCollection.findOne({ username: dbUser.mergedInto }, { projection: profileProjection(scope) });
        }

        if (!dbUser) {
            socket.emit('playerProfileResponse', {
                success: false,
                message: 'Player not found'
            });
            return;
        }

        socket.emit('playerProfileResponse', await profileReply(socket, dbUser, scope, echo));

        authLogger.debug('Player profile fetched', { username: username.trim() });
    } catch (error) {
        authLogger.error('Error fetching player profile', { username, error: error.message });
        socket.emit('playerProfileResponse', { success: false, message: 'Database error' });
    }
}

/** Records periods are in server local time; the cache key changes with the month. */
function recordsKey(now) {
    return `${now.getFullYear()}-${now.getMonth()}`;
}

// Only the fields the reduction below reads
const RECORDS_PROJECTION = { _id: 0, team1Score: 1, team2Score: 1, team1Players: 1, team2Players: 1, team1Bags: 1, team2Bags: 1 };
// Bot games also list their bot personas (team1Bots / team2Bots)
const RECORDS_PROJECTION_WITH_BOTS = { ...RECORDS_PROJECTION, team1Bots: 1, team2Bots: 1 };

/** Which gameRecords a scope reads: human games (no withBots), bot games, or every one. */
const RECORDS_SCOPE_FILTER = {
    human: { withBots: { $ne: true } },
    bots: { withBots: true },
    all: {}
};

/**
 * One team of a record for `scope`. Human scope: exactly the stored
 * teamNPlayers (today's reply). Bots / all: the humans, then the bot
 * personas (strings, so `players` keeps its wire type), and whether the
 * team had no human at all (such a team never holds a team record).
 */
function recordTeam(game, n, scope) {
    const players = game[`team${n}Players`];
    if (scope === 'human') return { players, allBots: false };
    const humans = Array.isArray(players) ? players : [];
    const bots = Array.isArray(game[`team${n}Bots`]) ? game[`team${n}Bots`] : [];
    return { players: [...humans, ...bots], allBots: humans.length === 0 && bots.length > 0 };
}

/**
 * The records page: highest/lowest team score, biggest win and most/least
 * bags for all time, this year and this month, plus the total game count.
 * Three separate finds on purpose: thisYear/thisMonth come back newest-first
 * through the completedAt_-1 index and allTime in natural order, and ties
 * keep the first game seen, so merging them into one pass would change which
 * tied game a period shows.
 *
 * `scope` (statsScope.js): 'human' reads only human games (withBots not
 * true) with today's projection; 'bots' only bot games; 'all' every game.
 * In bots / all a team made only of bots never holds the team records
 * (highest/lowest score, most/least bags); a biggest win always has a human
 * on one side.
 */
async function fillRecords(now, scope = 'human') {
    const gameRecordsCollection = getGameRecordsCollection();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const base = RECORDS_SCOPE_FILTER[scope] || RECORDS_SCOPE_FILTER.human;
    const projection = scope === 'human' ? RECORDS_PROJECTION : RECORDS_PROJECTION_WITH_BOTS;

    const filters = {
        allTime: { ...base },
        thisYear: { ...base, completedAt: { $gte: startOfYear } },
        thisMonth: { ...base, completedAt: { $gte: startOfMonth } }
    };

    const periods = Object.keys(filters);
    const [totalGames, ...results] = await Promise.all([
        gameRecordsCollection.countDocuments({ ...base }),
        ...periods.map(period => gameRecordsCollection.find(filters[period], { projection }).toArray())
    ]);

    const records = {};

    for (let p = 0; p < periods.length; p++) {
        const period = periods[p];
        const games = results[p];

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
            const team1 = recordTeam(game, 1, scope);
            const team2 = recordTeam(game, 2, scope);

            // Check both teams for highest/lowest individual team score
            const entries = [
                { score: game.team1Score, players: team1.players, allBots: team1.allBots },
                { score: game.team2Score, players: team2.players, allBots: team2.allBots }
            ];

            for (const entry of entries) {
                if (entry.allBots) continue;
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
                    winnerPlayers: winnerIsTeam1 ? team1.players : team2.players,
                    loserPlayers: winnerIsTeam1 ? team2.players : team1.players
                };
            }

            // Most/least bags — skip legacy records without bags data
            if (game.team1Bags != null && game.team2Bags != null) {
                const bagsEntries = [
                    { bags: game.team1Bags, players: team1.players, allBots: team1.allBots },
                    { bags: game.team2Bags, players: team2.players, allBots: team2.allBots }
                ];

                for (const entry of bagsEntries) {
                    if (entry.allBots) continue;
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

    return { records, totalGames };
}

/**
 * Get game records (highest score, lowest score, biggest win) for 3 time periods
 * @param {Socket} socket - Socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} [data] - optional {scope: 'human'|'bots'|'all'} (statsScope.js)
 */
async function getRecords(socket, io, data) {
    const gameRecordsCollection = getGameRecordsCollection();
    const { scope, echo } = normalizeScope(data);

    if (!gameRecordsCollection) {
        socket.emit('recordsResponse', withScope({ success: false, message: 'Database not available' }, scope, echo));
        return;
    }

    // A new month starts new thisMonth (and maybe thisYear) periods, in
    // every scope
    const now = new Date();
    const key = recordsKey(now);
    if (key !== recordsCacheKey) {
        invalidateRecords();
        recordsCacheKey = key;
    }

    const cache = recordsCache[scope];
    const toPayload = ({ records, totalGames }) => withScope({ success: true, records, totalGames }, scope, echo);

    // Soft limit (one budget for every scope): over it, this scope's
    // (possibly stale) cached records, never serverError
    if (!rateLimiter.check(socket.id, 'getRecords')) {
        await replyThrottled(socket, 'recordsResponse', cache, toPayload,
            (fail) => withScope(fail, scope, echo));
        return;
    }

    try {
        const value = await cache.get(() => fillRecords(now, scope));
        socket.emit('recordsResponse', toPayload(value));
        authLogger.debug('Records fetched', { scope });
    } catch (error) {
        authLogger.error('Error fetching records', { scope, error: error.message });
        socket.emit('recordsResponse', withScope({ success: false, message: 'Database error' }, scope, echo));
    }
}

/**
 * Reply to a request over its soft rate limit (getLeaderboard/getRecords):
 * the last cached value even if expired, else the fill already running,
 * else the ordinary failure reply both clients show (never serverError).
 * `toFailure` adds the scope echo to a failure, so a client with several
 * scopes in flight knows which one failed (iOS 1.2.1 build 8).
 */
async function replyThrottled(socket, event, cache, toPayload, toFailure = (f) => f) {
    const cached = cache.peek();
    if (cached !== undefined) {
        socket.emit(event, toPayload(cached));
        return;
    }
    const pending = cache.inflightPromise();
    if (pending) {
        try {
            socket.emit(event, toPayload(await pending));
        } catch (error) {
            socket.emit(event, toFailure({ success: false, message: 'Database error' }));
        }
        return;
    }
    socket.emit(event, toFailure({ success: false, message: 'Too many requests. Please wait a moment.' }));
}

/** A stats/picture/account change: the next leaderboard fetch reads fresh (every scope). */
function invalidateLeaderboard() {
    for (const scope of SCOPES) leaderboardCache[scope].invalidate();
}

/** A new or anonymized game record: the next records fetch reads fresh (every scope). */
function invalidateRecords() {
    for (const scope of SCOPES) recordsCache[scope].invalidate();
}

/** Test helper: empty every cache. */
function _resetCachesForTests() {
    invalidateLeaderboard();
    invalidateRecords();
    recordsCacheKey = null;
}

module.exports = {
    invalidateLeaderboard,
    invalidateRecords,
    _resetCachesForTests,
    _peekLeaderboardCache: (scope = 'human') => leaderboardCache[scope]?.peek(),
    _peekRecordsCache: (scope = 'human') => recordsCache[scope]?.peek(),
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
