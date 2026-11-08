require("dotenv").config();
const { MongoClient } = require("mongodb");
const { dbLogger } = require("./utils/logger");

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/babonline';
const dbName = "babonline";

let db, usersCollection, gameRecordsCollection, reportsCollection;

// Resolved once the collections are assigned (see whenReady)
let resolveReady;
const readyPromise = new Promise(resolve => { resolveReady = resolve; });

const sleep = (ms) => new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    // The HTTP server keeps the process alive; a pending retry must not
    t.unref?.();
});

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
            client = await MongoClient.connect(mongoURI);
            break;
        } catch (error) {
            const retryInMs = Math.min(30000, 2000 * 2 ** attempt);
            dbLogger.error("MongoDB connection failed", { error: error.message, attempt: attempt + 1, retryInMs });
            await sleep(retryInMs);
        }
    }

    dbLogger.info("Connected to MongoDB");
    db = client.db(dbName);
    usersCollection = db.collection("users");
    gameRecordsCollection = db.collection("gameRecords");
    reportsCollection = db.collection("reports");
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
    reports = reportsCollection
} = {}) {
    return Promise.allSettled([
        safeIndex(gameRecords, { completedAt: -1 }, {}, 'gameRecords.completedAt_-1'),
        safeIndex(reports, { createdAt: -1 }, {}, 'reports.createdAt_-1'),
        ensureUsernameIndex(users)
    ]);
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
    getDB: () => db,
    getUsersCollection: () => usersCollection,
    getGameRecordsCollection: () => gameRecordsCollection,
    getReportsCollection: () => reportsCollection
};
