/**
 * Shared plumbing for the admin scripts in scripts/: connect to MongoDB using
 * the same MONGO_URI as the server, show which database is targeted, and ask
 * for confirmation before writing.
 */

require('dotenv').config();
const readline = require('readline');

const DEFAULT_URI = 'mongodb://localhost:27017/babonline';
const DB_NAME = 'babonline';

/** "mongodb+srv://user:secret@host/db" → "mongodb+srv://user:***@host/db" */
function redactUri(uri) {
    return uri.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
}

async function connect() {
    const { MongoClient } = require('mongodb');
    const uri = process.env.MONGO_URI || DEFAULT_URI;
    const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const db = client.db(DB_NAME);
    return {
        client,
        uri: redactUri(uri),
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

module.exports = { connect, confirm, redactUri };
