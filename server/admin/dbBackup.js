/**
 * Plumbing for the owner-run logical backup (scripts/backup-db.js) and
 * restore (scripts/restore-db.js): URI checks, where archives may go, the
 * mongodump / mongorestore summaries, pruning. Runbook: docs/claude/server-infra.md,
 * Backups and restore. Nothing here prints a URI's credentials or a document.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { safeTimeout } = require('../utils/safeTimer');

// The server's database (DB_NAME, else 'babonline': server/config/dbName.js)
const DEFAULT_DB = require('../config/dbName').dbNameFrom();
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// MongoDB database names: no / \ . " $ space; keep to a safe subset
function isValidDbName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_-]{1,63}$/.test(name);
}

/** Splits a mongodb:// or mongodb+srv:// URI; null when it is neither. */
function parseUri(uri) {
    const m = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/.exec(String(uri || '').trim());
    if (!m) return null;
    const [, scheme, authority, pathPart = '', query = ''] = m;
    const at = authority.lastIndexOf('@');
    const userinfo = at >= 0 ? authority.slice(0, at) : '';
    const hostList = at >= 0 ? authority.slice(at + 1) : authority;
    const hosts = hostList.split(',').filter(Boolean).map((h) => {
        const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
        return (v6 ? v6[1] : h.replace(/:\d+$/, '')).toLowerCase();
    });
    return { scheme, userinfo, hostList, hosts, pathDb: decodeURIComponent(pathPart.replace(/^\//, '')), query };
}

/**
 * True only when every host is this machine. mongodb+srv is never local.
 * An SSH tunnel to another server on a local port still counts as local:
 * the check is on the address, not on what answers it.
 */
function isLocalUri(uri) {
    const p = parseUri(uri);
    if (!p || p.scheme !== 'mongodb' || !p.hosts.length) return false;
    return p.hosts.every((h) => LOCAL_HOSTS.has(h));
}

function hasCredentials(uri) {
    const p = parseUri(uri);
    return !!(p && p.userinfo);
}

/**
 * The URI without its database path, for `--db`: mongodump refuses a path
 * that differs from --db. With credentials the auth database is made
 * explicit, as the driver (so the server) reads the same URI: the path, or
 * admin without one. Otherwise the tools authenticate against the --db
 * database, and Railway's root user (in admin) fails with
 * "Authentication failed" (seen in the 2026-11-15 drill). Without
 * credentials nothing is added: an authSource would make them try to log in.
 */
function uriWithoutDbPath(uri) {
    const p = parseUri(uri);
    if (!p) throw new Error('Not a mongodb:// or mongodb+srv:// URI');
    const auth = p.userinfo ? `${p.userinfo}@` : '';
    let query = p.query;
    if (p.userinfo && !/[?&]authSource=/i.test(query)) {
        query = `${query ? `${query}&` : '?'}authSource=${encodeURIComponent(p.pathDb || 'admin')}`;
    }
    return `${p.scheme}://${auth}${p.hostList}/${query}`;
}

/** Hosts only, for "Target:" lines: never the user, password or options. */
function describeHosts(uri) {
    const p = parseUri(uri);
    if (!p) return '(unparseable URI)';
    return `${p.scheme}://${p.hostList}`;
}

/** Drops credentials from any URI inside tool output before it is shown. */
function redact(text) {
    return String(text).replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/g, '$1***@');
}

/** The tools' `--config` YAML: just the URI (single-quoted, quotes doubled). */
function toolConfig(uri) {
    return `uri: '${String(uri).replace(/'/g, "''")}'\n`;
}

/**
 * Runs a Database Tool with the URI in its `--config` file, written into a
 * pipe: never on the command line (`ps`, shell history) and never in a
 * regular file, so a run killed by a signal leaves no password on disk.
 * - macOS: `--config=/dev/fd/3`, the child's extra stdio. Node makes that a
 *   socket, which macOS's /dev/fd reopens.
 * - Linux: /dev/fd/N on a socket fails (ENXIO), so a named pipe (FIFO) in a
 *   private 0700 temp dir instead; a FIFO holds no data on disk, and the
 *   dir is removed when the tool exits.
 * @returns {{child: ChildProcess, done: Promise<{code: number, signal: ?string, stderr: string}>}}
 */
function runTool(tool, args, uri, spawnFn = spawn, platform = process.platform) {
    let fifoDir = null;
    let configPath = '/dev/fd/3';
    if (platform !== 'darwin') {
        fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bab-tool-'));
        fs.chmodSync(fifoDir, 0o700);
        configPath = path.join(fifoDir, 'config');
        const mk = spawnSync('mkfifo', ['-m', '600', configPath]);
        if (mk.status !== 0) {
            fs.rmSync(fifoDir, { recursive: true, force: true });
            const err = mk.error ? mk.error.message : String(mk.stderr || 'mkfifo failed');
            return { child: null, done: Promise.resolve({ code: -1, signal: null, stderr: err }) };
        }
    }
    const stdio = fifoDir ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', 'pipe'];
    const child = spawnFn(tool, [`--config=${configPath}`, ...args], { stdio });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const cleanup = () => { if (fifoDir) fs.rmSync(fifoDir, { recursive: true, force: true }); };
    const done = new Promise((resolve) => {
        child.on('error', (e) => { cleanup(); resolve({ code: -1, signal: null, stderr: String(e.message) }); });
        child.on('close', (code, signal) => { cleanup(); resolve({ code: code ?? -1, signal, stderr }); });
    });
    if (fifoDir) {
        // Opening a FIFO for writing waits for the reader; the async open
        // runs off the main thread, and fails harmlessly if the tool exits
        // first (cleanup removes the FIFO)
        writeFifoWhenRead(configPath, toolConfig(uri), child);
    } else {
        // EPIPE when the tool exits before reading: its exit code tells why
        child.stdio[3].on('error', () => {});
        child.stdio[3].end(toolConfig(uri));
    }
    return { child, done };
}

/**
 * Writes `text` into the FIFO once the tool opens it for reading. A blocking
 * open would wait forever if the tool exits without reading (and a pending
 * open cannot be cancelled), so it polls a non-blocking open (ENXIO until a
 * reader is there) and gives up when the tool exits. The config is far
 * smaller than a pipe buffer, so one non-blocking write takes it all.
 */
function writeFifoWhenRead(fifoPath, text, child, everyMs = 20) {
    let closed = false;
    child.on('close', () => { closed = true; });
    const attempt = () => {
        if (closed) return;
        let fd;
        try {
            fd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        } catch (e) {
            if (e.code === 'ENXIO') safeTimeout(attempt, everyMs, 'fifoConfigWrite').unref?.();
            return; // ENOENT: cleaned up after the tool exited
        }
        try { fs.writeSync(fd, text); } catch { /* the tool exited mid-read: its exit code tells why */ }
        fs.closeSync(fd);
    };
    attempt();
}

const STOP_SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * Ctrl-C, kill, and closing the terminal window (SIGHUP) all run `stop`
 * before exiting 128+n: it kills the tool (else it runs on, orphaned) and
 * removes partial output. Returns a function that removes the handlers.
 */
function onStopSignals(stop) {
    const handlers = Object.entries(STOP_SIGNALS).map(([sig, n]) => {
        const h = () => {
            try { stop(sig); } finally { process.exit(128 + n); }
        };
        process.once(sig, h);
        return [sig, h];
    });
    return () => { for (const [sig, h] of handlers) process.removeListener(sig, h); };
}

/** Nearest existing ancestor's real path + the rest, so symlinks cannot hide the repo. */
function realResolve(p) {
    let cur = path.resolve(p);
    const rest = [];
    while (!fs.existsSync(cur)) {
        rest.unshift(path.basename(cur));
        const up = path.dirname(cur);
        if (up === cur) break;
        cur = up;
    }
    return path.join(fs.realpathSync(cur), ...rest);
}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The git work tree (a .git dir or worktree file) holding `dir`, or null. */
function enclosingGitTree(dir) {
    let cur = dir;
    for (;;) {
        if (fs.existsSync(path.join(cur, '.git'))) return cur;
        const up = path.dirname(cur);
        if (up === cur) return null;
        cur = up;
    }
}

/**
 * Where an archive may be written: never this repository and never any git
 * work tree (a dump is every player's password hash and session token).
 * @returns {{dir: string} | {error: string}}
 */
function checkOutDir(outDir, repoRoot = REPO_ROOT) {
    if (!outDir) return { error: '--out <dir> is required (a folder outside the repository)' };
    const dir = realResolve(outDir);
    if (isInside(dir, realResolve(repoRoot))) return { error: `Refusing ${dir}: it is inside the repository. Use a folder outside it.` };
    const tree = enclosingGitTree(dir);
    if (tree) return { error: `Refusing ${dir}: it is inside the git work tree ${tree}. Use a folder outside any repository.` };
    return { dir };
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** babonline-20261115T031500Z.archive.gz (UTC; sorts by time as a string). */
function archiveName(db, date = new Date()) {
    const ts = `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
        `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
    return `${db}-${ts}.archive.gz`;
}

function archivePattern(db) {
    return new RegExp(`^${db.replace(/[-]/g, '\\-')}-\\d{8}T\\d{6}Z\\.archive\\.gz$`);
}

/** Archives of `db` beyond the newest `keep`, oldest last; other files are never touched. */
function archivesToPrune(fileNames, db, keep) {
    const re = archivePattern(db);
    return fileNames.filter((f) => re.test(f)).sort().reverse().slice(Math.max(0, keep));
}

/** mongodump's "done dumping `db.coll` (N documents)" lines. */
function parseDumpSummary(stderr) {
    const out = [];
    const re = /done dumping `?([^`\s]+?)`? \((\d+) documents?\)/g;
    let m;
    while ((m = re.exec(stderr))) out.push({ ns: m[1], count: Number(m[2]) });
    return out;
}

/** mongorestore's per-collection lines and its total line. */
function parseRestoreSummary(stderr) {
    const collections = [];
    const re = /finished restoring `?([^`\s]+?)`? \((\d+) documents?, (\d+) failures?\)/g;
    let m;
    while ((m = re.exec(stderr))) collections.push({ ns: m[1], count: Number(m[2]), failures: Number(m[3]) });
    const total = /(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore/.exec(stderr);
    return {
        collections,
        restored: total ? Number(total[1]) : null,
        failed: total ? Number(total[2]) : null
    };
}

/** The tool's version line, or null when it is not on PATH. */
function toolVersion(tool) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || '').split('\n')[0].trim() || tool;
}

const TOOLS_HINT = 'Install the MongoDB Database Tools: brew install mongodb-database-tools ' +
    '(or https://www.mongodb.com/try/download/database-tools)';

/** True when the file starts with the gzip magic bytes. */
function looksGzip(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const b = Buffer.alloc(2);
        return fs.readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x1f && b[1] === 0x8b;
    } finally {
        fs.closeSync(fd);
    }
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

module.exports = {
    DEFAULT_DB,
    REPO_ROOT,
    TOOLS_HINT,
    isValidDbName,
    parseUri,
    isLocalUri,
    hasCredentials,
    uriWithoutDbPath,
    describeHosts,
    redact,
    toolConfig,
    runTool,
    onStopSignals,
    STOP_SIGNALS,
    checkOutDir,
    archiveName,
    archivesToPrune,
    parseDumpSummary,
    parseRestoreSummary,
    toolVersion,
    looksGzip,
    formatBytes
};
