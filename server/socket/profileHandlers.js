/**
 * Profile socket event handlers
 * Handles fetching and updating user profiles
 */

const { scorecardWire } = require('../game/scorecard');
const database = require('../database');
const { getUsersCollection, getGameRecordsCollection } = database;
const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');
const { createCache } = require('../utils/ttlCache');
const rateLimiter = require('./rateLimiter');
const { emitError } = require('./serverError');
const avatarStore = require('../avatar/avatarStore');
const avatarWire = require('../avatar/avatarWire');
const image = require('../avatar/image');
const { STOCK_AVATAR_COUNT, randomStockPic } = require('../avatar/stockAvatars');
const { SCOPES, STAT_KEYS, emptyStats, pickStats, sumBuckets, normalizeScope } = require('../utils/statsScope');
const { createSuperlatives, accountTotals, SUPERLATIVE_MIN_GAMES, SUPERLATIVES_PROJECTION, ACCOUNT_FIELDS, CUT_PROJECTION } = require('../utils/superlatives');
const { buildTournamentRecord, recordNames, recentResult, RECENT_RESULTS } = require('../game/tournamentRecord');
const { trackInFlight, retryDelay, shutdownAllowsRetry } = require('../utils/shutdown');
const { isAssistedSeat, helpUses, usedTutorial, isBotStatsGame, assistedSeatMoves } = require('../game/assistState');
const { normalizeSeatBags, normalizeSeatCounter } = require('../game/rules');
const { DELETED_NAME } = require('../admin/nameHold');
const badgeRules = require('../game/badges');
const badgeAwards = require('./badgeAwards');
const { hasCap } = require('./clientInfo');

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
const PROFILE_PROJECTION = { username: 1, profilePic: 1, customProfilePic: 1, stats: 1, mergedInto: 1, renamedAt: 1, targetRenamedAt: 1, badges: 1 };
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
    // Registered without a schema (safeHandler), so the limit is checked
    // here; over it, the wrappers' rateLimit reply
    if (!rateLimiter.check(socket.id, 'getProfile')) {
        emitError(socket, { type: 'rateLimit', message: 'Too many requests, please slow down', handler: 'getProfile' });
        return;
    }
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

    // Validate profilePic range (1..STOCK_AVATAR_COUNT)
    if (!profilePic || profilePic < 1 || profilePic > STOCK_AVATAR_COUNT) {
        socket.emit('profilePicUpdateResponse', {
            success: false,
            message: `Invalid profile picture number (must be 1-${STOCK_AVATAR_COUNT})`
        });
        return;
    }

    try {
        // Choosing a stock picture replaces a custom one (2026-11-15): the
        // custom picture wins everywhere it is read (getUserProfilePic,
        // profileReply, the leaderboard rows), so with it still stored the
        // choice changed nothing anyone saw, while both clients show the
        // stock picture and "Profile picture updated!"
        await usersCollection.updateOne(
            { username: user.username },
            { $set: { profilePic: profilePic }, $unset: { customProfilePic: '' } }
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

/**
 * End-of-game writes, made safe to retry and to replay:
 *   1. the gameRecords entry goes in first, carrying `statsDeltas` (the
 *      bucket and each human seat's 12 counters, by position: no names;
 *      the reader also honours a per-seat `bucketByPosition`, seatBucket,
 *      written for a seat whose /help use made the game bot-assisted for
 *      that player and whose team won, buildGameEndRecord) and
 *      `statsPending` ([{position, username}] still to apply). The unique
 *      gameId index (database.ensureGameIdIndex) makes a second insert fail
 *      with E11000, and the write then reuses the stored entry
 *   2. each pending player's `$inc` is guarded by the game id: the filter
 *      `statsGames.id: {$ne: gameId}` and a `$push` of {id, at} (the last
 *      STATS_GAMES_KEPT kept) in the same update, so applying it twice
 *      counts once. For a record read back (a replay, the sweep, maybe
 *      days later) the window is only trusted back to its oldest `at`: a
 *      full list whose oldest entry is newer than the game (less
 *      STATS_GUARD_SKEW_MS) may have dropped the id, so the game is not
 *      credited (logged with the delta) rather than risk counting it twice.
 *      A record this chain just inserted was never applied, so only the id
 *      guards it. A tombstone (renamed or merged away) is never credited
 *   3. the record's badges are awarded (socket/badgeAwards.js, each write
 *      retried and guarded, so a re-run awards nothing twice)
 *   4. `statsPending` is unset (or cut to what failed, a stats write or a
 *      badge award); the usernames leave the record with it
 * Every step retries with backoff (shutdown.retryDelay, short during a
 * shutdown, which retries until its drain ends), and a graceful shutdown
 * waits for the whole chain (shutdown.trackInFlight). A record still
 * pending at the next boot (a crash, an outage longer than the retries) is
 * finished by resumePendingGameStats. Any failure is retried: every step is
 * idempotent.
 */
const STATS_GAMES_KEPT = 50;
// Covers clock skew between server processes (a deploy overlaps two); a
// game is credited from the window only if the window reaches back this far
// before the game ended
const STATS_GUARD_SKEW_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
// One chain per game in this process: a second call joins the first
const statsWrites = new Map();

const isDuplicateKey = (error) => error?.code === 11000;

/** Run `fn(attempt)`, retrying a failure after each of retryDelaysMs; the last failure throws. */
async function withRetry(step, gameId, fn) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            // A shutdown keeps retrying while its drain has time
            if (attempt >= retryDelaysMs.length && !shutdownAllowsRetry()) throw error;
            const retryInMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
            authLogger.warn('End-of-game write failed; retrying', { step, gameId, attempt: attempt + 1, retryInMs, error: error.message });
            await retryDelay(retryInMs);
        }
    }
}

/**
 * The gameRecords entry of a finished game (no stats fields)
 * @param {Object} game - The completed game object
 * @param {{withBots?: boolean}} [options] - a bot game (any bot or
 *   resign-bot seat at the end): the entry gets `withBots: true`, its
 *   team1Players/team2Players hold ONLY the seats with a human owner (seat
 *   order, the same recordName mapping) and team1Bots/team2Bots the persona
 *   names of the seats without one ('🤖 Mary'). Bots are never in the
 *   teamNPlayers arrays, so merge / rename / delete (which touch only those)
 *   never see a bot name. A human game's document is exactly today's.
 */
function buildGameRecord(game, { withBots = false } = {}) {
    // Users who deleted their account mid-game must not reappear in new
    // records — deletion already anonymized their historical ones
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

    if (!withBots) {
        const team1Players = [game.getOriginalPlayer(1), game.getOriginalPlayer(3)]
            .map(recordName)
            .filter(Boolean);
        const team2Players = [game.getOriginalPlayer(2), game.getOriginalPlayer(4)]
            .map(recordName)
            .filter(Boolean);
        return {
            gameId: game.gameId,
            team1Score: game.score.team1,
            team2Score: game.score.team2,
            team1Players,
            team2Players,
            team1Bags,
            team2Bags,
            completedAt: new Date()
        };
    }
    const owned = (pos) => Boolean(game.seat(pos)?.ownerUsername);
    const humans = (positions) => positions.filter(owned)
        .map(pos => recordName(game.getOriginalPlayer(pos)))
        .filter(Boolean);
    const bots = (positions) => positions.filter(pos => !owned(pos))
        .map(pos => game.getOriginalPlayer(pos)?.username)
        .filter(name => typeof name === 'string' && name.length > 0);
    return {
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

/**
 * The 12 counters one human seat adds to its bucket for this game
 * (STAT_KEYS). The superlatives' per-seat bags are NOT here
 * (buildGameEndRecord: statsDeltas.bags), so no version's
 * applyPendingStats ever $incs them into users.stats / botStats.
 */
function seatStatsDelta(game, position) {
    const team1Won = game.score.team1 > game.score.team2;
    const isTie = game.score.team1 === game.score.team2;
    const isTeam1 = position === 1 || position === 3;
    const isWinner = (isTeam1 && team1Won) || (!isTeam1 && !team1Won);
    // Per-player stats for individual bids/tricks (accumulated across all hands)
    const playerStats = game.playerStats?.[position] || { totalBids: 0, totalTricks: 0, setsCaused: 0, totalHSI: 0 };
    return {
        gamesPlayed: 1,
        wins: isTie ? 0 : (isWinner ? 1 : 0),
        losses: isTie ? 0 : (isWinner ? 0 : 1),
        draws: isTie ? 1 : 0,
        totalPoints: isTeam1 ? game.score.team1 : game.score.team2,
        totalTricksBid: playerStats.totalBids,
        totalTricksTaken: playerStats.totalTricks,
        totalHands: game.handStats.totalHands,
        // Total sets is team-based, not fault-based
        totalSets: isTeam1 ? game.handStats.team1Sets : game.handStats.team2Sets,
        // Points lost to sets - for the "drag" stat
        totalSetPoints: isTeam1 ? (game.handStats.team1SetPoints || 0) : (game.handStats.team2SetPoints || 0),
        totalFaults: playerStats.setsCaused || 0,
        totalHSI: playerStats.totalHSI || 0
    };
}

const RECORD_STATS_PROJECTION = Object.freeze({ gameId: 1, completedAt: 1, statsDeltas: 1, statsPending: 1 });

/**
 * Insert the record (step 1). Every attempt first looks for an entry
 * already there (a replay, or an earlier attempt whose reply was lost; also
 * while legacy duplicates leave only the non-unique fallback index), and
 * E11000 means one raced in: either way the stored entry wins, so its
 * pending list (none once applied) is what step 2 applies.
 * @returns {Promise<Object>} the record as stored
 */
async function insertGameRecord(gameRecords, doc) {
    const stored = () => gameRecords.findOne({ gameId: doc.gameId }, { projection: RECORD_STATS_PROJECTION });
    return withRetry('record', doc.gameId, async () => {
        const existing = await stored();
        if (existing) return existing;
        try {
            await gameRecords.insertOne(doc);
            return doc;
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            return (await stored()) || { gameId: doc.gameId };
        }
    });
}

/**
 * Why a guarded `$inc` matched nothing: applied before (a replay, the usual
 * case), no account, a tombstone, or a full guard window newer than the game
 * (it may have been applied and dropped from the window). The last two are
 * not credited, so they warn with the delta for a manual fix. Never throws.
 */
async function explainNotCredited(users, username, gameId, { bucket, delta }) {
    let doc = null;
    try {
        doc = await users.findOne({ username }, { projection: { mergedInto: 1, statsGames: 1 } });
    } catch (error) {
        authLogger.warn('Game stats not credited; could not tell why', { username, gameId, bucket, delta, error: error.message });
        return;
    }
    if (!doc) {
        authLogger.debug('Game stats not credited: no account', { username, gameId });
    } else if ((doc.statsGames || []).some(g => g?.id === gameId)) {
        authLogger.debug('Game stats already applied', { username, gameId });
    } else if (doc.mergedInto) {
        authLogger.warn('Game stats not credited: the account was renamed or merged', { username, mergedInto: doc.mergedInto, gameId, bucket, delta });
    } else {
        authLogger.warn('Game stats not credited: the guard window no longer reaches this game', { username, gameId, bucket, delta });
    }
}

/** The two stats buckets a record can route to; anything else is not a bucket. */
const STATS_BUCKETS = new Set(['stats', 'botStats']);

/**
 * The bucket one seat of a record goes to: `statsDeltas.bucketByPosition`
 * for that seat when it names a bucket (a per-player bot-assisted game,
 * written from /help's stats writer on), else the whole-game
 * `statsDeltas.bucket` ('botStats' or, for anything else, 'stats'). An
 * unknown per-seat value, or a bucketByPosition that is not a plain
 * object, falls back to the whole-game bucket. Records
 * without `bucketByPosition` (every record before it) route as before.
 * @param {Object|undefined} statsDeltas
 * @param {number|string} position
 * @returns {'stats'|'botStats'}
 */
function seatBucket(statsDeltas, position) {
    const wholeGame = statsDeltas?.bucket === 'botStats' ? 'botStats' : 'stats';
    const byPos = statsDeltas?.bucketByPosition;
    if (!byPos || typeof byPos !== 'object' || Array.isArray(byPos) || !Object.hasOwn(byPos, position)) return wholeGame;
    const seat = byPos[position];
    return STATS_BUCKETS.has(seat) ? seat : wholeGame;
}

/**
 * Steps 2 to 4 for one record: every pending player's guarded `$inc` (into
 * that seat's bucket, seatBucket), the record's badges, then the record's
 * pending list cut to what failed (unset when nothing did). Safe to run twice for the same
 * record, also from two processes.
 * @param {{gameId: string, statsDeltas?: Object, statsPending?: Array}} record
 * @param {{users: Collection, gameRecords?: Collection, fresh?: boolean}} collections
 *   fresh: this chain just inserted the record (or none could be written)
 * @returns {Promise<number>} players whose write failed for good
 */
async function applyPendingStats(record, { users, gameRecords, fresh = false }) {
    const { gameId } = record;
    const pending = Array.isArray(record.statsPending) ? record.statsPending : [];
    const byPosition = record.statsDeltas?.byPosition || {};
    const done = new Set();
    const endedAt = record.completedAt instanceof Date ? record.completedAt.getTime() : Date.now();
    // The list still has room, or it reaches back past the game
    const windowReaches = fresh ? {} : {
        $or: [
            { [`statsGames.${STATS_GAMES_KEPT - 1}`]: { $exists: false } },
            { 'statsGames.0.at': { $lt: new Date(endedAt - STATS_GUARD_SKEW_MS) } }
        ]
    };

    await Promise.all(pending.map(async (entry) => {
        const delta = byPosition[entry?.position];
        if (!delta || !entry.username) {
            done.add(entry);
            return;
        }
        const bucket = seatBucket(record.statsDeltas, entry.position);
        // Only the bucket's 12 fields, so a profile's raw bucket keeps its
        // shape whatever else a delta may carry
        const $inc = {};
        for (const field of STAT_KEYS) {
            if (delta[field] !== undefined) $inc[`${bucket}.${field}`] = delta[field];
        }
        // Badges (Child Labor): the times this seat was over-trumped, into
        // the player's lifetime count under the same guard (human games only)
        const overtrumped = bucket === 'stats' ? record.statsDeltas?.overtrumped?.[entry.position] : 0;
        if (Number.isSafeInteger(overtrumped) && overtrumped > 0) $inc['badgeProgress.overtrumped'] = overtrumped;
        try {
            const res = await withRetry('stats', gameId, () => users.updateOne(
                {
                    username: entry.username,
                    mergedInto: { $exists: false },
                    'statsGames.id': { $ne: gameId },
                    ...windowReaches
                },
                // `at` per attempt: when the push really ran
                { $inc, $push: { statsGames: { $each: [{ id: gameId, at: new Date() }], $slice: -STATS_GAMES_KEPT } } }
            ));
            done.add(entry);
            if (res?.matchedCount === 0) {
                await explainNotCredited(users, entry.username, gameId, { bucket, delta });
            } else {
                authLogger.info('Game stats recorded', {
                    username: entry.username,
                    gameId,
                    bucket,
                    won: delta.wins === 1,
                    score: delta.totalPoints,
                    tricks: delta.totalTricksTaken,
                    bids: delta.totalTricksBid,
                    hands: delta.totalHands,
                    sets: delta.totalSets,
                    setPoints: delta.totalSetPoints,
                    faults: delta.totalFaults,
                    hsi: delta.totalHSI
                });
            }
        } catch (error) {
            authLogger.error('Error recording game stats', { username: entry.username, gameId, bucket, delta, error: error.message });
        }
    }));

    // Badges: what this record earned, plus the lifetime ones the stats just
    // written may have reached (idempotent: socket/badgeAwards.js), each
    // write retried like the stats. BEFORE the mark: a player whose award
    // did not go through keeps their pending entry, so the boot sweep
    // (resumePendingGameStats) finishes it, and a crash before the mark
    // leaves the whole record pending (the stats guard keeps the re-run
    // single). Each player still online is told privately (badgesAwarded)
    const badges = await badgeAwards.awardAndNotify(record, {
        users,
        gameRecords,
        retry: (step, fn) => withRetry(step, gameId, fn)
    });
    if (badges.failed === null) {
        done.clear();
    } else if (badges.failed.length > 0) {
        const unfinished = new Set(badges.failed);
        for (const entry of [...done]) if (unfinished.has(entry?.username)) done.delete(entry);
    }

    const remaining = pending.filter(entry => !done.has(entry));
    // An empty list (account deletion pulls its entry) is cleared too
    const emptied = pending.length === 0 && Array.isArray(record.statsPending);
    if (gameRecords && (emptied || remaining.length < pending.length)) {
        const update = remaining.length > 0
            ? { $set: { statsPending: remaining } }
            : { $unset: { statsPending: '' } };
        try {
            await withRetry('mark', gameId, () => gameRecords.updateOne({ gameId }, update));
        } catch (error) {
            // Harmless: the next boot's sweep re-applies, and the per-user
            // guard keeps that from counting twice
            authLogger.error('Could not mark game stats applied', { gameId, error: error.message });
        }
    }
    return remaining.length;
}

/**
 * Record game statistics for all players after a game ends. Every seat with
 * a human owner is credited (getOriginalPlayer: lazy, resigned and /leave'd
 * owners included); bot seats never are (no accounts). A game with a bot or
 * resign-bot seat at the end (solo games, tournament tables with filler
 * bots, a resigned seat) goes to each owner's `botStats` and a `withBots`
 * record; a game whose only bots are lazy bots stays a human game
 * (`stats`). A game with no human owner at all (the ambient demo) records
 * nothing and leaves the caches alone. Retry- and replay-safe (see
 * STATS_GAMES_KEPT above); never rejects.
 * @param {Object} game - The completed game object
 * @param {Object} [opts]
 * @param {Object|null} [opts.record] - the gameRecords document already
 *   built for this end (buildGameEndRecord(game)), inserted as is; null:
 *   nothing to record. Omitted: built here. Deploy survival builds it once
 *   and hands the same object to the ENDED tombstone
 *   (gameCodec.serializeEnded), so the two can never differ (completedAt,
 *   a deleted owner's name or pending entry).
 * @param {Function} [opts.onRecorded] - called once the gameRecords
 *   insert is acknowledged (inserted, or found already there): the persist
 *   store then deletes the game's ENDED tombstone (persist/liveStore.js).
 *   Not called when the insert failed for good or nothing is recorded.
 * @returns {Promise<void>}
 */
function recordGameStats(game, { record, onRecorded } = {}) {
    const key = game?.gameId;
    if (key && statsWrites.has(key)) return statsWrites.get(key);
    const run = writeGameStats(game, record, onRecorded)
        .catch(error => { authLogger.error('End-of-game writes failed', { gameId: key, error: error.message }); })
        .finally(() => { if (key) statsWrites.delete(key); });
    if (key) statsWrites.set(key, run);
    return trackInFlight(run);
}

/**
 * The gameRecords document the end of `game` inserts (writeGameStats, step
 * 1): buildGameRecord plus `statsDeltas` {bucket, byPosition} (each human
 * owner's counters, seatStatsDelta) and `statsPending` (who still gets
 * them; left out when nobody does). One builder, so the live end of a game
 * and a persisted ENDED tombstone (deploy survival) insert the same
 * record. No I/O: it reads the game, gameManager.deletedUsernames and the
 * clock (completedAt).
 *
 * `statsDeltas.names {<pos>: username}` (superlatives, 2026-11-20): the
 * seat -> player map the Records superlatives read, durable (statsPending
 * is unset once the stats are applied): every seat in byPosition, by its
 * record name ('[deleted]' for a player deleted mid-game, as in
 * teamNPlayers); humans only. Kept in step with teamNPlayers by
 * server/admin/accountRename.js, accountMerge.js and accountDelete.js.
 * `statsDeltas.bags {<pos>: n}` (Bag Boy): the seat's tricks over its own
 * bid, counted per hand (game.seatBags, gameHandlers.handleHandComplete),
 * only when the counter saw every hand of the game (seatBags.hands ===
 * handStats.totalHands): a game adopted from a process without the
 * counter (null), or one that went through such a process and back (the
 * release before drops the field), has none, and the superlatives fall
 * back to the net of each seat. Beside byPosition on purpose: an
 * applyPendingStats that $incs every byPosition field (the release
 * before) never sees it.
 * `statsDeltas.exact {<pos>: n}` (My Quantitative, 2026-11-20): the hands
 * the seat's bid was spot on (rules.seatSpotOn, game.seatExact), under the
 * same rule as bags: only when that counter saw every hand of the game.
 *
 * /help (plan section 6, D11) and the tutorial (D12): a seat whose owner
 * made more than ASSIST_FREE_HELP counted /help uses or played with the
 * tutorial (a.tutorialEver; assistState.isAssistedSeat) played a
 * bot-assisted game, for that player only. In a human game (bucket 'stats')
 * such a seat is moved to its owner's bot-game stats ONLY when its team won
 * (owner 2026-11-21, assistState.assistedSeatMoves: a loss or a tie stays in
 * the human stats, so /help cannot carry a losing game off the leaderboard);
 * for each moved seat:
 *   - `statsDeltas.bucketByPosition {<pos>: 'botStats'}`; the other seats
 *     (an assisted seat on the losing team or in a tie included) stay in
 *     the whole-game bucket
 *   - `withBots: true` (+ `team1Bots` / `team2Bots`, empty for human seats)
 *     so the game's team records move to the "with bots" Records scope, and
 *     `assistedTeams: [1|2]` (server-only: no Records projection sends it)
 * A human game whose only assisted seats did not win is a plain human game
 * (no withBots, no assistedTeams). A game that is a bot game anyway (bucket
 * 'botStats') needs no bucketByPosition and marks every assisted seat in
 * assistedTeams, won or not (owner 2026-11-19, "Free UI, still record it").
 * Every seat with counted uses (assisted or not, moved or not) is listed in
 * `statsDeltas.assist {<pos>: {help}}` (by position, never by name; a
 * tutorial seat `{help, tutorial: true}`). A game
 * nobody used /help or the tutorial in gives exactly the document it gave before /help
 * (plus the superlatives' names, and bags when counted, since 2026-11-20;
 * assistRecords.test.js holds it byte for byte).
 * @param {Object} game - a finished game
 * @returns {Object|null} null when no seat has a human owner (nothing is recorded)
 */
function buildGameEndRecord(game) {
    // Every seat with a human owner, as the original human player (resigned
    // and lazy positions included)
    const players = [1, 2, 3, 4]
        .map(position => ({ position, player: game.getOriginalPlayer(position) }))
        .filter(({ position, player }) => player && player.username && game.seat(position)?.ownerUsername);

    if (players.length === 0) return null;

    // A bot played a seat for good (native bot or resign bot): the bot-game
    // bucket. Lazy seats still count as human games for their owner.
    const withBots = isBotStatsGame(game);
    const bucket = withBots ? 'botStats' : 'stats';

    // The bag counter, only when it counted every hand of this game
    const counter = normalizeSeatBags(game.seatBags);
    const counted = counter && counter.hands === game.handStats?.totalHands ? counter.byPos : null;
    // The spot-on counter, under the same rule
    const exactCounter = normalizeSeatCounter(game.seatExact);
    const exactCounted = exactCounter && exactCounter.hands === game.handStats?.totalHands ? exactCounter.byPos : null;

    const byPosition = {};
    const names = {};
    const bags = {};
    const exact = {};
    for (const { position, player } of players) {
        byPosition[position] = seatStatsDelta(game, position);
        names[position] = gameManager.deletedUsernames.has(player.username) ? DELETED_NAME : player.username;
        if (counted) bags[position] = counted[position];
        if (exactCounted) exact[position] = exactCounted[position];
    }
    // A player who deleted their account mid-game has nothing to credit, and
    // their name must not go into the record
    const statsPending = players
        .filter(({ player }) => !gameManager.deletedUsernames.has(player.username))
        .map(({ position, player }) => ({ position, username: player.username }));

    // /help: the evidence (counted uses) and who it made a bot game for (in
    // a human game only a winning seat, owner 2026-11-21)
    const assist = {};
    const assisted = [];
    for (const { position } of players) {
        const a = game.assist?.[position];
        const owner = game.seat(position).ownerUsername;
        const help = helpUses(a, owner);
        // The tutorial (plan D12): {help, tutorial: true}
        if (usedTutorial(a, owner)) assist[position] = { help, tutorial: true };
        else if (help > 0) assist[position] = { help };
        if (isAssistedSeat(a, owner) && (withBots || assistedSeatMoves(game, position))) assisted.push(position);
    }

    const doc = buildGameRecord(game, { withBots: withBots || assisted.length > 0 });
    // The scorecard (2026-11-27, game/scorecard.js): every hand's bids,
    // tricks, faults and points, kept for a later history view. Left out
    // for a game without one (a doc restored from before it)
    if (Array.isArray(game.scorecard) && game.scorecard.length > 0) doc.scorecard = scorecardWire(game);
    doc.statsDeltas = { bucket, byPosition, names };
    if (Object.keys(bags).length > 0) doc.statsDeltas.bags = bags;
    if (Object.keys(exact).length > 0) doc.statsDeltas.exact = exact;
    if (assisted.length > 0 && bucket !== 'botStats') {
        doc.statsDeltas.bucketByPosition = Object.fromEntries(assisted.map((pos) => [pos, 'botStats']));
    }
    if (Object.keys(assist).length > 0) doc.statsDeltas.assist = assist;
    // Badges (game/badges.js; socket/badgeAwards.js awards them once the
    // stats are in): what each seat earned in this game and how often it
    // was over-trumped, only for a seat whose stats count as a human game
    // (not a bot game, not a seat /help or the tutorial moved)
    if (bucket !== 'botStats') {
        const earned = badgeRules.gameBadges(game);
        const overtrumpedByPos = badgeRules.overTrumpedByPos(game);
        const seatBadges = {};
        const overtrumped = {};
        for (const { position } of players) {
            if (assisted.includes(position)) continue;
            if (earned[position]?.length > 0) seatBadges[position] = earned[position];
            if (overtrumpedByPos[position] > 0) overtrumped[position] = overtrumpedByPos[position];
        }
        if (Object.keys(seatBadges).length > 0) doc.statsDeltas.badges = seatBadges;
        if (Object.keys(overtrumped).length > 0) doc.statsDeltas.overtrumped = overtrumped;
    }
    if (assisted.length > 0) doc.assistedTeams = [...new Set(assisted.map((pos) => (pos % 2 === 1 ? 1 : 2)))].sort();
    if (statsPending.length > 0) doc.statsPending = statsPending;
    return doc;
}

async function writeGameStats(game, prebuilt, onRecorded = null) {
    const usersCollection = getUsersCollection();
    const gameRecordsCollection = getGameRecordsCollection();

    const doc = prebuilt === undefined ? buildGameEndRecord(game) : prebuilt;
    if (!doc) {
        authLogger.debug('Skipping stat recording — no human players', { gameId: game.gameId });
        return;
    }
    const withBots = doc.withBots === true;
    let record = { gameId: game.gameId, statsDeltas: doc.statsDeltas, statsPending: doc.statsPending || [] };
    // Not a record read back: never applied before
    let fresh = true;

    try {
        if (gameRecordsCollection) {
            try {
                record = await insertGameRecord(gameRecordsCollection, doc);
                fresh = record === doc;
                authLogger.info('Game result recorded', { gameId: game.gameId, withBots });
                if (onRecorded) {
                    try {
                        onRecorded();
                    } catch (error) {
                        authLogger.error('onRecorded failed', { gameId: game.gameId, error: error.message });
                    }
                }
            } catch (error) {
                // No record after every retry: the stats still go in (the
                // per-user guard keeps them single), logged with the deltas
                authLogger.error('Error recording game result', { gameId: game.gameId, statsDeltas: record.statsDeltas, error: error.message });
            }
            invalidateRecords();
        }
        if (usersCollection) {
            await applyPendingStats(record, { users: usersCollection, gameRecords: gameRecordsCollection, fresh });
        } else {
            // Not connected yet (a game ending right after a cold start)
            authLogger.error('No database: game stats not recorded', { gameId: game.gameId, statsDeltas: record.statsDeltas });
        }
    } finally {
        // Settled (each write logs its own failure): the pages re-read, so
        // the players who just played see this game
        invalidateLeaderboard();
        invalidateRecords();
    }
}

/**
 * Finish the records a previous process left pending (a crash or deploy
 * between steps, an outage longer than the retries). Run once after
 * connectDB (server/index.js). Safe while another process is applying the
 * same records (the per-user guard). Never rejects.
 * @returns {Promise<{records: number, failed: number}>}
 */
async function resumePendingGameStats() {
    const gameRecords = getGameRecordsCollection();
    const users = getUsersCollection();
    const out = { records: 0, failed: 0 };
    if (!gameRecords || !users) return out;
    try {
        const pending = await gameRecords.find(
            { statsPending: { $exists: true } },
            { projection: RECORD_STATS_PROJECTION }
        ).toArray();
        for (const record of pending) {
            if (!record.gameId) continue;
            out.records++;
            out.failed += await applyPendingStats(record, { users, gameRecords });
        }
        if (out.records > 0) {
            authLogger.info('Resumed pending game stats', out);
            invalidateLeaderboard();
            invalidateRecords();
        }
    } catch (error) {
        authLogger.error('Could not resume pending game stats', { error: error.message });
    }
    return out;
}

/**
 * Deploy survival (LIVE_PERSIST=on; server/game/persist/adopt.js): the
 * gameRecords document of a game another process ended, read from its
 * ENDED tombstone (that process was killed before its insert was
 * acknowledged). Steps 1 and 2 of writeGameStats on that same document:
 * insertGameRecord (read first, E11000 means it raced in: either way the
 * stored entry wins, so the game is recorded once) then applyPendingStats
 * (the per-user statsGames guard keeps each player's stats single). Never
 * rejects.
 * @param {Object} record - buildGameEndRecord's document, as the tombstone holds it
 * @returns {Promise<boolean>} true once the record is in gameRecords (inserted or found)
 */
async function recordEndedGame(record) {
    const users = getUsersCollection();
    const gameRecords = getGameRecordsCollection();
    if (!gameRecords || !record || typeof record.gameId !== 'string') return false;
    let stored;
    try {
        stored = await insertGameRecord(gameRecords, record);
    } catch (error) {
        authLogger.error('Error recording an ended game from its tombstone', { gameId: record.gameId, error: error.message });
        return false;
    }
    try {
        if (users) await applyPendingStats(stored, { users, gameRecords, fresh: stored === record });
    } catch (error) {
        authLogger.error('Error applying an ended game\'s stats from its tombstone', { gameId: record.gameId, error: error.message });
    } finally {
        invalidateLeaderboard();
        invalidateRecords();
    }
    return true;
}

/** Tests only: retry delays (default 1, 2, 4, 8, 16 s); no argument restores them. */
function _setStatsRetryDelaysForTests(delays = DEFAULT_RETRY_DELAYS_MS) {
    retryDelaysMs = delays;
}

/**
 * Get user's saved profile pic from database
 * @param {string} username - Username to look up
 * @param {Object} [options]
 * @param {boolean} [options.randomFallback=true] - false: return null instead
 *   of a random pic (no username, user not found, no pic, DB error), so a
 *   caller running lookups in parallel can draw the random pics itself in a
 *   fixed order
 * @returns {Promise<number|string|null>} Profile pic number (stock), custom
 *   pic data URL, or random (null when randomFallback is false) if not set
 */
async function getUserProfilePic(username, { randomFallback = true } = {}) {
    const usersCollection = getUsersCollection();

    if (!username) {
        authLogger.warn('getUserProfilePic called with no username, returning random pic');
        return randomFallback ? randomStockPic() : null;
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
    return randomFallback ? randomStockPic() : null;
}

/** Leaderboard row fields every scope reads. */
const LEADERBOARD_FIELDS = { username: 1, profilePic: 1, customProfilePic: 1 };
const NOT_MERGED = { mergedInto: { $exists: false } };

/**
 * Games a player needs in a scope before they get a ranked leaderboard row
 * there (one lucky win shouldn't top the board). Players below it still
 * count toward that scope's Population row; records and profiles ignore it.
 * The same number as SUPERLATIVE_MIN_GAMES, by definition: the All Time
 * account superlatives are meant to be won by the ranked leaderboard players
 * (owner 2026-11-24), so the two minimums are one constant.
 */
const LEADERBOARD_MIN_GAMES = SUPERLATIVE_MIN_GAMES;
let leaderboardMinGames = LEADERBOARD_MIN_GAMES;

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
 * The All Time superlatives' accounts (utils/superlatives.js, the `account`
 * titles: the leaderboard's Set % and avg HSI), per scope: the leaderboard's
 * users (LEADERBOARD_QUERIES: never a tombstone, so never a merged-away or
 * deleted account) and bucket, only the bucket fields those titles read.
 * human / bots read only accounts that can qualify (gamesPlayed at least
 * SUPERLATIVE_MIN_GAMES in that bucket); 'all' sums two buckets, so it
 * takes the leaderboard's filter and superlatives.js checks the sum. Like
 * the leaderboard's read, no index: one small document per account, read
 * once per records fill (the 60 s per-scope cache).
 */
const accountFields = (...buckets) => Object.fromEntries(buckets.flatMap((b) => ACCOUNT_FIELDS.map((f) => [`${b}.${f}`, 1])));
const SUPERLATIVE_ACCOUNT_QUERIES = {
    human: {
        filter: { 'stats.gamesPlayed': { $gte: SUPERLATIVE_MIN_GAMES }, ...NOT_MERGED },
        projection: { _id: 0, username: 1, ...accountFields('stats') }
    },
    bots: {
        filter: { 'botStats.gamesPlayed': { $gte: SUPERLATIVE_MIN_GAMES }, ...NOT_MERGED },
        projection: { _id: 0, username: 1, ...accountFields('botStats') }
    },
    all: {
        filter: LEADERBOARD_QUERIES.all.filter,
        projection: { _id: 0, username: 1, ...accountFields('stats', 'botStats') }
    }
};

/**
 * accountTotals() of every account SUPERLATIVE_ACCOUNT_QUERIES reads for
 * `scope`, or null (no users collection, or the read failed: logged, and
 * the All Time titles fall back to the records, so the records page still
 * answers).
 */
async function superlativeAccounts(scope) {
    try {
        const usersCollection = getUsersCollection();
        if (!usersCollection) throw new Error('no users collection');
        const query = SUPERLATIVE_ACCOUNT_QUERIES[scope] || SUPERLATIVE_ACCOUNT_QUERIES.human;
        const bucket = (LEADERBOARD_QUERIES[scope] || LEADERBOARD_QUERIES.human).bucket;
        const users = await usersCollection.find(query.filter, { projection: query.projection }).toArray();
        return users.map((user) => accountTotals(user.username, bucket(user)));
    } catch (error) {
        authLogger.error('Could not read the accounts for the All Time superlatives', { scope, error: error.message });
        return null;
    }
}

/**
 * The leaderboard rows (one per player with at least LEADERBOARD_MIN_GAMES
 * games in `scope`, plus the Population average row over every player with
 * a game there), sorted by win rate. Cached
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

    // Population averages over everyone with a game in this scope; only
    // players with LEADERBOARD_MIN_GAMES or more get a row of their own
    const everyone = leaderboard;
    const rows = everyone.filter(p => p.gamesPlayed >= leaderboardMinGames);
    if (everyone.length > 0) {
        const n = everyone.length;
        const sum = (key) => everyone.reduce((acc, p) => acc + p[key], 0);
        rows.push({
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
    rows.sort((a, b) => b.winRate - a.winRate);

    // Rows with customProfilePic null plus avatarUrls {username: url}
    // (V1_REMOVALS #19 B: no inline picture), cached together
    return avatarWire.mapProfileRows(rows);
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
 * (additive) for a custom picture whose rendition exists, `scope` when
 * asked for one, and `badges` (the player's earned badges, whatever the
 * scope) for a socket with the clientHello cap `badges`.
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
            stats: profileStats(dbUser, scope),
            // The tournament history (additive 2026-11-25; every scope the same)
            ...(await tournamentProfile(dbUser.username))
        }
    };
    if (r.url) out.avatarUrl = r.url;
    // Badges (additive, 2026-11-25): the ones this player has earned, only
    // to a client that shows them (cap `badges`). Never the unearned ones
    if (hasCap(socket, badgeAwards.BADGES_CAP)) out.badges = badgeRules.publicBadges(dbUser.badges);
    return withScope(out, scope, echo);
}

/** A profile with no tournament history (also what a failed read gives). */
const NO_TOURNAMENTS = Object.freeze({ played: 0, won: 0, recent: [] });

/**
 * The profile's tournament history (owner 2026-11-25, additive, the same in
 * every stats scope: a tournament is not a game): `tournaments {played,
 * won, recent}` (finished: the player was a member when its last round
 * completed; won: one of its score winners, ties included; recent: the
 * last RECENT_RESULTS, newest first, server/game/tournamentRecord.js
 * recentResult) and `cutForABuck {wins, played}` (cuts won, cuts taken
 * part in). Five indexed reads in parallel on tournamentRecords; a failure
 * (or no collection yet) gives zeros and a warning, never a failed profile.
 * Clients show the section only when played > 0.
 */
async function tournamentProfile(username) {
    const coll = database.getTournamentRecordsCollection?.();
    const empty = () => ({ tournaments: { ...NO_TOURNAMENTS, recent: [] }, cutForABuck: { wins: 0, played: 0 } });
    if (!coll || typeof username !== 'string') return empty();
    try {
        const [played, won, cutWins, cutPlayed, recent] = await Promise.all([
            coll.countDocuments({ players: username }),
            coll.countDocuments({ winners: username }),
            coll.countDocuments({ 'cut.winner': username }),
            coll.countDocuments({ 'cut.participants': username }),
            coll.find({ players: username }, { projection: { name: 1, completedAt: 1, totalRounds: 1, players: 1, scoreboard: 1, winners: 1, cut: 1 } })
                .sort({ completedAt: -1 })
                .limit(RECENT_RESULTS)
                .toArray()
        ]);
        return {
            tournaments: { played, won, recent: recent.map((doc) => recentResult(doc, username)) },
            cutForABuck: { wins: cutWins, played: cutPlayed }
        };
    } catch (error) {
        authLogger.warn('Tournament history read failed; the profile shows none', { username, error: error.message });
        return empty();
    }
}

/**
 * How a name goes into a NEW tournament record: '[deleted]' for an account
 * deleted meanwhile (this process's deletedUsernames, or its name hold in
 * users), an account renamed or merged meanwhile by the name it has now
 * (one hop: renames and merges re-point older tombstones), else as is.
 * The admin rename / merge / delete rewrite stored records the same way
 * (server/admin/tournamentRecordNames.js), so a record written after one
 * of them agrees with the records written before it.
 */
async function recordRenamer(names) {
    const map = new Map();
    const users = getUsersCollection();
    if (users && names.length > 0) {
        const docs = await users.find(
            { username: { $in: names }, mergedInto: { $exists: true } },
            { projection: { username: 1, mergedInto: 1 } }
        ).toArray();
        for (const d of docs) if (typeof d.mergedInto === 'string' && d.mergedInto) map.set(d.username, d.mergedInto);
    }
    return (name) => {
        if (gameManager.deletedUsernames?.has(name)) return DELETED_NAME;
        return map.get(name) ?? name;
    };
}

/**
 * Write the tournament's record (tournamentRecords, the tournament
 * history), once per tournament: `_id` is the tournamentId, so a second
 * call (the adoption of a 'complete' doc after a restore, a replay) is
 * E11000, logged as already recorded. Transient failures retry
 * (withRetry, as the end-of-game writes); the last failure is logged.
 * Never throws. On a new record every scope of the records cache is
 * invalidated (Lucky Buck). Tracked for the shutdown drain.
 * Not called for a tournament cancelled before its last round or one
 * everyone left before it ended (deleted, never 'complete').
 * @param {import('../game/TournamentState')} tournament
 * @param {{winner, participants, rounds}|null} cut
 * @returns {Promise<'recorded'|'duplicate'|null>}
 */
function recordTournament(tournament, cut) {
    const tid = tournament?.tournamentId;
    const run = (async () => {
        const coll = database.getTournamentRecordsCollection?.();
        if (!coll) {
            authLogger.warn('Tournament not recorded: no database', { tournamentId: tid });
            return null;
        }
        if (!tournament || tournament.phase !== 'complete') return null;
        try {
            return await withRetry('tournamentRecord', tid, async () => {
                const rename = await recordRenamer(recordNames(tournament, cut));
                const doc = buildTournamentRecord(tournament, cut, { rename });
                if (!doc) return null;
                try {
                    await coll.insertOne(doc);
                } catch (error) {
                    if (!isDuplicateKey(error)) throw error;
                    authLogger.info('Tournament already recorded', { tournamentId: tid });
                    return 'duplicate';
                }
                invalidateRecords();
                authLogger.info('Tournament recorded', { tournamentId: tid, players: doc.players.length, cut: Boolean(doc.cut) });
                return 'recorded';
            });
        } catch (error) {
            authLogger.error('Tournament record failed', { tournamentId: tid, error: error.message });
            return null;
        }
    })();
    return trackInFlight(run);
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
    // Every answer echoes the query as sent (additive 2026-11-15): web
    // search-as-you-type drops a reply to an older query (they can finish
    // out of order); the iOS Players sheet does the same (2026-11-27)
    const echo = { query };

    // No username is longer than 50 characters, so a longer query matches
    // nobody: answer without a DB round trip
    if (query.trim().length > MAX_USERNAME_LENGTH) {
        socket.emit('searchPlayersResponse', { success: true, players: [], ...echo });
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
        const reply = { success: true, players, ...echo };
        if (mapped.avatarUrls) reply.avatarUrls = mapped.avatarUrls;

        socket.emit('searchPlayersResponse', reply);
        authLogger.debug('Player search', { query: query.trim(), resultCount: players.length });
    } catch (error) {
        authLogger.error('Error searching players', { query, error: error.message });
        socket.emit('searchPlayersResponse', { success: false, message: 'Database error', ...echo });
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

// Only the fields the reduction below reads: the team records, plus what
// the superlatives read (utils/superlatives.js: the five per-seat counters
// they use, not the whole byPosition; seat names, bags, /help uses) and
// completedAt (they are routed to their periods from the allTime find)
const RECORDS_PROJECTION = {
    _id: 0, team1Score: 1, team2Score: 1, team1Players: 1, team2Players: 1, team1Bags: 1, team2Bags: 1,
    completedAt: 1, ...SUPERLATIVES_PROJECTION
};
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
 * bags for all time, this year and this month, plus the total game count
 * (`totalGames`, all time, as every shipped client reads it) and the game
 * count of each period (`periodGames`, additive 2026-11-14: the games each
 * period's records were drawn from, so a client can show the count of the
 * period on screen).
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
 *
 * Superlatives (2026-11-20, utils/superlatives.js): each non-null period
 * also carries `superlatives` [{id, title, names, detail}], from players
 * with SUPERLATIVE_MIN_GAMES games there (per-seat titles: games with
 * per-seat counters). All Time's Lucky Duck, Cursed and Delusions of
 * Grandeur come from the account totals instead (superlativeAccounts,
 * 2026-11-24: the leaderboard's avg HSI and Set %), read alongside the
 * finds. The record-based ones do not depend on order, so
 * they take ONE pass over the allTime documents (same scope filter), each
 * also added to thisYear / thisMonth when its completedAt is a Date on or
 * after that period's start: exactly the period finds' `$gte` (a Date
 * bound never matches another type), without adding the same documents
 * again from the overlapping period arrays.
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
    const [totalGames, accounts, cuts, ...results] = await Promise.all([
        gameRecordsCollection.countDocuments({ ...base }),
        superlativeAccounts(scope),
        cutRecords(),
        ...periods.map(period => gameRecordsCollection.find(filters[period], { projection }).toArray())
    ]);

    const records = {};
    const periodGames = {};

    // All Time: the account titles from the account totals (the
    // leaderboard's numbers), the rest from the records
    const superlatives = Object.fromEntries(periods.map((period) => [period, createSuperlatives({
        minGames: SUPERLATIVE_MIN_GAMES, accounts: period === 'allTime' ? accounts : null
    })]));
    for (const game of results[periods.indexOf('allTime')]) {
        superlatives.allTime.add(game);
        const at = game.completedAt;
        if (!(at instanceof Date)) continue;
        if (at >= startOfYear) superlatives.thisYear.add(game);
        if (at >= startOfMonth) superlatives.thisMonth.add(game);
    }
    // Lucky Buck: the Cut for a buck results, by the tournament's completedAt
    // (the same periods; a cut is not a game, so every scope reads them all)
    for (const record of cuts) {
        superlatives.allTime.addCut(record);
        const at = record.completedAt;
        if (!(at instanceof Date)) continue;
        if (at >= startOfYear) superlatives.thisYear.addCut(record);
        if (at >= startOfMonth) superlatives.thisMonth.addCut(record);
    }

    for (let p = 0; p < periods.length; p++) {
        const period = periods[p];
        const games = results[p];
        periodGames[period] = games.length;

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

        records[period] = { highestScore, lowestScore, biggestWin, mostBags, leastBags, superlatives: superlatives[period].result() };
    }

    return { records, totalGames, periodGames };
}

/**
 * Every tournament record with a Cut for a buck result (Lucky Buck), only
 * the fields it reads. A failed read (or no collection) leaves Lucky Buck
 * out with a warning; the rest of the records page is unaffected.
 */
async function cutRecords() {
    const coll = database.getTournamentRecordsCollection?.();
    if (!coll) return [];
    try {
        return await coll.find({ cut: { $ne: null } }, { projection: CUT_PROJECTION }).toArray();
    } catch (error) {
        authLogger.warn('Cut for a buck results read failed; Records shows no Lucky Buck', { error: error.message });
        return [];
    }
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
    const toPayload = ({ records, totalGames, periodGames }) => withScope({ success: true, records, totalGames, periodGames }, scope, echo);

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
/**
 * Tests only: rank players from `n` games (1 = every player with a game,
 * the board before the minimum); no argument restores LEADERBOARD_MIN_GAMES.
 */
function _setLeaderboardMinGamesForTests(n = LEADERBOARD_MIN_GAMES) {
    leaderboardMinGames = n;
    invalidateLeaderboard();
}

/**
 * Tests only: forget this process's end-of-game chains (a killed process:
 * testUtils/persistHarness.js), so a later recordGameStats for the same
 * game starts its own chain instead of joining a dead one.
 */
function _resetStatsWritesForTests() {
    statsWrites.clear();
}

function _resetCachesForTests() {
    invalidateLeaderboard();
    invalidateRecords();
    recordsCacheKey = null;
}

module.exports = {
    invalidateLeaderboard,
    invalidateRecords,
    _resetCachesForTests,
    LEADERBOARD_MIN_GAMES,
    _setLeaderboardMinGamesForTests,
    _peekLeaderboardCache: (scope = 'human') => leaderboardCache[scope]?.peek(),
    _peekRecordsCache: (scope = 'human') => recordsCache[scope]?.peek(),
    getProfile,
    updateProfilePic,
    uploadProfilePic,
    recordGameStats,
    buildGameRecord,
    buildGameEndRecord,
    resumePendingGameStats,
    recordEndedGame,
    _setStatsRetryDelaysForTests,
    _resetStatsWritesForTests,
    STATS_GAMES_KEPT,
    STATS_GUARD_SKEW_MS,
    getUserProfilePic,
    getLeaderboard,
    searchPlayers,
    getPlayerProfile,
    getRecords,
    recordTournament,
    tournamentProfile
};
