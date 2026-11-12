/**
 * Shared plumbing for the admin scripts in scripts/: connect to MongoDB using
 * the same MONGO_URI as the server, show which database is targeted, and ask
 * for confirmation before writing.
 */

require('dotenv').config();
const readline = require('readline');

const DEFAULT_URI = 'mongodb://localhost:27017/babonline';
const DB_NAME = 'babonline';

/** Replaces the password in a MongoDB URI with *** ("//user:<password>@" becomes "//user:***@"). */
function redactUri(uri) {
    return uri.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
}

/**
 * What the scripts print as "Database:". The scripts (like the server,
 * server/database.js) always use the `babonline` database, whatever path
 * MONGO_URI names, so show the server without its path plus the database
 * actually written: "mongodb://host:27017 (database babonline)".
 */
function describeTarget(uri, dbName = DB_NAME) {
    const server = redactUri(uri).replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)[^?]*/, '$1');
    return `${server.replace(/\?.*$/, '')} (database ${dbName})`;
}

async function connect() {
    const { MongoClient } = require('mongodb');
    const uri = process.env.MONGO_URI || DEFAULT_URI;
    const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const db = client.db(DB_NAME);
    return {
        client,
        uri: describeTarget(uri),
        db: {
            users: db.collection('users'),
            gameRecords: db.collection('gameRecords'),
            reports: db.collection('reports'),
            passwordResets: db.collection('passwordResets'),
            adminAudit: db.collection('adminAudit')
        }
    };
}

/** Resolves true only if the operator types `expected` exactly. */
function confirm(question, expected) {
    if (!process.stdin.isTTY) return Promise.resolve(false);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(`${question} Type ${expected} to continue: `, answer => {
            rl.close();
            resolve(answer.trim() === expected);
        });
    });
}

module.exports = { connect, confirm, redactUri, describeTarget, DB_NAME };
