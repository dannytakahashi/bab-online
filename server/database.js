require("dotenv").config();
const { MongoClient } = require("mongodb");
const { dbLogger } = require("./utils/logger");

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/babonline';
const dbName = "babonline";

let db, usersCollection, gameRecordsCollection, reportsCollection;
// Admin panel (server/admin/): one-time reset links and the audit log
let passwordResetsCollection, adminAuditCollection;

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

    dbLogger.info("Connected to MongoDB");
    watchTopology(client);
    db = client.db(dbName);
    usersCollection = db.collection("users");
    gameRecordsCollection = db.collection("gameRecords");
    reportsCollection = db.collection("reports");
    passwordResetsCollection = db.collection("passwordResets");
    adminAuditCollection = db.collection("adminAudit");
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
    adminAudit = adminAuditCollection
} = {}) {
    return Promise.allSettled([
        safeIndex(gameRecords, { completedAt: -1 }, {}, 'gameRecords.completedAt_-1'),
        ensureGameIdIndex(gameRecords),
        // The startup sweep's lookup (profileHandlers.resumePendingGameStats):
        // only records whose stats are not applied yet are in it
        safeIndex(gameRecords, { statsPending: 1 },
            { name: 'statsPending_partial', partialFilterExpression: { statsPending: { $exists: true } } },
            'gameRecords.statsPending_partial'),
        safeIndex(reports, { createdAt: -1 }, {}, 'reports.createdAt_-1'),
        ensureUsernameIndex(users),
        ...adminIndexes({ users, passwordResets, adminAudit })
    ]);
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
    getUsersCollection: () => usersCollection,
    getGameRecordsCollection: () => gameRecordsCollection,
    getReportsCollection: () => reportsCollection,
    getPasswordResetsCollection: () => passwordResetsCollection,
    getAdminAuditCollection: () => adminAuditCollection
};
