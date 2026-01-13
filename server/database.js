require("dotenv").config();
const { MongoClient } = require("mongodb");
const { dbLogger } = require("./utils/logger");

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/babonline';
const dbName = "babonline";

let db, usersCollection;

/**
 * Connect to MongoDB
 */
async function connectDB() {
    try {
        const client = await MongoClient.connect(mongoURI);

        dbLogger.info("Connected to MongoDB");
        db = client.db(dbName);
        usersCollection = db.collection("users");
    } catch (error) {
        dbLogger.error("MongoDB connection failed", { error: error.message });
    }
}

// ✅ Export database and collection references
module.exports = { connectDB, getDB: () => db, getUsersCollection: () => usersCollection };