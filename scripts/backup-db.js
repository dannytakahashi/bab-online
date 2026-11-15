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
 * handed to mongodump in a private temp file, never on its command line.
 * Prints per-collection counts, never a document. The archive holds every
 * password hash and session token: keep it encrypted, never in a repository.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const B = require('../server/admin/dbBackup');

const USAGE = `Usage:
  MONGO_URI=<uri> node scripts/backup-db.js --out <dir> [--keep N] [--db <name>]

  --out <dir>   folder for the archive (created if missing; never inside a git repository)
  --keep N      after a good backup, delete all but the newest N <db>-*.archive.gz there
  --db <name>   database to dump (default ${B.DEFAULT_DB})`;

function parseArgs(argv) {
    const a = { out: null, keep: null, db: B.DEFAULT_DB };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') a.out = argv[++i];
        else if (k === '--keep') a.keep = argv[++i];
        else if (k === '--db') a.db = argv[++i];
        else if (k === '--help' || k === '-h') a.help = true;
        else throw new Error(`Unknown argument ${k}`);
    }
    if (a.keep !== null) {
        if (!/^\d+$/.test(String(a.keep)) || Number(a.keep) < 1) throw new Error('--keep needs a whole number of 1 or more');
        a.keep = Number(a.keep);
    }
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

function run(tool, args) {
    return new Promise((resolve) => {
        const child = spawn(tool, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stderr }));
        child.on('error', (e) => resolve({ code: -1, stderr: String(e.message) }));
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
    const cfg = B.writeToolConfig(B.uriWithoutDbPath(uri));
    const onSignal = () => { cfg.cleanup(); fs.rmSync(partial, { force: true }); process.exit(130); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    console.log(`Source:  ${B.describeHosts(uri)} (database ${args.db})`);
    console.log(`Tool:    ${version}`);
    console.log(`Dumping to ${final} ...`);
    const started = Date.now();
    let result;
    try {
        result = await run('mongodump', [
            `--config=${cfg.file}`, `--db=${args.db}`, '--gzip', `--archive=${partial}`
        ]);
    } finally {
        cfg.cleanup();
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (result.code !== 0) {
        fs.rmSync(partial, { force: true });
        console.error(`mongodump failed (exit ${result.code}) after ${seconds} s:`);
        console.error(B.redact(result.stderr.split('\n').filter(Boolean).slice(-15).join('\n')));
        process.exit(1);
    }
    const counts = B.parseDumpSummary(result.stderr);
    if (!counts.length) {
        fs.rmSync(partial, { force: true });
        console.error(`mongodump dumped no collections of database ${args.db}: wrong URI or database? Nothing kept.`);
        process.exit(1);
    }

    try {
        await checkGzip(partial);
    } catch (e) {
        fs.rmSync(partial, { force: true });
        console.error(`The archive does not read back as gzip (${e.message}); nothing kept.`);
        process.exit(1);
    }
    fs.renameSync(partial, final);
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
        const prune = B.archivesToPrune(fs.readdirSync(out.dir), args.db, args.keep);
        for (const f of prune) fs.unlinkSync(path.join(out.dir, f));
        console.log(prune.length ? `Pruned ${prune.length} older archive(s), kept the newest ${args.keep}.` : `Nothing to prune (keeping ${args.keep}).`);
    }
    console.log('\nMove or copy it to encrypted storage now (runbook: docs/claude/server-infra.md, Backups and restore).');
}

main().catch((e) => {
    console.error(B.redact(e.message));
    process.exit(1);
});
