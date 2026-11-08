/**
 * Password hashing off the event loop: bcryptjs (unchanged format, $2a$/$2b$
 * cost 10, no migration) in a small worker_threads pool. A cost-10 compare
 * is ~70 ms of CPU; run inline it stalls every game on the server for that
 * long per sign-in (bcryptjs's async API only yields between rounds), so a
 * family opening the app at once froze turns for seconds.
 *
 * - Pool size: BAB_HASH_WORKERS (default 2). Workers spawn lazily, are
 *   unref'd while idle, and a job goes to the least-busy worker.
 * - Back pressure: more than 50 jobs pending rejects with code 'HASH_BUSY'
 *   (authHandlers answers "Server is busy").
 * - A worker that errors or exits is dropped; its in-flight jobs re-run
 *   inline (bcryptjs async on the main thread) and the next call respawns.
 * - Inline mode (no workers at all): when the Worker constructor throws,
 *   and under Jest unless BAB_HASH_POOL=1 (so ordinary suites spawn nothing).
 * - A bcrypt error (malformed hash, bad arguments) rejects, as before.
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const { authLogger } = require('./logger');

const WORKER_FILE = path.join(__dirname, 'passwordHashWorker.js');
const MAX_PENDING = 50;

let workers = [];
let nextId = 1;
let pending = 0;
let constructorFailed = false;
let warnedCrash = false;

function poolSize() {
    return Number(process.env.BAB_HASH_WORKERS) || 2;
}

function inlineMode() {
    if (constructorFailed) return true;
    return Boolean(process.env.JEST_WORKER_ID) && process.env.BAB_HASH_POOL !== '1';
}

function runInline(op, a, b) {
    return op === 'compare' ? bcrypt.compare(a, b) : bcrypt.hash(a, b);
}

function busyError() {
    return Object.assign(new Error('Password hashing queue is full'), { code: 'HASH_BUSY' });
}

function drop(entry, reason) {
    if (entry.dead) return;
    entry.dead = true;
    workers = workers.filter(w => w !== entry);
    if (entry.jobs.size && !warnedCrash) {
        warnedCrash = true;
        authLogger.warn('Password hash worker died; re-running its jobs inline', { reason });
    }
    for (const job of entry.jobs.values()) {
        runInline(job.op, job.a, job.b).then(job.resolve, job.reject).finally(() => { pending--; });
    }
    entry.jobs.clear();
}

function spawn() {
    const { Worker } = require('worker_threads');
    const worker = new Worker(WORKER_FILE);
    const entry = { worker, jobs: new Map(), dead: false };
    worker.unref();
    worker.on('message', ({ id, r, err }) => {
        const job = entry.jobs.get(id);
        if (!job) return;
        entry.jobs.delete(id);
        if (entry.jobs.size === 0) worker.unref();
        pending--;
        if (err !== undefined) job.reject(new Error(err));
        else job.resolve(r);
    });
    worker.on('error', (error) => drop(entry, error.message));
    worker.on('exit', (code) => drop(entry, `exit ${code}`));
    workers.push(entry);
    return entry;
}

/** The least-busy live worker, spawning one while the pool is not full and every worker is busy. */
function pickWorker() {
    let best = null;
    for (const w of workers) {
        if (!best || w.jobs.size < best.jobs.size) best = w;
    }
    if ((!best || best.jobs.size > 0) && workers.length < poolSize()) {
        try {
            return spawn();
        } catch (error) {
            if (!best) {
                constructorFailed = true;
                authLogger.warn('Password hash workers unavailable; hashing inline', { error: error.message });
                return null;
            }
        }
    }
    return best;
}

function run(op, a, b) {
    if (inlineMode()) return runInline(op, a, b);
    if (pending >= MAX_PENDING) return Promise.reject(busyError());
    const entry = pickWorker();
    if (!entry) return runInline(op, a, b);

    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending++;
        entry.jobs.set(id, { op, a, b, resolve, reject });
        entry.worker.ref();
        entry.worker.postMessage({ id, op, a, b });
    });
}

/** bcrypt compare (true/false); rejects on a malformed hash. */
function compare(password, hash) {
    return run('compare', password, hash);
}

/** bcrypt hash at `rounds` (default 10). */
function hash(password, rounds = 10) {
    return run('hash', password, rounds);
}

/** Test helper: stop every worker (in-flight jobs are abandoned) and reset. */
async function _shutdown() {
    const all = workers;
    workers = [];
    for (const w of all) w.dead = true;
    await Promise.all(all.map(w => w.worker.terminate()));
    pending = 0;
    constructorFailed = false;
    warnedCrash = false;
}

/** Test helper: the live workers. */
function _workers() {
    return workers.map(w => ({ worker: w.worker, jobs: w.jobs.size }));
}

module.exports = { compare, hash, _shutdown, _workers, MAX_PENDING };
