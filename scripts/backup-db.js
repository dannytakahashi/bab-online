#!/usr/bin/env node
/**
 * Logical backup of the game database: one gzipped mongodump archive.
 * Owner-run, on your own machine (runbook: docs/claude/server-infra.md,
 * Backups and restore).
 *
 *   MONGO_URI='<public URL of the MongoDB service>' node scripts/backup-db.js --out ~/bab-backups
 *   ... --keep 14     # then delete all but the newest 14 archives in that folder
 *
 * MONGO_URI comes from the environment only (no .env, no default), and is
 * handed to mongodump through a pipe: never on its command line or on disk.
 * Prints per-collection counts, never a document. The archive holds every
 * password hash and session token: keep it encrypted, never in a repository.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('../server/admin/dbBackup');

const USAGE = `Usage:
  MONGO_URI=<uri> node scripts/backup-db.js --out <dir> [--keep N] [--db <name>] [--allow-no-users]

  --out <dir>        folder for the archive (created if missing; never inside a git repository)
  --keep N           after a good backup, delete all but the newest N <db>-*.archive.gz there
  --db <name>        database to dump (default: DB_NAME from this shell, else babonline; .env is never read)
  --allow-no-users   keep the archive even when <db>.users is missing or empty

  Exit: 0 ok; 1 failed, nothing kept; 2 usage; 3 archive kept but --keep pruning failed`;

function parseArgs(argv) {
    const def = B.defaultDb();
    const a = { out: null, keep: null, db: def.db, dbFrom: def.from, allowNoUsers: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') a.out = argv[++i];
        else if (k === '--keep') a.keep = argv[++i];
        else if (k === '--db') { a.db = argv[++i]; a.dbFrom = '--db'; }
        else if (k === '--allow-no-users') a.allowNoUsers = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else throw new Error(`Unknown argument ${k}`);
    }
    if (a.keep !== null) {
        if (!/^\d+$/.test(String(a.keep)) || Number(a.keep) < 1) throw new Error('--keep needs a whole number of 1 or more');
        a.keep = Number(a.keep);
    }
    // An empty dump must never push good archives out
    if (a.allowNoUsers && a.keep !== null) throw new Error('--allow-no-users cannot be combined with --keep');
    if (!B.isValidDbName(a.db)) throw new Error('--db must be a plain database name');
    return a;
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}

// Reads the whole gzip stream: a truncated or corrupt archive fails here, not at restore time
function checkGzip(file) {
    return new Promise((resolve, reject) => {
        const zlib = require('zlib');
        let bytes = 0;
        fs.createReadStream(file).pipe(zlib.createGunzip())
            .on('data', (d) => { bytes += d.length; })
            .on('end', () => resolve(bytes))
            .on('error', reject);
    });
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

    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGO_URI is not set. Set it in this shell only (see the runbook); it is never read from .env.');
        process.exit(2);
    }
    if (!B.parseUri(uri)) {
        console.error('MONGO_URI is not a mongodb:// or mongodb+srv:// URI.');
        process.exit(2);
    }
    const out = B.checkOutDir(args.out);
    if (out.error) { console.error(`${out.error}\n\n${USAGE}`); process.exit(2); }

    const version = B.toolVersion('mongodump');
    if (!version) { console.error(`mongodump not found. ${B.TOOLS_HINT}`); process.exit(2); }

    // Everything this run creates is private to the owner from the first byte
    process.umask(0o077);
    fs.mkdirSync(out.dir, { recursive: true, mode: 0o700 });

    const name = B.archiveName(args.db);
    const final = path.join(out.dir, name);
    const partial = `${final}.partial`;
    // Names have one-second resolution: never overwrite an earlier archive,
    // and claim the .partial atomically so two runs cannot share it
    if (fs.existsSync(final)) {
        console.error(`${final} already exists (another backup this second?). Run again in a moment.`);
        process.exit(2);
    }
    try {
        fs.closeSync(fs.openSync(partial, 'wx', 0o600));
    } catch (e) {
        console.error(e.code === 'EEXIST' ? `${partial} exists: another backup is running into this folder.` : e.message);
        process.exit(2);
    }

    console.log(`Source:  ${B.describeHosts(uri)} (database ${args.db}; ${args.dbFrom})`);
    console.log(`Tool:    ${version}`);
    console.log(`Dumping to ${final} ...`);
    const started = Date.now();
    const tool = B.runTool('mongodump', [`--db=${args.db}`, '--gzip', `--archive=${partial}`], B.uriWithoutDbPath(uri));
    const removeHandlers = B.onStopSignals(() => {
        // SIGKILL: SIGTERM can take seconds while it waits on the server, and we exit now
        if (tool.child && tool.child.exitCode === null) tool.child.kill('SIGKILL');
        fs.rmSync(partial, { force: true });
    });
    const result = await tool.done;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (result.code !== 0) {
        fs.rmSync(partial, { force: true });
        console.error(`mongodump failed (exit ${result.code}${result.signal ? `, ${result.signal}` : ''}) after ${seconds} s:`);
        console.error(B.redact(result.stderr.split('\n').filter(Boolean).slice(-15).join('\n')));
        process.exit(1);
    }
    const counts = B.parseDumpSummary(result.stderr);
    if (!counts.length) {
        fs.rmSync(partial, { force: true });
        console.error(`mongodump dumped no collections of database ${args.db}: wrong URI or database? Nothing kept.`);
        process.exit(1);
    }
    // A dump taken after the accounts were lost (or of the wrong database)
    // must not look like a good backup, nor push a good one out with --keep
    const users = counts.find((c) => c.ns === `${args.db}.users`);
    if (!(users && users.count > 0) && !args.allowNoUsers) {
        fs.rmSync(partial, { force: true });
        console.error(`${args.db}.users is ${users ? 'empty' : 'missing'}: wrong database, or the accounts are gone. ` +
            'Nothing kept. If that is really the state to save, run again with --allow-no-users (it cannot be combined with --keep).');
        process.exit(1);
    }

    try {
        await checkGzip(partial);
    } catch (e) {
        fs.rmSync(partial, { force: true });
        console.error(`The archive does not read back as gzip (${e.message}); nothing kept.`);
        process.exit(1);
    }
    // link, not rename: fails instead of replacing an archive that appeared meanwhile
    try {
        fs.linkSync(partial, final);
    } catch (e) {
        fs.rmSync(partial, { force: true });
        console.error(`Could not save ${final} (${e.code || e.message}); nothing kept.`);
        process.exit(1);
    }
    fs.rmSync(partial, { force: true });
    removeHandlers();
    fs.chmodSync(final, 0o600);
    const size = fs.statSync(final).size;
    const digest = await sha256File(final);

    console.log(`\nCollections (documents):`);
    const width = Math.max(...counts.map((c) => c.ns.length));
    for (const c of counts) console.log(`  ${c.ns.padEnd(width)}  ${c.count}`);
    console.log(`\nArchive: ${final}`);
    console.log(`Size:    ${B.formatBytes(size)} (${size} bytes)   Time: ${seconds} s`);
    console.log(`SHA-256: ${digest}`);

    if (args.keep) {
        // The archive is saved by now: a pruning error must not read as a failed backup
        try {
            const prune = B.archivesToPrune(fs.readdirSync(out.dir), args.db, args.keep);
            for (const f of prune) fs.unlinkSync(path.join(out.dir, f));
            console.log(prune.length ? `Pruned ${prune.length} older archive(s), kept the newest ${args.keep}.` : `Nothing to prune (keeping ${args.keep}).`);
        } catch (e) {
            console.error(`WARNING: the archive is saved, but pruning old ones failed: ${e.message}`);
            process.exitCode = 3;
        }
    }
    console.log('\nMove or copy it to encrypted storage now (runbook: docs/claude/server-infra.md, Backups and restore).');
}

main().catch((e) => {
    console.error(B.redact(e.message));
    process.exit(1);
});
