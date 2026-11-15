#!/usr/bin/env node
/**
 * Restore a scripts/backup-db.js archive. Owner-run (runbook:
 * docs/claude/server-infra.md, Backups and restore). Into a LOCAL mongod
 * by default; anything else needs --i-mean-production and the target
 * database name typed at the prompt.
 *
 *   node scripts/restore-db.js <archive> --uri mongodb://127.0.0.1:27017 --into-db babonline_restore_20261115
 *   node scripts/restore-db.js <archive> --uri mongodb://127.0.0.1:27017 --drop       # replace local babonline
 *   RESTORE_URI='<production URL>' node scripts/restore-db.js <archive> --i-mean-production --drop
 *
 * The target is --uri (no credentials: they would land in shell history)
 * or RESTORE_URI. MONGO_URI is never used, so an export left over from a
 * backup cannot aim a restore at production. Prints counts, never a document.
 */

const fs = require('fs');
const readline = require('readline');
const B = require('../server/admin/dbBackup');

const USAGE = `Usage:
  node scripts/restore-db.js <archive> (--uri <local uri> | RESTORE_URI=<uri>) [options]

  --db <name>           database inside the archive (default: DB_NAME from this shell, else babonline; .env is never read)
  --into-db <name>      restore under another name (mongorestore --nsFrom '<db>.*' --nsTo '<name>.*')
  --nsFrom '<db>.*' --nsTo '<name>.*'   the same, spelled as mongorestore spells it
  --drop                drop each archived collection in the target before restoring it
  --i-mean-production   allow a target that is not localhost / 127.0.0.1 / ::1 (asks you to type the database name)`;

function nsDb(pattern, flag) {
    const m = /^([A-Za-z0-9_-]{1,63})\.\*$/.exec(String(pattern || ''));
    if (!m) throw new Error(`${flag} must look like '<database>.*'`);
    return m[1];
}

function parseArgs(argv) {
    const def = B.defaultDb();
    const a = { archive: null, uri: null, db: def.db, dbFrom: def.from, intoDb: null, nsFrom: null, nsTo: null, drop: false, production: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--uri') a.uri = argv[++i];
        else if (k === '--db') { a.db = argv[++i]; a.dbFrom = '--db'; }
        else if (k === '--into-db') a.intoDb = argv[++i];
        else if (k === '--nsFrom') a.nsFrom = nsDb(argv[++i], '--nsFrom');
        else if (k === '--nsTo') a.nsTo = nsDb(argv[++i], '--nsTo');
        else if (k === '--drop') a.drop = true;
        else if (k === '--i-mean-production') a.production = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else if (k.startsWith('--')) throw new Error(`Unknown option ${k}`);
        else if (a.archive) throw new Error('Only one archive per run');
        else a.archive = k;
    }
    if (a.nsFrom || a.nsTo) {
        if (!a.nsFrom || !a.nsTo) throw new Error('--nsFrom and --nsTo go together');
        if (a.intoDb && a.intoDb !== a.nsTo) throw new Error('--into-db and --nsTo disagree');
        a.db = a.nsFrom;
        a.dbFrom = '--nsFrom';
        a.intoDb = a.nsTo;
    }
    if (!B.isValidDbName(a.db)) throw new Error('--db must be a plain database name');
    if (a.intoDb !== null && !B.isValidDbName(a.intoDb)) throw new Error('--into-db must be a plain database name');
    a.targetDb = a.intoDb || a.db;
    return a;
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        // Ctrl-C at the prompt reaches readline, not the process: treat it as "no"
        rl.on('SIGINT', () => { rl.close(); process.stdout.write('\n'); resolve(''); });
        rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); });
    });
}

async function collectionCounts(db) {
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
        .map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
    const out = [];
    for (const n of names) out.push({ name: n, count: await db.collection(n).estimatedDocumentCount() });
    return out;
}

async function indexNames(db) {
    const out = {};
    for (const { name } of await collectionCounts(db)) {
        out[name] = (await db.collection(name).indexes()).map((i) => i.name).sort();
    }
    return out;
}

// Counts only: enough to tell a usable restore from an empty or mangled one
async function sanity(db) {
    const users = db.collection('users');
    const accounts = { mergedInto: { $exists: false } };
    return {
        users: await users.countDocuments({}),
        tombstones: await users.countDocuments({ mergedInto: { $exists: true } }),
        noUsername: await users.countDocuments({ $or: [{ username: { $exists: false } }, { username: { $not: { $type: 'string' } } }] }),
        noHash: await users.countDocuments({ ...accounts, password: { $not: /^\$2[aby]\$\d{2}\$/ } }),
        withSessions: await users.countDocuments({ ...accounts, 'sessionTokens.0': { $exists: true } }),
        withStats: await users.countDocuments({ 'stats.gamesPlayed': { $gt: 0 } }),
        withBotStats: await users.countDocuments({ 'botStats.gamesPlayed': { $gt: 0 } }),
        newestGame: (await db.collection('gameRecords').find({}, { projection: { completedAt: 1 } })
            .sort({ completedAt: -1 }).limit(1).next())?.completedAt || null
    };
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`${e.message}\n\n${USAGE}`);
        process.exit(2);
    }
    if (args.help) { console.log(USAGE); return; }
    if (!args.archive) { console.error(USAGE); process.exit(2); }
    if (!fs.existsSync(args.archive) || !fs.statSync(args.archive).isFile()) { console.error(`No such archive: ${args.archive}`); process.exit(2); }
    if (!B.looksGzip(args.archive)) { console.error(`${args.archive} is not a gzip archive from scripts/backup-db.js`); process.exit(2); }

    // Read before anything loads .env (server/database.js does, below)
    const envUri = process.env.RESTORE_URI;
    if (args.uri && B.hasCredentials(args.uri)) {
        console.error('--uri holds credentials, which would stay in your shell history. Put the URI in RESTORE_URI instead.');
        process.exit(2);
    }
    const uri = args.uri || envUri;
    if (!uri) {
        console.error(`No target. Pass --uri mongodb://127.0.0.1:<port> (a local mongod) or set RESTORE_URI.` +
            (process.env.MONGO_URI ? ' (MONGO_URI is set but never used for a restore.)' : ''));
        process.exit(2);
    }
    if (!B.parseUri(uri)) { console.error('The target is not a mongodb:// or mongodb+srv:// URI.'); process.exit(2); }

    // Loaded now, not after the restore: it reads .env, and a DB_NAME there
    // that is not a plain name throws, which must stop us before writing
    let ensureIndexes;
    try {
        ({ ensureIndexes } = require('../server/database'));
    } catch (e) {
        console.error(`Cannot load server/database.js (${e.message}); nothing written.`);
        process.exit(2);
    }

    const local = B.isLocalUri(uri);
    const target = `${B.describeHosts(uri)} (database ${args.targetDb})`;
    if (!local && !args.production) {
        console.error(`Refusing ${B.describeHosts(uri)}: not localhost / 127.0.0.1 / ::1. ` +
            'Restore into a local mongod first (runbook). For a real production restore add --i-mean-production.');
        process.exit(2);
    }
    if (!local && !process.stdin.isTTY) {
        console.error('A non-local restore needs a terminal to confirm.');
        process.exit(2);
    }

    const version = B.toolVersion('mongorestore');
    if (!version) { console.error(`mongorestore not found. ${B.TOOLS_HINT}`); process.exit(2); }

    const { MongoClient } = require('mongodb');
    const client = await MongoClient.connect(B.uriWithoutDbPath(uri), { serverSelectionTimeoutMS: 10000 });
    try {
        const db = client.db(args.targetDb);
        const existing = (await collectionCounts(db)).filter((c) => c.count > 0);

        console.log(`Archive: ${args.archive} (${B.formatBytes(fs.statSync(args.archive).size)})`);
        console.log(`From:    database ${args.db} in the archive (${args.dbFrom})`);
        console.log(`Target:  ${target}${local ? '' : '   <-- NOT LOCAL'}`);
        console.log(`Mode:    ${args.drop ? '--drop (each archived collection is dropped, then restored)' : 'insert into an empty database'}`);
        console.log(`Tool:    ${version}`);
        if (existing.length) {
            console.log(`Target already holds: ${existing.map((c) => `${c.name} ${c.count}`).join(', ')}`);
        }
        if (existing.length && !args.drop) {
            console.error('\nThe target database is not empty. Restore into a new name (--into-db) or add --drop to replace it.');
            process.exitCode = 2;
            return;
        }
        if (!local) {
            const typed = await ask(`\nThis writes to a NON-LOCAL server. Type the target database name (${args.targetDb}) to continue: `);
            if (typed !== args.targetDb) { console.error('Not confirmed; nothing written.'); process.exitCode = 1; return; }
        }

        const toolArgs = ['--gzip', `--archive=${args.archive}`, `--nsInclude=${args.db}.*`];
        if (args.targetDb !== args.db) toolArgs.push(`--nsFrom=${args.db}.*`, `--nsTo=${args.targetDb}.*`);
        if (args.drop) toolArgs.push('--drop');
        console.log('\nRestoring ...');
        const started = Date.now();
        const tool = B.runTool('mongorestore', toolArgs, B.uriWithoutDbPath(uri));
        const removeHandlers = B.onStopSignals((sig) => {
            // SIGKILL: SIGTERM can take seconds while it waits on the server, and we exit now
            if (tool.child && tool.child.exitCode === null) tool.child.kill('SIGKILL');
            console.error(`\n${sig}: mongorestore stopped; ${target} is only partly restored.`);
        });
        const result = await tool.done;
        removeHandlers();
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const summary = B.parseRestoreSummary(result.stderr);
        if (result.code !== 0 || summary.restored === null) {
            console.error(`mongorestore failed (exit ${result.code}) after ${seconds} s:`);
            console.error(B.redact(result.stderr.split('\n').filter(Boolean).slice(-15).join('\n')));
            process.exitCode = 1;
            return;
        }
        console.log(`Restored ${summary.restored} document(s), ${summary.failed} failed, in ${seconds} s.`);
        if (!summary.collections.length) {
            console.error(`The archive held no collections of database ${args.db} (wrong --db?).`);
            process.exitCode = 1;
            return;
        }

        // The server builds these on every boot anyway; doing it here makes
        // the restored database complete before anything points at it
        const before = await indexNames(db);
        await ensureIndexes({
            users: db.collection('users'),
            gameRecords: db.collection('gameRecords'),
            reports: db.collection('reports'),
            passwordResets: db.collection('passwordResets'),
            adminAudit: db.collection('adminAudit')
        });
        const after = await indexNames(db);

        console.log('\nCollections (documents)   indexes');
        const counts = await collectionCounts(db);
        const width = Math.max(...counts.map((c) => c.name.length));
        for (const c of counts) {
            const added = (after[c.name] || []).filter((n) => !(before[c.name] || []).includes(n));
            console.log(`  ${c.name.padEnd(width)}  ${String(c.count).padStart(8)}   ${(after[c.name] || []).join(', ')}` +
                (added.length ? `   (built now: ${added.join(', ')})` : ''));
        }

        const s = await sanity(db);
        console.log(`\nUsers: ${s.users} (${s.users - s.tombstones} accounts, ${s.tombstones} merged/renamed names); ` +
            `${s.withSessions} with saved sessions; ${s.withStats} with human-game stats, ${s.withBotStats} with bot-game stats`);
        console.log(`Newest game record: ${s.newestGame ? new Date(s.newestGame).toISOString() : 'none'}`);
        const problems = [];
        if (summary.failed > 0) problems.push(`${summary.failed} document(s) failed to restore`);
        // An archive taken after the accounts were lost restores "fine" otherwise
        if (!s.users) problems.push('users is empty or missing: this archive holds no accounts');
        if (s.noUsername) problems.push(`${s.noUsername} user document(s) without a username`);
        if (s.noHash) problems.push(`${s.noHash} account(s) without a bcrypt password hash`);
        if (!(after.users || []).includes('username_1')) problems.push('users has no unique username_1 index: ensureIndexes could not build it, so names are duplicated');
        if (problems.length) {
            console.error(`\nSANITY CHECK FAILED: ${problems.join('; ')}`);
            process.exitCode = 1;
        } else {
            console.log('\nSanity check passed.');
        }
    } finally {
        await client.close();
    }
}

main().catch((e) => {
    console.error(B.redact(e.message));
    process.exit(1);
});
