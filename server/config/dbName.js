/**
 * Which MongoDB database the server and the owner-run scripts use: the
 * DB_NAME variable, else 'babonline' (production has no DB_NAME, so it keeps
 * 'babonline'). A database named in MONGO_URI's path is never used: the
 * server logs a warning and the scripts' "Database:" line says so, because
 * silently following the path would let a leftover URI pick the database.
 * No requires: server/database.js, server/admin/cli.js and dbBackup.js all
 * read it.
 */

'use strict';

const DEFAULT_DB_NAME = 'babonline';

// MongoDB database names: no / \ . " $ space; the same subset dbBackup takes
const isValidDbName = (name) => typeof name === 'string' && /^[A-Za-z0-9_-]{1,63}$/.test(name);

/**
 * DB_NAME from `env` (trimmed), else the default. A value that is not a
 * plain database name throws: a typo must stop the boot, not write elsewhere.
 */
function dbNameFrom(env = process.env) {
    const raw = env.DB_NAME;
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_DB_NAME;
    const name = String(raw).trim();
    if (!isValidDbName(name)) {
        throw new Error('DB_NAME must be a plain database name (letters, digits, _ and -, at most 63)');
    }
    return name;
}

/** The database named in a mongodb:// or mongodb+srv:// URI's path, or '' (none, or not a URI). */
function uriPathDb(uri) {
    const m = /^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^?#]*)/.exec(String(uri || '').trim());
    if (!m) return '';
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}

module.exports = { DEFAULT_DB_NAME, isValidDbName, dbNameFrom, uriPathDb };
