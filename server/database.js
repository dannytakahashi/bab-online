require("dotenv").config();
const { MongoClient } = require("mongodb");

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/babonline';
const dbName = "babonline";

let db, usersCollection;

/**
 * Connect to MongoDB
 */
async function connectDB() {
    try {
        const client = await MongoClient.connect(mongoURI);

        console.log("Connected to MongoDB");
        db = client.db(dbName);
        usersCollection = db.collection("users");
    } catch (error) {
        console.error("MongoDB Connection Error:", error.message);
        // Don't log full error object as it may contain connection string
    }
}

// ✅ Export database and collection references
module.exports = { connectDB, getDB: () => db, getUsersCollection: () => usersCollection };