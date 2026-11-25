require("dotenv").config();
const { MongoClient } = require("mongodb");
const { dbLogger } = require("./utils/logger");

const { dbNameFrom, uriPathDb } = require("./config/dbName");

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017';
// DB_NAME, else 'babonline' (server/config/dbName.js); never MONGO_URI's path.
// An invalid DB_NAME throws here, so the boot stops before writing anywhere
const dbName = dbNameFrom();

let db, usersCollection, gameRecordsCollection, reportsCollection;
// Admin panel (server/admin/): one-time reset links and the audit log
let passwordResetsCollection, adminAuditCollection;
// Deploy survival (server/game/persist/liveStore.js; LIVE_PERSIST): live
// games and tournaments, and one document per server process
let liveGamesCollection, liveTournamentsCollection, serverInstancesCollection;
// The tournament history (2026-11-25): one document per completed
// tournament (profileHandlers.recordTournament, server/game/tournamentRecord.js)
let tournamentRecordsCollection;
// Whether gameRecords has its UNIQUE gameId index (ensureGameIdIndex may
// have fallen back to a non-unique one): null until probed. /health
// persist.uniqueGameIdIndex; a precondition for LIVE_PERSIST=on
let gameIdIndexUnique = null;

// Resolved once the collections are assigned (see whenReady)
let resolveReady;
const readyPromise = new Promise(resolve => { resolveReady = resolve; });

const sleep = (ms) => new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    // The HTTP server keeps the process alive; a pending retry must not
    t.unref?.();
});

// How long any operation waits for a usable server before it rejects (the
// driver default is 30 s). During an outage a DB-awaiting step (draw
// screen pictures, game-end stats) then fails in ~5 s and play goes on;
// each connectDB attempt also gives up after 5 s before its backoff.
const SERVER_SELECTION_TIMEOUT_MS = 5000;
const CLIENT_OPTIONS = Object.freeze({ serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });

// Whether the driver currently sees a writable server, from its own
// topology events (no round trip): /health reads it on every request
let dbReachable = false;

function watchTopology(client) {
    dbReachable = true;
    if (typeof client?.on !== 'function') return;
    client.on('topologyDescriptionChanged', (event) => {
        const servers = event?.newDescription?.servers;
        if (!servers) return;
        const reachable = [...servers.values()].some(s => s.isWritable);
        if (reachable === dbReachable) return;
        dbReachable = reachable;
        if (reachable) dbLogger.info("MongoDB reachable again");
        else dbLogger.warn("MongoDB unreachable (driver sees no writable server)");
    });
}

/** 'connected' once connectDB has connected and the driver sees a writable server, else 'disconnected'. */
function getDbState() {
    return db && dbReachable ? 'connected' : 'disconnected';
}

/**
 * Connect to MongoDB. Runs fire-and-forget after listen() (server/index.js):
 * it retries with backoff (2 s, 4 s, ... capped at 30 s) until it connects,
 * then assigns the collections, resolves whenReady() and builds the indexes.
 * An index failure is logged per index and never blocks or fails startup.
 * Resolves only on a real connect.
 */
async function connectDB() {
    let client;
    for (let attempt = 0; ; attempt++) {
        try {
            client = await MongoClient.connect(mongoURI, CLIENT_OPTIONS);
            break;
        } catch (error) {
            const retryInMs = Math.min(30000, 2000 * 2 ** attempt);
            dbLogger.error("MongoDB connection failed", { error: error.message, attempt: attempt + 1, retryInMs });
            await sleep(retryInMs);
        }
    }

    dbLogger.info("Connected to MongoDB", { database: dbName });
    const pathDb = uriPathDb(mongoURI);
    if (pathDb && pathDb !== dbName) {
        // (the driver still takes the path as the auth database when the URI has credentials)
        dbLogger.warn("MONGO_URI path names another database; the data goes to DB_NAME (or the default)", { uriDatabase: pathDb, database: dbName });
    }
    watchTopology(client);
    db = client.db(dbName);
    usersCollection = db.collection("users");
    gameRecordsCollection = db.collection("gameRecords");
    reportsCollection = db.collection("reports");
    passwordResetsCollection = db.collection("passwordResets");
    adminAuditCollection = db.collection("adminAudit");
    liveGamesCollection = db.collection("liveGames");
    liveTournamentsCollection = db.collection("liveTournaments");
    serverInstancesCollection = db.collection("serverInstances");
    tournamentRecordsCollection = db.collection("tournamentRecords");
    resolveReady();

    try {
        await ensureIndexes();
    } catch (error) {
        // ensureIndexes never rejects; belt and braces so connectDB resolves
        dbLogger.warn("Index setup failed; continuing", { error: error.message });
    }
}

/**
 * Wait up to `ms` for connectDB to assign the collections (cold start: a
 * reconnect storm right after a deploy can arrive before Mongo answers).
 * @returns {Promise<boolean>} true once ready, false on timeout
 */
function whenReady(ms) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
    });
    return Promise.race([readyPromise.then(() => true), timeout])
        .finally(() => clearTimeout(timer));
}

/**
 * createIndex that never throws: an existing identical index is a no-op,
 * anything else (permissions, conflicting options, an old server) is logged
 * and startup continues without that index.
 */
async function safeIndex(collection, keys, options, label) {
    try {
        await collection.createIndex(keys, options);
    } catch (error) {
        dbLogger.warn(`Could not create index ${label}; continuing`, { code: error.code, error: error.message });
    }
}

/**
 * Every startup index, built independently (one failure does not stop the
 * others). Idempotent; uses only createIndex (MongoDB 4.0+).
 */
async function ensureIndexes({
    users = usersCollection,
    gameRecords = gameRecordsCollection,
    reports = reportsCollection,
    passwordResets = passwordResetsCollection,
    adminAudit = adminAuditCollection,
    liveGames = liveGamesCollection,
    liveTournaments = liveTournamentsCollection,
    serverInstances = serverInstancesCollection,
    tournamentRecords = tournamentRecordsCollection
} = {}) {
    return Promise.allSettled([
        safeIndex(gameRecords, { completedAt: -1 }, {}, 'gameRecords.completedAt_-1'),
        ensureGameIdIndex(gameRecords).then(() => probeGameIdIndex(gameRecords)),
        // The startup sweep's lookup (profileHandlers.resumePendingGameStats):
        // only records whose stats are not applied yet are in it
        safeIndex(gameRecords, { statsPending: 1 },
            { name: 'statsPending_partial', partialFilterExpression: { statsPending: { $exists: true } } },
            'gameRecords.statsPending_partial'),
        safeIndex(reports, { createdAt: -1 }, {}, 'reports.createdAt_-1'),
        ensureUsernameIndex(users),
        // A deleted account's name hold (server/admin/accountDelete.js)
        // goes when its nameHeldUntil passes; only holds carry the field
        safeIndex(users, { nameHeldUntil: 1 }, { expireAfterSeconds: 0 }, 'users.nameHeldUntil_1 (TTL)'),
        ...adminIndexes({ users, passwordResets, adminAudit }),
        ...liveIndexes({ liveGames, liveTournaments, serverInstances }),
        ...tournamentRecordIndexes(tournamentRecords)
    ]);
}

/**
 * The tournament history (tournamentRecords, `_id` = the tournamentId, so
 * a second insert of one tournament is E11000): newest first (the
 * profile's recent results by player, the Records page's Lucky Buck by
 * completedAt), and the profile's counts (played, won, Cut for a buck
 * wins and cuts played) each on its own index. A caller that did not pass
 * the collection (tests) is skipped.
 */
function tournamentRecordIndexes(tournamentRecords) {
    if (!tournamentRecords) return [];
    return [
        safeIndex(tournamentRecords, { completedAt: -1 }, {}, 'tournamentRecords.completedAt_-1'),
        safeIndex(tournamentRecords, { players: 1, completedAt: -1 }, {}, 'tournamentRecords.players_1_completedAt_-1'),
        safeIndex(tournamentRecords, { winners: 1 }, {}, 'tournamentRecords.winners_1'),
        safeIndex(tournamentRecords, { 'cut.winner': 1 }, {}, 'tournamentRecords.cut.winner_1'),
        safeIndex(tournamentRecords, { 'cut.participants': 1 }, {}, 'tournamentRecords.cut.participants_1')
    ];
}

/**
 * Deploy survival's collections (server/game/persist/liveStore.js; built
 * whatever LIVE_PERSIST says, so they are there before it is set):
 * liveGames and liveTournaments by owner and released (handoff and
 * adoption), a TTL on expireAt (each doc's createdAt + 24 h: at most a
 * day, whatever happens to the process), and liveTournaments by member
 * (state.players.username: a returning member's tournament);
 * serverInstances expire a day after their last heartbeat. A collection
 * a caller did not pass (scripts/restore-db.js, tests) is skipped.
 */
const LIVE_INSTANCE_TTL_SEC = 24 * 60 * 60;
function liveIndexes({ liveGames, liveTournaments, serverInstances }) {
    const out = [];
    for (const [name, coll] of [['liveGames', liveGames], ['liveTournaments', liveTournaments]]) {
        if (!coll) continue;
        out.push(
            safeIndex(coll, { released: 1 }, {}, `${name}.released_1`),
            safeIndex(coll, { owner: 1 }, {}, `${name}.owner_1`),
            safeIndex(coll, { expireAt: 1 }, { expireAfterSeconds: 0 }, `${name}.expireAt_1 (TTL)`)
        );
    }
    if (liveTournaments) {
        out.push(safeIndex(liveTournaments, { 'state.players.username': 1 }, {}, 'liveTournaments.state.players.username_1'));
    }
    if (serverInstances) {
        out.push(safeIndex(serverInstances, { beatAt: 1 }, { expireAfterSeconds: LIVE_INSTANCE_TTL_SEC }, 'serverInstances.beatAt_1 (TTL)'));
    }
    return out;
}

/**
 * Read back whether gameRecords has a UNIQUE index on exactly {gameId: 1}
 * (getGameIdIndexUnique). Never throws: a collection that cannot list its
 * indexes leaves the answer null (unknown).
 * @returns {Promise<boolean|null>}
 */
async function probeGameIdIndex(collection) {
    let unique = null;
    try {
        if (collection && typeof collection.indexes === 'function') {
            const indexes = await collection.indexes();
            unique = indexes.some(i => i.unique === true && i.key
                && Object.keys(i.key).length === 1 && i.key.gameId === 1);
        }
    } catch (error) {
        unique = null;
    }
    if (collection === gameRecordsCollection) gameIdIndexUnique = unique;
    return unique;
}

/**
 * The admin panel's indexes (server/admin/). passwordResets: the token
 * lookup (unique hash), at most ONE open link per player (partial unique:
 * a second admin's concurrent link loses with E11000 and revokes again,
 * passwordReset.createResetLink), and a TTL that drops a link 7 days after
 * it expired. adminAudit: newest first. users: the (few) admins.
 * A collection a caller did not pass (tests) is skipped.
 */
const RESET_TTL_GRACE_SEC = 7 * 24 * 60 * 60;
function adminIndexes({ users, passwordResets, adminAudit }) {
    const out = [];
    if (passwordResets) {
        out.push(
            safeIndex(passwordResets, { tokenHash: 1 }, { unique: true }, 'passwordResets.tokenHash_1'),
            safeIndex(passwordResets, { username: 1 },
                { name: 'username_open_unique', unique: true, partialFilterExpression: { state: 'open' } },
                'passwordResets.username_open_unique'),
            safeIndex(passwordResets, { expiresAt: 1 }, { expireAfterSeconds: RESET_TTL_GRACE_SEC }, 'passwordResets.expiresAt_1 (TTL)')
        );
    }
    if (adminAudit) out.push(safeIndex(adminAudit, { at: -1, _id: -1 }, {}, 'adminAudit.at_-1__id_-1'));
    if (users) {
        out.push(safeIndex(users, { isAdmin: 1 }, { name: 'isAdmin_partial', partialFilterExpression: { isAdmin: true } }, 'users.isAdmin_partial'));
    }
    return out;
}

/** Non-unique stand-in while legacy duplicates block the unique index. */
const USERNAME_FALLBACK_INDEX = 'username_nonunique';
/** The same for gameRecords.gameId. */
const GAME_ID_FALLBACK_INDEX = 'gameId_nonunique';

/**
 * A unique index that legacy duplicates must not take startup down with.
 * Drops `fallbackName` first (a previous boot's stand-in), then builds the
 * unique index; on E11000 (existing duplicates) warns and builds a
 * NON-unique index under `fallbackName`, so lookups stay on an index until
 * the duplicates are removed and a later boot retries. Never throws.
 */
async function ensureUniqueWithFallback(collection, { keys, options = {}, fallbackName, label, warning }) {
    try {
        const existing = await collection.indexes();
        if (existing.some(i => i.name === fallbackName)) {
            await collection.dropIndex(fallbackName);
        }
    } catch (error) {
        // No collection yet (NamespaceNotFound): nothing to drop
        if (error.code !== 26 && !(error instanceof TypeError)) {
            dbLogger.warn(`Could not drop index ${label}.${fallbackName}; continuing`, { error: error.message, code: error.code });
        }
    }
    try {
        await collection.createIndex(keys, { ...options, unique: true });
    } catch (error) {
        dbLogger.warn(warning, { error: error.message, code: error.code });
        if (error.code === 11000) {
            await safeIndex(collection, keys, { name: fallbackName },
                `${label}.${fallbackName} (non-unique fallback)`);
        }
    }
}

/**
 * Unique index on users.username: every per-user lookup is by username, and
 * it makes signUp's check-then-insert race-safe (the loser gets E11000).
 * Idempotent. If legacy data already holds duplicate usernames the build
 * fails; that must not take startup down, so warn and continue with a
 * NON-unique index under its own name, so lookups and the active-game
 * writes still use an index (IXSCAN) until the duplicates are merged. On a
 * later boot the fallback is dropped first and the unique build retried
 * (and the fallback rebuilt if it still fails). Never throws.
 */
function ensureUsernameIndex(collection) {
    return ensureUniqueWithFallback(collection, {
        keys: { username: 1 },
        fallbackName: USERNAME_FALLBACK_INDEX,
        label: 'users',
        warning: "Could not create unique index on users.username; continuing (with a non-unique fallback index on duplicates). " +
            "Remove the duplicate username documents and restart to enable it."
    });
}

/**
 * Unique index on gameRecords.gameId: one record per game, so a retried or
 * replayed end-of-game write (profileHandlers.recordGameStats) can never
 * insert a second one (it gets E11000 and reuses the first), and its
 * gameId lookup is an index hit. Partial ($exists, which an equality lookup
 * still uses; a $type filter would not be): records without a gameId (tests,
 * hand edits) never collide. Duplicates
 * already in the collection: warn, and a non-unique fallback, as for
 * usernames. Never throws.
 */
function ensureGameIdIndex(collection) {
    return ensureUniqueWithFallback(collection, {
        keys: { gameId: 1 },
        options: { partialFilterExpression: { gameId: { $exists: true } } },
        fallbackName: GAME_ID_FALLBACK_INDEX,
        label: 'gameRecords',
        warning: "Could not create unique index on gameRecords.gameId; continuing (with a non-unique fallback index on duplicates). " +
            "Remove the duplicate game records and restart to enable it."
    });
}

// ✅ Export database and collection references
module.exports = {
    connectDB,
    whenReady,
    ensureIndexes,
    ensureUsernameIndex,
    ensureGameIdIndex,
    USERNAME_FALLBACK_INDEX,
    GAME_ID_FALLBACK_INDEX,
    safeIndex,
    SERVER_SELECTION_TIMEOUT_MS,
    getDbState,
    getDB: () => db,
    getDbName: () => dbName,
    getUsersCollection: () => usersCollection,
    getGameRecordsCollection: () => gameRecordsCollection,
    getReportsCollection: () => reportsCollection,
    getPasswordResetsCollection: () => passwordResetsCollection,
    getAdminAuditCollection: () => adminAuditCollection,
    getLiveGamesCollection: () => liveGamesCollection,
    getLiveTournamentsCollection: () => liveTournamentsCollection,
    getServerInstancesCollection: () => serverInstancesCollection,
    getTournamentRecordsCollection: () => tournamentRecordsCollection,
    getGameIdIndexUnique: () => gameIdIndexUnique,
    probeGameIdIndex,
    LIVE_INSTANCE_TTL_SEC
};
