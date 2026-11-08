require("dotenv").config();
const { MongoClient } = require("mongodb");
const { dbLogger } = require("./utils/logger");

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/babonline';
const dbName = "babonline";

let db, usersCollection, gameRecordsCollection, reportsCollection;

/**
 * Connect to MongoDB
 */
async function connectDB() {
    try {
        const client = await MongoClient.connect(mongoURI);

        dbLogger.info("Connected to MongoDB");
        db = client.db(dbName);
        usersCollection = db.collection("users");
        gameRecordsCollection = db.collection("gameRecords");
        reportsCollection = db.collection("reports");
        await gameRecordsCollection.createIndex({ completedAt: -1 });
        await reportsCollection.createIndex({ createdAt: -1 });
        await ensureUsernameIndex(usersCollection);
    } catch (error) {
        dbLogger.error("MongoDB connection failed", { error: error.message });
    }
}

/**
 * Unique index on users.username: every per-user lookup is by username, and
 * it makes signUp's check-then-insert race-safe (the loser gets E11000).
 * Idempotent. If legacy data already holds duplicate usernames the build
 * fails; that must not take startup down, so warn and run without it.
 */
async function ensureUsernameIndex(collection) {
    try {
        await collection.createIndex({ username: 1 }, { unique: true });
    } catch (error) {
        dbLogger.warn("Could not create unique index on users.username; continuing without it. " +
            "Remove the duplicate username documents and restart to enable it.",
            { error: error.message, code: error.code });
    }
}

// ✅ Export database and collection references
module.exports = {
    connectDB,
    ensureUsernameIndex,
    getDB: () => db,
    getUsersCollection: () => usersCollection,
    getGameRecordsCollection: () => gameRecordsCollection,
    getReportsCollection: () => reportsCollection
};