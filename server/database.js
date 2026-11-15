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
        safeIndex(reports, { createdAt: -1 }, {}, 'reports.createdAt_-1'),
        ensureUsernameIndex(users),
        // A deleted account's name hold (server/admin/accountDelete.js)
        // goes when its nameHeldUntil passes; only holds carry the field
        safeIndex(users, { nameHeldUntil: 1 }, { expireAfterSeconds: 0 }, 'users.nameHeldUntil_1 (TTL)'),
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
async function ensureUsernameIndex(collection) {
    try {
        const existing = await collection.indexes();
        if (existing.some(i => i.name === USERNAME_FALLBACK_INDEX)) {
            await collection.dropIndex(USERNAME_FALLBACK_INDEX);
        }
    } catch (error) {
        // No collection yet (NamespaceNotFound): nothing to drop
        if (error.code !== 26 && !(error instanceof TypeError)) {
            dbLogger.warn(`Could not drop index users.${USERNAME_FALLBACK_INDEX}; continuing`, { error: error.message, code: error.code });
        }
    }
    try {
        await collection.createIndex({ username: 1 }, { unique: true });
    } catch (error) {
        dbLogger.warn("Could not create unique index on users.username; continuing (with a non-unique fallback index on duplicates). " +
            "Remove the duplicate username documents and restart to enable it.",
            { error: error.message, code: error.code });
        if (error.code === 11000) {
            await safeIndex(collection, { username: 1 }, { name: USERNAME_FALLBACK_INDEX },
                `users.${USERNAME_FALLBACK_INDEX} (non-unique fallback)`);
        }
    }
}

// ✅ Export database and collection references
module.exports = {
    connectDB,
    whenReady,
    ensureIndexes,
    ensureUsernameIndex,
    USERNAME_FALLBACK_INDEX,
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
