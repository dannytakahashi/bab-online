const { MongoClient } = require("mongodb");

const mongoURI = "mongodb://mongo:roWpPIazFwKzrQZbJrOgmUETsGlXAmWS@mongodb.railway.internal:27017"//"mongodb://localhost:27017"; // ✅ Change this if using a remote database
const dbName = "yourDatabaseName"; // ✅ Change to your actual database name

let db, usersCollection;

// ✅ Function to connect to MongoDB
async function connectDB() {
    try {
        const client = await MongoClient.connect(mongoURI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });

        console.log("✅ Connected to MongoDB");
        db = client.db(dbName);
        usersCollection = db.collection("users");
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error);
    }
}

// ✅ Export database and collection references
module.exports = { connectDB, getDB: () => db, getUsersCollection: () => usersCollection };